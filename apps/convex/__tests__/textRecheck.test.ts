/**
 * A GROUP ANSWER'S LAST LOOK BEFORE IT SENDS (`functions/lib/gatewayRoutes/textRecheck.ts`, contract section 3b).
 *
 * Through the real routes, `withJev` and the Worker transport; only the inference Worker's socket is fake.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   the recheck route registered without `agentWorkerRoute`                  4 failed ("refuses without the secret" among them)
 *   `readRecheckBody` accepting a `draftFor` at or after `newest`            1 failed ("refuses a malformed body")
 *   the draft put in the question's instructions instead of the state        1 failed ("asks one question…")
 *   `FITS_AT` compared with > on a doubt of exactly 0.5                      1 failed ("held below 0.5…")
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { TRANSCRIBE_WORKER_SECRET_ENV_VAR, TRANSCRIBE_WORKER_URL_ENV_VAR } from "../functions/meetings/transcribe";
import { addMember, asUser, createUser, createWorkspace, setupTest, TEST_GATEWAY_SECRET } from "./fixtures.helpers";

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const WORKER = "https://inference.example.invalid";
const LINE = "+15555550001";
const GROUP = "8F2C3D1A-A5B7-4E9F-8C1D-2A3B4C5D6E7F";
const ADA = "+15555550100";
const BO = "+15555550111";
const SECRET_WORDS = "the launch codes are pineapple";

type T = ReturnType<typeof setupTest>;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function agentPost(t: T, path: string, body: unknown, secret: string | null = AGENT_SECRET) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers.Authorization = `Bearer ${secret}`;
  const response = await t.fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, text: await response.text() };
}

async function texter(t: T, name: string, phone: string) {
  const userId = await createUser(t, `${name}@example.invalid`);
  const workspaceId = await createWorkspace(t, userId, name, { kind: "personal" });
  const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone });
  expect(JSON.parse((await agentPost(t, "/agent-texts/link", { phone, code })).text).status).toBe("linked");
  return { userId, workspaceId };
}

/** Ada and Bo, linked, in one shared workspace the group is bound to by its first tag. */
async function boundGroup(t: T) {
  const ada = await texter(t, "ada", ADA);
  const bo = await texter(t, "bo", BO);
  const studio = await createWorkspace(t, bo.userId, "studio", { kind: "shared" });
  await addMember(t, studio, ada.userId, "editor");
  const ready = JSON.parse((await agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender: ADA, participants: [ADA, BO, LINE], mint: true })).text);
  expect(ready.status).toBe("ready");
  return { ada, bo, studio, ready };
}

const id = (n: number) => `${String(1_700_000_000_000 + n).padStart(13, "0")}-${String(n).padStart(6, "0")}`;
const NEWEST = id(3);

const DRAFT = "Here's the playbook, saved as a page.";

function body(extra: Record<string, unknown> = {}) {
  return {
    chat: GROUP,
    line: LINE,
    style: "followAlong",
    transcript: `[12:16 PM] Ada: Tex save the playbook\n[12:17 PM] Ada: actually ${SECRET_WORDS}, why is the build red?`,
    candidates: [id(1), id(2), NEWEST],
    newest: NEWEST,
    draft: DRAFT,
    draftFor: id(1),
    ...extra,
  };
}

/** The inference Worker answers `answers`, and records what it was sent. */
function clef(answers: Record<string, unknown> | null) {
  const sent: Array<{ state: string; questions: Record<string, { type: string; criteria: Record<string, string> }> }> = [];
  vi.stubEnv(TRANSCRIBE_WORKER_URL_ENV_VAR, WORKER);
  vi.stubEnv(TRANSCRIBE_WORKER_SECRET_ENV_VAR, "test-only-secret");
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(WORKER)) return real(input, init);
    sent.push(JSON.parse(String(init?.body)));
    return answers === null ? new Response("no", { status: 500 }) : new Response(JSON.stringify({ answers }));
  });
  return sent;
}


async function recheck(t: T, extra: Record<string, unknown> = {}) {
  const response = await agentPost(t, "/agent-texts/recheck", body(extra));
  return { status: response.status, text: response.text, json: JSON.parse(response.text) as Record<string, unknown> };
}

describe("the recheck", () => {
  test("refuses without the agent worker's own secret, with the existing refusal bytes", async () => {
    const t = setupTest();
    const reference = await agentPost(t, "/agent-texts/session", { phone: ADA }, null);
    for (const secret of [null, "wrong", TEST_GATEWAY_SECRET]) {
      const refused = await agentPost(t, "/agent-texts/recheck", body(), secret);
      expect(refused.status).toBe(401);
      expect(refused.text).toBe(reference.text);
    }
  });

  test("refuses a malformed body", async () => {
    const t = setupTest();
    clef({ draft_fits: { type: "noul", noul: 0.9 } });
    const bad = [
      { draft: "" },
      { draft: 7 },
      { draftFor: undefined },
      { draftFor: id(9) }, // not a candidate
      { draftFor: NEWEST }, // a draft for the newest message is not a reply to an older one
      { style: "direct", sender: ADA }, // groups only
      { line: undefined },
      { candidates: [id(1)] }, // newest not among them
    ];
    for (const extra of bad) {
      const response = await recheck(t, extra);
      expect(response.status, JSON.stringify(Object.keys(extra))).toBe(400);
    }
  });

  test("asks one question with the draft in the state, and never returns or logs the words", async () => {
    const t = setupTest();
    const { ada } = await boundGroup(t);
    const sent = clef({ draft_fits: { type: "noul", noul: 0.2 } });
    const logs: string[] = [];
    vi.spyOn(console, "info").mockImplementation((line: unknown) => void logs.push(String(line)));
    const response = await recheck(t);
    expect(response.json).toEqual({ ok: true, fits: false, confidence: 0.2 });
    expect(Object.keys(sent[0]!.questions)).toEqual(["draft_fits"]);
    expect(sent[0]!.state).toContain(DRAFT);
    expect(sent[0]!.state).toContain(SECRET_WORDS);
    expect(JSON.stringify(sent[0]!.questions)).not.toContain("playbook");
    expect(response.text).not.toContain("pineapple");
    expect(logs.join("\n")).not.toContain("pineapple");
    expect(logs.join("\n")).not.toContain("playbook");
    // Metered as decide is: to the chat's sponsor (Ada, whose turn minted the grant; Dev2, 2026-11-01).
    const rows = await t.run((ctx) => ctx.db.query("jevUsage").collect());
    expect(rows.map((row) => [row.feature, row.workspaceId, row.calls])).toEqual([["textDecide", ada.workspaceId, 1]]);
  });

  test("held below 0.5, sent at 0.5 and above", async () => {
    const t = setupTest();
    await boundGroup(t);
    clef({ draft_fits: { type: "noul", noul: 0.5 } });
    expect((await recheck(t)).json).toMatchObject({ ok: true, fits: true });
    clef({ draft_fits: { type: "noul", noul: 0.49 } });
    expect((await recheck(t)).json).toMatchObject({ ok: true, fits: false });
  });

  test("no answer, a bad answer or an unknown chat is unavailable, so the Worker sends as before", async () => {
    const t = setupTest();
    clef({ draft_fits: { type: "noul", noul: 0.2 } });
    expect((await recheck(t)).json).toMatchObject({ ok: false, reason: "unavailable", cause: "no_group" });
    await boundGroup(t);
    clef(null);
    expect((await recheck(t)).json).toMatchObject({ ok: false, reason: "unavailable" });
    clef({ draft_fits: { type: "choice", choice: "yes" } });
    expect((await recheck(t)).json).toMatchObject({ ok: false, reason: "unavailable", cause: "bad_answer" });
  });
});
