/**
 * TEX DECIDES WHEN TO ANSWER (`functions/lib/gatewayRoutes/textDecide.ts`, contract section 3), AND A GROUP'S STYLE.
 *
 * Through the real routes, `withJev` and the Worker transport; only the inference Worker's socket is fake.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `agentWorkerRoute` dropped from the decide route (no secret check)       1 failed ("refuses without the secret")
 *   `readDecideBody` not requiring `newest` in `candidates`                  1 failed ("refuses a malformed body")
 *   `STALE_AT` lowered to 0.5                                                1 failed ("stale only at 0.85")
 *   covers returning only [start, newest], not the range                    1 failed ("a split request: start ... full range")
 *   covers kept on silent (not [])                                           1 failed ("not answering: covers nothing")
 *   the switch refusal mapped to "unavailable"                               1 failed ("off and capped")
 *   `setGroupEngagement` creating a row for an unknown chat                  1 failed ("engagement set and get")
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { TRANSCRIBE_WORKER_SECRET_ENV_VAR, TRANSCRIBE_WORKER_URL_ENV_VAR } from "../functions/meetings/transcribe";
import { utcDay } from "../functions/lib/jev/meter";
import { OTHER_ASSISTANT_RULE, decideRequest } from "../functions/lib/gatewayRoutes/textDecide";
import { groupKeyOf } from "../functions/textGroups";
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

function body(extra: Record<string, unknown> = {}) {
  return {
    chat: GROUP,
    line: LINE,
    style: "followAlong",
    transcript: `[12:16 PM] Ada: Tex ${SECRET_WORDS}\n[12:17 PM] Bo: and the date?`,
    candidates: [id(1), id(2), NEWEST],
    running: false,
    waitingAsks: [],
    newest: NEWEST,
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

const ANSWER = {
  act: { type: "choice", choice: "answer", confidence: 0.83, probabilities: { silent: 0.1, react: 0.07, answer: 0.83 } },
  start: { type: "choice", choice: id(2), confidence: 0.6, probabilities: { [id(1)]: 0.3, [id(2)]: 0.6, [NEWEST]: 0.1 } },
  moved_on: { type: "noul", noul: 0.2 },
};

async function decide(t: T, extra: Record<string, unknown> = {}) {
  const response = await agentPost(t, "/agent-texts/decide", body(extra));
  return { status: response.status, text: response.text, json: JSON.parse(response.text) as Record<string, unknown> };
}

describe("the door", () => {
  test("refuses without the agent worker's own secret, with the existing refusal bytes", async () => {
    const t = setupTest();
    const reference = await agentPost(t, "/agent-texts/session", { phone: ADA }, null);
    for (const path of ["/agent-texts/decide", "/agent-texts/group/engagement"]) {
      for (const secret of [null, "wrong", TEST_GATEWAY_SECRET]) {
        const refused = await agentPost(t, path, body(), secret);
        expect(refused.status).toBe(401);
        expect(refused.text).toBe(reference.text);
      }
    }
  });

  test("refuses a malformed body", async () => {
    const t = setupTest();
    clef(ANSWER);
    const bad = [
      { style: "loud" },
      { style: "direct" }, // a 1:1 decision names its sender
      { transcript: "x".repeat(24_001) },
      { transcript: "" },
      { candidates: Array.from({ length: 33 }, (_, n) => id(n)), newest: id(0) },
      { candidates: ["not-an-id", NEWEST] },
      { candidates: [id(1)] }, // newest not among them
      { waitingAsks: Array.from({ length: 9 }, (_, n) => id(n + 10)) },
      { waitingAsks: ["x"] },
      { running: "yes" },
      { line: undefined },
      { chat: "x".repeat(201) },
    ];
    for (const extra of bad) {
      const response = await decide(t, extra);
      expect(response.status, JSON.stringify(Object.keys(extra))).toBe(400);
      expect(response.json).toEqual({ error: "invalid_request" });
    }
    // At the caps exactly, it is accepted.
    const at = await decide(t, { transcript: "x".repeat(24_000), candidates: Array.from({ length: 32 }, (_, n) => id(n)), newest: id(0) });
    expect(at.status).toBe(200);
  });
});

describe("the decision", () => {
  test("asks typed questions over the transcript and maps the answers", async () => {
    const t = setupTest();
    const { studio } = await boundGroup(t);
    const sent = clef(ANSWER);
    const logs: string[] = [];
    vi.spyOn(console, "info").mockImplementation((line: unknown) => void logs.push(String(line)));
    const response = await decide(t);
    expect(response.json).toEqual({ ok: true, act: "answer", covers: [id(2), NEWEST], stale: [], movedOn: false, confidence: 0.83 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.state).toContain(SECRET_WORDS);
    expect(Object.keys(sent[0]!.questions)).toEqual(["act", "also_react", "wait_seconds", "start", "moved_on", "emoji"]);
    expect(Object.keys(sent[0]!.questions.start!.criteria)).toEqual([id(1), id(2), NEWEST]);
    // Never the transcript in the answer or the log.
    expect(response.text).not.toContain("pineapple");
    expect(logs.join("\n")).not.toContain("pineapple");
    // Metered under the feature, against the group's workspace.
    const rows = await t.run((ctx) => ctx.db.query("jevUsage").collect());
    expect(rows.map((row) => [row.feature, row.workspaceId, row.calls, row.day])).toEqual([["textDecide", studio, 1, utcDay(Date.now())]]);
  });

  test("not answering: covers nothing", async () => {
    const t = setupTest();
    await boundGroup(t);
    clef({ ...ANSWER, act: { type: "choice", choice: "silent", confidence: 0.9 } });
    expect((await decide(t)).json).toMatchObject({ ok: true, act: "silent", covers: [], confidence: 0.9 });
  });

  test("a split request: start at an earlier id gives the full range through newest, in id order", async () => {
    const t = setupTest();
    await boundGroup(t);
    clef({ ...ANSWER, start: { type: "choice", choice: id(1), confidence: 0.7 } });
    // Sent out of order, answered in id order.
    expect((await decide(t, { candidates: [NEWEST, id(2), id(1)] })).json).toMatchObject({ covers: [id(1), id(2), NEWEST] });
  });

  test("a start that is not a candidate covers just the newest", async () => {
    const t = setupTest();
    await boundGroup(t);
    clef({ ...ANSWER, start: { type: "choice", choice: id(9), confidence: 0.7 } });
    expect((await decide(t)).json).toMatchObject({ covers: [NEWEST] });
  });

  test("mid-turn at its answer, and stale only at 0.85", async () => {
    const t = setupTest();
    await boundGroup(t);
    const asks = [id(20), id(21), id(22)];
    const sent = clef({
      ...ANSWER,
      mid_turn: { type: "choice", choice: "restart", confidence: 0.7 },
      stale_0: { type: "noul", noul: 0.85 },
      stale_1: { type: "noul", noul: 0.84 },
      stale_2: { type: "noul", noul: 0.95 },
      moved_on: { type: "noul", noul: 0.8 },
    });
    const response = await decide(t, { running: true, waitingAsks: asks });
    expect(response.json).toMatchObject({ ok: true, midTurn: "restart", stale: [id(20), id(22)], movedOn: true });
    expect(Object.keys(sent[0]!.questions)).toEqual(["act", "also_react", "wait_seconds", "start", "mid_turn", "stale_0", "stale_1", "stale_2", "moved_on", "emoji"]);
    expect(Object.keys(sent[0]!.questions.mid_turn!.criteria)).toEqual(["fold", "queue", "restart"]);
  });

  test("a 1:1 text is metered against the sender's personal workspace, in direct style", async () => {
    const t = setupTest();
    const ada = await texter(t, "ada", ADA);
    const sent = clef(ANSWER);
    const response = await decide(t, { chat: ADA, line: undefined, sender: ADA, style: "direct" });
    expect(response.json).toMatchObject({ ok: true, act: "answer" });
    expect(JSON.stringify(sent[0]!.questions.act)).toContain("pure acknowledgement");
    const rows = await t.run((ctx) => ctx.db.query("jevUsage").collect());
    expect(rows.map((row) => row.workspaceId)).toEqual([ada.workspaceId]);
  });

  test("off and capped: ok false, and nothing is sent", async () => {
    const t = setupTest();
    const { studio } = await boundGroup(t);
    const sent = clef(ANSWER);
    await t.run((ctx) => ctx.db.insert("jevSwitches", { feature: "textDecide", off: true, updatedAt: Date.now() }));
    expect((await decide(t)).json).toEqual({ ok: false, reason: "off", cause: "switched_off" });
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("jevSwitches").collect()) await ctx.db.delete(row._id);
      // The refusal above already wrote today's row; a day at the cap.
      const [row] = await ctx.db.query("jevUsage").collect();
      expect(row?.workspaceId).toBe(studio);
      await ctx.db.patch(row!._id, { calls: 2000 });
    });
    expect((await decide(t)).json).toEqual({ ok: false, reason: "capped", cause: "daily_cap" });
    expect(sent).toHaveLength(0);
  });

  test("a model that fails, or answers off the set, is unavailable, never a guess", async () => {
    const t = setupTest();
    await boundGroup(t);
    clef(null);
    expect((await decide(t)).json).toEqual({ ok: false, reason: "unavailable", cause: "model_failed" });
    vi.unstubAllGlobals();
    clef({ ...ANSWER, act: { type: "choice", choice: "shout", confidence: 1 } });
    expect((await decide(t)).json).toEqual({ ok: false, reason: "unavailable", cause: "bad_answer" });
  });

  test("a group with no bound workspace, or a stranger's 1:1, is unavailable", async () => {
    const t = setupTest();
    clef(ANSWER);
    expect((await decide(t)).json).toEqual({ ok: false, reason: "unavailable", cause: "no_group" });
    expect((await decide(t, { chat: BO, line: undefined, sender: BO, style: "direct" })).json).toEqual({ ok: false, reason: "unavailable", cause: "no_group" });
  });
});

describe("a group's style", () => {
  test("engagement set and get", async () => {
    const t = setupTest();
    const { ready } = await boundGroup(t);
    expect(ready.engagementChosen).toBe(false);
    expect(ready.engagement).toBeUndefined();
    // A chat Tex has no row for is not given one.
    const unknown = await agentPost(t, "/agent-texts/group/engagement", { line: LINE, groupId: "OTHER-GROUP", style: "quiet", setBy: "@ada" });
    expect(JSON.parse(unknown.text)).toEqual({ ok: false });
    expect(await t.run((ctx) => ctx.db.query("textGroups").collect())).toHaveLength(1);

    const set = await agentPost(t, "/agent-texts/group/engagement", { line: LINE, groupId: GROUP, style: "helpful", setBy: ADA });
    expect(JSON.parse(set.text)).toEqual({ ok: true });
    const [row] = await t.run((ctx) => ctx.db.query("textGroups").collect());
    expect(row!.engagement).toBe("helpful");
    expect(row!.engagementSetBy).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(ADA);
    expect(typeof row!.engagementSetAt).toBe("number");

    const again = JSON.parse((await agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender: BO, participants: [ADA, BO, LINE], mint: true })).text);
    expect(again).toMatchObject({ status: "ready", engagement: "helpful", engagementChosen: true });
  });

  test("the closed set: anything else is refused", async () => {
    const t = setupTest();
    await boundGroup(t);
    for (const style of ["direct", "loud", "", 3, null]) {
      const refused = await agentPost(t, "/agent-texts/group/engagement", { line: LINE, groupId: GROUP, style, setBy: "@ada" });
      expect(refused.status).toBe(400);
    }
    const [row] = await t.run((ctx) => ctx.db.query("textGroups").collect());
    expect(row!.engagement).toBeUndefined();
  });
});

// 2026-10-27: with one message waiting, `start` went out as a choice of one, which the decide Worker
// (infra/transcribe-worker/src/decide.ts) refuses, so every single-message decide failed as model_failed.
test("every choice it asks offers at least two options, whatever the number of messages waiting", () => {
  const base = { chat: GROUP, line: LINE, style: "helpful" as const, transcript: "x", running: true, waitingAsks: [] };
  for (const candidates of [["1761619442000-000001"], ["1761619442000-000001", "1761619443000-000002"]]) {
    const { questions } = decideRequest({ ...base, candidates, newest: candidates.at(-1)! });
    for (const [name, question] of Object.entries(questions as Record<string, { type: string; criteria: object }>)) {
      if (question.type === "choice") expect(Object.keys(question.criteria).length, name).toBeGreaterThanOrEqual(2);
    }
    expect("start" in questions).toBe(candidates.length > 1);
  }
});

// 2026-10-27: "movedOn" and "midTurn" broke the inference Worker's name rule, so it refused every request as
// malformed and decide never once answered. These mirror its request rules (infra/transcribe-worker readQuestion).
test("every request it builds passes the inference Worker's request rules", () => {
  const NAME = /^[a-z][a-z0-9_]{0,39}$/;
  const OPTION = /^[a-z0-9][a-z0-9_-]{0,59}$/;
  const ids = Array.from({ length: 3 }, (_, n) => `1761619442000-00000${n}`);
  for (const running of [false, true]) {
    for (const candidates of [ids.slice(0, 1), ids]) {
      const { state, questions } = decideRequest({ chat: GROUP, line: LINE, style: "helpful", transcript: "x", running, waitingAsks: ids.slice(0, 2), candidates, newest: candidates.at(-1)! });
      expect(state.length).toBeGreaterThan(0);
      const entries = Object.entries(questions as Record<string, { type: string; instructions: string; criteria: Record<string, string> }>);
      expect(entries.length).toBeLessThanOrEqual(16);
      for (const [name, question] of entries) {
        expect(name, name).toMatch(NAME);
        expect(question.instructions.length, name).toBeLessThanOrEqual(1_000);
        if (question.type === "choice") {
          expect(Object.keys(question.criteria).length, name).toBeGreaterThanOrEqual(2);
          for (const option of Object.keys(question.criteria)) expect(option, name).toMatch(OPTION);
        }
      }
    }
  }
});

// Jhonatan, 2026-10-31: a message for another assistant (Instinct is in Tex Devs) is not Tex's.
test("every style tells decide a message for another assistant is silent, never a react", () => {
  for (const style of ["quiet", "attentive", "followAlong", "helpful", "direct"] as const) {
    const { questions } = decideRequest({ chat: GROUP, line: LINE, style, transcript: "x", running: false, waitingAsks: [], candidates: ["1761619442000-000001"], newest: "1761619442000-000001" });
    const act = (questions as Record<string, { instructions: string }>).act!;
    expect(act.instructions).toContain(OTHER_ASSISTANT_RULE);
    expect(act.instructions.length).toBeLessThanOrEqual(1_000);
  }
});

// 2026-11-01: in a chat that reaches no shared workspace (home-only, like Tex Devs), every decide was refused as no_group,
// so untagged texts and reactions were never judged. Such a chat is metered to its sponsor, as its turns are.
test("a chat that reaches no shared workspace decides on its sponsor's meter", async () => {
  const t = setupTest();
  const ada = await texter(t, "ada", ADA);
  const groupKey = await groupKeyOf(LINE, GROUP);
  await t.run((ctx) => ctx.db.insert("textGroups", { groupKey, sponsorId: ada.userId, lastSeenAt: Date.now() } as never));
  clef(ANSWER);
  expect((await decide(t)).json).toMatchObject({ ok: true });
  vi.unstubAllGlobals();
  await t.run(async (ctx) => {
    const row = await ctx.db.query("textGroups").withIndex("by_key", (q) => q.eq("groupKey", groupKey)).unique();
    await ctx.db.patch(row!._id, { sponsorId: undefined });
  });
  clef(ANSWER);
  expect((await decide(t)).json).toMatchObject({ ok: false, cause: "no_group" });
});
