/**
 * THE SUGGESTED OWNER.
 *
 * An owner picker on Premium leads with the owner the note itself names,
 * chosen by Jev from the candidates the picker would offer anyway. What has
 * teeth here is what reaches the model and what can come back:
 *
 *  - only the one note being assigned is sent, read at the caller's clearance;
 *  - a locked note, and a note that said `organize: off`, are never sent;
 *  - the answer can only be one of the candidates, and "none of these" is
 *    no suggestion, never a guess;
 *  - off (not Premium, switched off) means no read and no request at all, and
 *    `searchOwners` says so, so the picker never asks;
 *  - a member who could not write the owner cannot ask.
 *
 * The whole path is real: the action, the S3 store against a memory backend,
 * `withJev` and the Worker transport. Only the sockets are fake.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `mayRead` ignoring `encrypted`                                     2 failed
 *   `readOwnerAnswer` returning a candidate for an unknown key          2 failed
 *   `suggestOwner` authorizing at "member"                              1 failed
 *   `suggestsOwners` ignoring the plan                                  1 failed
 *   the note read at "private" scope for every caller                   1 failed
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { ANY_AGENT, mayRead, ownerOptions, ownerRequest, readOwnerAnswer } from "../functions/lib/owners/suggest";
import { TRANSCRIBE_WORKER_SECRET_ENV_VAR, TRANSCRIBE_WORKER_URL_ENV_VAR } from "../functions/meetings/transcribe";
import { memoryS3 } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  type TestConvex,
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "./fixtures.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const WORKER = "https://inference.example.invalid";
const CANDIDATES = { people: ["Seyi Olujide", "Sayo"], agents: ["Claude"] };

describe("the question, as data", () => {
  test("offers exactly the candidates, any agent, and a way out", () => {
    const request = ownerRequest("# Launch\n\nSayo is running the launch.\n", CANDIDATES);
    const criteria = (request.questions.owner as { criteria: Record<string, string> }).criteria;
    expect(Object.keys(criteria)).toEqual(["person_1", "person_2", "agent_1", "any_agent", "none_of_these"]);
    expect(criteria.person_2).toContain("Sayo");
    expect(criteria.agent_1).toContain("Claude");
  });

  test("an answer is a candidate, any agent, or nothing", () => {
    const answer = (choice: string) => ({ owner: { type: "choice", choice, confidence: 0.4 } });
    expect(readOwnerAnswer(answer("person_2"), CANDIDATES)).toEqual({ value: "Sayo", kind: "person" });
    expect(readOwnerAnswer(answer("agent_1"), CANDIDATES)).toEqual({ value: "Claude", kind: "agent" });
    expect(readOwnerAnswer(answer("any_agent"), CANDIDATES)).toEqual({ value: ANY_AGENT, kind: "any" });
    // Low confidence is not thresholded away: the way out is how Jev says "I don't know".
    expect(readOwnerAnswer(answer("none_of_these"), CANDIDATES)).toBeNull();
    expect(readOwnerAnswer(answer("person_9"), CANDIDATES)).toBeNull();
    expect(readOwnerAnswer(answer("__proto__"), CANDIDATES)).toBeNull();
    expect(readOwnerAnswer({ owner: { type: "noul", noul: 1 } }, CANDIDATES)).toBeNull();
    expect(readOwnerAnswer(null, CANDIDATES)).toBeNull();
    expect(ownerOptions({ people: [], agents: [] }).size).toBe(2);
  });

  test("a locked note, an opted-out note and an empty one are not read", () => {
    expect(mayRead({ text: "# Plan\n\nSayo owns this.\n", encrypted: false })).toBe(true);
    expect(mayRead({ text: "# Plan\n\nSayo owns this.\n", encrypted: true })).toBe(false);
    expect(mayRead({ text: "---\norganize: off\n---\n# Plan\n\nSayo owns this.\n", encrypted: false })).toBe(false);
    expect(mayRead({ text: "---\nstatus: active\n---\n# Hi\n", encrypted: false })).toBe(false);
  });
});

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  editor: Id<"users">;
  member: Id<"users">;
  workspaceId: Id<"workspaces">;
  sent: { state: string; questions: Record<string, unknown> }[];
}

async function fixture(options: { premium?: boolean; choice?: string } = {}): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, "seyi@example.invalid");
  const editor = await createUser(t, "sayo@example.invalid");
  const member = await createUser(t, "john@example.invalid");
  await t.run(async (ctx) => {
    await ctx.db.patch(owner, { name: "Seyi Olujide" });
    await ctx.db.patch(editor, { name: "Sayo" });
    await ctx.db.patch(member, { name: "John Adé" });
  });
  const workspaceId = await createWorkspace(t, owner, "atlas", { kind: "shared" });
  await addMember(t, workspaceId, editor, "editor", owner);
  await addMember(t, workspaceId, member, "member", owner);
  const now = Date.now();
  if (options.premium !== false) {
    await t.run((ctx) =>
      ctx.db.insert("workspacePlans", { workspaceId, managedStorage: false, fastSearch: true, status: "active", createdAt: now, updatedAt: now }),
    );
  }

  const backend = memoryS3(FAKE_STORAGE.bucket);
  // Projects are shared with the team; areas stay private to the owner.
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para").replace("1-projects: private", "1-projects: team"));
  backend.seed("index.md", "# Context\n");
  backend.seed("1-projects/launch/overview.md", "---\nstatus: active\n---\n# Launch\n\nSayo is running the launch this month.\n");
  backend.seed(
    "1-projects/locked/overview.md",
    "---\ncontext_encryption: 1\n---\nCIPHERTEXT-SAYO-OWNS-THIS\n",
  );
  backend.seed("2-areas/pay.md", "# Pay\n\nSayo is reviewing salaries this quarter.\n");
  backend.seed("1-projects/quiet/overview.md", "---\norganize: off\n---\n# Quiet\n\nSayo is running this one too.\n");

  const sent: Fixture["sent"] = [];
  vi.stubEnv(TRANSCRIBE_WORKER_URL_ENV_VAR, WORKER);
  vi.stubEnv(TRANSCRIBE_WORKER_SECRET_ENV_VAR, "test-only-secret");
  vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(WORKER)) {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ answers: { owner: { type: "choice", choice: options.choice ?? "person_1", confidence: 0.7 } } }));
    }
    return backend.fetchImpl(input, init);
  });

  const encryptedSecretAccessKey = await encryptSecret(FAKE_STORAGE.secretAccessKey, requireKeyset(), { workspaceId });
  await t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket: FAKE_STORAGE.bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "connected" as const,
      lastVerifiedAt: now,
      boundBy: owner,
      createdAt: now,
      updatedAt: now,
    }),
  );
  return { t, owner, editor, member, workspaceId, sent };
}

const suggest = (f: Fixture, userId: Id<"users">, path: string, prefer?: string[]) =>
  asUser(f.t, userId).action(api.functions.owners.suggestOwner, {
    workspaceId: f.workspaceId,
    path,
    ...(prefer === undefined ? {} : { prefer }),
  });

describe("suggestOwner", () => {
  test("reads the one note and returns the candidate Jev picked", async () => {
    // The caller's own preferred word leads, so "Sayo" is person_1.
    const f = await fixture({ choice: "person_1" });
    expect(await suggest(f, f.editor, "1-projects/launch/overview.md", ["Sayo"])).toEqual({ value: "Sayo", kind: "person" });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.state).toContain("Sayo is running the launch");
    const criteria = (f.sent[0]!.questions.owner as { criteria: Record<string, string> }).criteria;
    expect(Object.values(criteria).join("\n")).toContain("John Adé");
  });

  test("a locked note never reaches Jev", async () => {
    const f = await fixture();
    expect(await suggest(f, f.editor, "1-projects/locked/overview.md")).toBeNull();
    expect(await suggest(f, f.editor, "1-projects/quiet/overview.md")).toBeNull();
    expect(f.sent).toHaveLength(0);
  });

  test("a note the caller cannot see is not read for them", async () => {
    const f = await fixture();
    expect(await suggest(f, f.editor, "2-areas/pay.md")).toBeNull();
    expect(f.sent).toHaveLength(0);
    // The owner can see it, which is what proves the refusal above is the clearance.
    expect(await suggest(f, f.owner, "2-areas/pay.md")).not.toBeNull();
    expect(f.sent).toHaveLength(1);
  });

  test("none of these is no suggestion", async () => {
    const f = await fixture({ choice: "none_of_these" });
    expect(await suggest(f, f.editor, "1-projects/launch/overview.md")).toBeNull();
    expect(f.sent).toHaveLength(1);
  });

  test("without Premium nothing is read or sent, and the search says not to ask", async () => {
    const f = await fixture({ premium: false });
    expect(await suggest(f, f.editor, "1-projects/launch/overview.md")).toBeNull();
    expect(f.sent).toHaveLength(0);
    const found = await asUser(f.t, f.editor).query(api.functions.owners.searchOwners, { workspaceId: f.workspaceId, query: "" });
    expect(found.suggests).toBe(false);
  });

  test("switched off through Jev smarts, it does not exist", async () => {
    const f = await fixture();
    await f.t.run((ctx) => ctx.db.insert("jevSwitches", { feature: "ownerSuggest", off: true, updatedAt: Date.now() }));
    expect(await suggest(f, f.editor, "1-projects/launch/overview.md")).toBeNull();
    expect(f.sent).toHaveLength(0);
    const found = await asUser(f.t, f.editor).query(api.functions.owners.searchOwners, { workspaceId: f.workspaceId, query: "" });
    expect(found.suggests).toBe(false);
  });

  test("on Premium the search says to ask", async () => {
    const f = await fixture();
    const found = await asUser(f.t, f.editor).query(api.functions.owners.searchOwners, { workspaceId: f.workspaceId, query: "" });
    expect(found.suggests).toBe(true);
  });

  test("a member who cannot write the owner cannot ask", async () => {
    const f = await fixture();
    const error = await captureError(() => suggest(f, f.member, "1-projects/launch/overview.md"));
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
    expect(f.sent).toHaveLength(0);
  });
});
