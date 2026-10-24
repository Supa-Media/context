/**
 * Tex's review of a finished conversation (`functions/texReviews.ts`,
 * `lib/gatewayRoutes/texReview.ts`): scores for everybody, words only where
 * everybody in the conversation is staff or said yes.
 *
 * Every value here is obviously fake. This repository is public.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `reviewSetup` answering `full` for everybody. → "a person who is not
 *     staff and never said yes gets scores only, and their words are dropped
 *     unread" fails: the conversation is written.
 *  2. The route trusting the gateway's words without checking the tier again.
 *     → the same test fails.
 *  3. `reviewSetup` reading only the tagger of a group. → "a group chat keeps
 *     words only when everybody in it may share" fails.
 *  4. `setMyTexReviewSharing` leaving the row on a no. → "saying no again
 *     takes the yes away" fails.
 *  5. The scores row keeping the person's id. → "a scores row names nobody"
 *     fails.
 *  6. `onTheTeam` ignoring the pinned workspace's members. → "anybody with a
 *     membership in the pinned workspace is on the team…" and "a group of
 *     pinned-workspace members…" fail.
 *  7. `conversationSpend` reading every grant's turns. → "a review keeps what
 *     it was for, what frustrated them and what its own turns cost" fails:
 *     bob's turn is counted.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PINNED_CONTEXT_SLUG } from "@context/shared";

vi.setConfig({ testTimeout: 30_000 });

import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/api";
import { parseScores, parseWords, renderReviewNote, reviewNotePath } from "../../functions/lib/feedback/texReviewNote";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { LEGACY_PARA_FOLDERS } from "../../functions/lib/scaffold";
import { memoryS3, type MemoryS3 } from "../storeStub.helpers";
import { addMember, asUser, copyTree, createUser, createWorkspace, gatewayPost, seedStorageBinding, type TestConvex } from "../fixtures.helpers";
import { ACCESS_A, bodyOf, twoConnectedTenants } from "./fixtures.helpers";
import { renderPrivacyManifestForFolders } from "../seededRules.helpers";

const PINNED_BUCKET = "pinned-context";
const SCORES = { goal: 4, independence: 3, turns: 5, friendly: 6, calm: 2 };
const WORDS = {
  summary: "Signing in to Claude took three asks",
  expected: "Tex signs in by itself and says so in one line.",
  improve: "Try the sign-in page before asking for anything.",
  transcript: "@alice-handle: Tex open the avocado login\nTex: I can't open that page.",
};

let backend: MemoryS3;

beforeEach(() => {
  vi.stubEnv("ADMIN_EMAILS", "staff@example.invalid");
  backend = memoryS3(PINNED_BUCKET);
  vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => await backend.fetchImpl(input, init));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function world() {
  const tenants = await twoConnectedTenants();
  const { t, alice, bob, grantA } = tenants;
  const staff = await createUser(t, "staff@example.invalid");
  const pinned = await createWorkspace(t, staff, PINNED_CONTEXT_SLUG, { kind: "shared", displayName: "Context" });
  backend.seed(PRIVACY_KEY, renderPrivacyManifestForFolders(LEGACY_PARA_FOLDERS));
  backend.seed("index.md", "# Context\n");
  backend.seed("areas/README.md", "# Areas\n");
  await seedStorageBinding(t, { workspaceId: pinned, boundBy: staff, bucket: PINNED_BUCKET });
  await copyTree(t, pinned);
  await t.run(async (ctx) => {
    // Tex's own clients and grant, as `textLinks.ts` and `textGroups.ts` make them.
    for (const [clientId, clientName] of [["context_texts", "Tex"], ["context_texts_group", "Tex (group chats)"]]) {
      await ctx.db.insert("oauthClients", {
        clientId: clientId!,
        clientName: clientName!,
        redirectUris: [],
        hashedClientSecret: null,
        tokenEndpointAuthMethod: "none",
        grantTypes: [],
        responseTypes: [],
        createdAt: Date.now(),
      });
    }
    await ctx.db.patch(grantA, { clientId: "context_texts" });
    await ctx.db.insert("names", { name: "alice-handle", kind: "user", userId: alice, claimedBy: alice, claimedAt: Date.now() });
    await ctx.db.insert("names", { name: "bob-handle", kind: "user", userId: bob, claimedBy: bob, claimedAt: Date.now() });
  });
  return { ...tenants, staff, pinned };
}

async function review(t: TestConvex, body: Record<string, unknown>) {
  return await bodyOf(await gatewayPost(t, "/gateway/tex-review", { accessToken: ACCESS_A, ...body }));
}

async function notesIn(t: TestConvex, workspaceId: Id<"workspaces">): Promise<string[]> {
  const result = await t.action(internal.functions.files.runFileOperation, { workspaceId, scope: "private", operation: { kind: "notePaths" } });
  return result.kind === "notePaths" ? (result.paths ?? []) : [];
}

async function readNote(t: TestConvex, workspaceId: Id<"workspaces">, path: string): Promise<string> {
  const result = await t.action(internal.functions.files.runFileOperation, { workspaceId, scope: "private", operation: { kind: "read", path } });
  return result.kind === "file" ? result.text : "";
}

const reviews = (paths: string[]) => paths.filter((path) => path.includes("/tex-reviews/") && !path.includes("/scores/"));
const scoreNotes = (paths: string[]) => paths.filter((path) => path.includes("/tex-reviews/scores/"));

/** Make the grant a group chat's, with `others` in it besides its tagger. */
async function asGroup(t: TestConvex, grantId: Id<"oauthGrants">, others: Id<"users">[]) {
  await t.run(async (ctx) => {
    const grant = await ctx.db.get(grantId);
    const groupId = await ctx.db.insert("textGroups", { groupKey: "f".repeat(64), workspaceId: grant!.workspaceId, lastSeenAt: Date.now() });
    await ctx.db.patch(grantId, { clientId: "context_texts_group", texGroup: { groupId, coViewerIds: others, meterWorkspaceId: grant!.workspaceId } });
  });
}

describe("what a review may carry", () => {
  test("staff get the whole review: scores, what they expected, the fix and the conversation", async () => {
    const { t, pinned } = await world();
    vi.stubEnv("ADMIN_EMAILS", "staff@example.invalid alice@example.invalid");
    expect(await review(t, { mode: "tier" })).toEqual({ tier: "full" });
    expect(await review(t, { reason: "fix_this", scores: SCORES, words: WORDS })).toEqual({ review: { filed: "full" } });
    const [path] = reviews(await notesIn(t, pinned));
    expect(path).toMatch(/^areas\/tex-reviews\/\d{4}-\d{2}-\d{2} \d{4} calm 2 [0-9a-f]{6}\.md$/);
    const note = await readNote(t, pinned, path!);
    expect(note).toContain("status: new");
    expect(note).toContain("reason: fix_this");
    expect(note).toContain('people: ["@alice-handle"]');
    expect(note).toContain("Tex open the avocado login");
    expect(note).toContain("Try the sign-in page before asking for anything.");
  });

  test("anybody with a membership in the pinned workspace is on the team, without being staff", async () => {
    const { t, pinned, staff, alice } = await world();
    expect(await review(t, { mode: "tier" })).toEqual({ tier: "scores" });
    await addMember(t, pinned, alice, "member", staff);
    expect(await review(t, { mode: "tier" })).toEqual({ tier: "full" });
    expect(await review(t, { reason: "ended", scores: SCORES, words: WORDS })).toEqual({ review: { filed: "full" } });
    expect(reviews(await notesIn(t, pinned))).toHaveLength(1);
  });

  test("a group of pinned-workspace members keeps words only once every one of them is a member", async () => {
    const { t, pinned, staff, grantA, bob, alice, aliceWs } = await world();
    await addMember(t, aliceWs, bob, "member", alice);
    await asGroup(t, grantA, [bob]);
    await addMember(t, pinned, alice, "editor", staff);
    expect(await review(t, { mode: "tier" })).toEqual({ tier: "scores" });
    await addMember(t, pinned, bob, "member", staff);
    expect(await review(t, { mode: "tier" })).toEqual({ tier: "full" });
  });

  test("a person who is not staff and never said yes gets scores only, and their words are dropped unread", async () => {
    const { t, pinned } = await world();
    expect(await review(t, { mode: "tier" })).toEqual({ tier: "scores" });
    // Sent anyway, as a broken gateway might: never written.
    expect(await review(t, { reason: "ended", scores: SCORES, words: WORDS })).toEqual({ review: { filed: "scores" } });
    const paths = await notesIn(t, pinned);
    expect(reviews(paths)).toEqual([]);
    const [day] = scoreNotes(paths);
    const note = await readNote(t, pinned, day!);
    expect(note).toContain("| 4 | 3 | 5 | 6 | 2 |");
    expect(JSON.stringify(backend.snapshot())).not.toContain("avocado");
    expect(JSON.stringify(backend.snapshot())).not.toContain("alice-handle");
  });

  test("saying yes in Settings shares the words; saying no again takes the yes away", async () => {
    const { t, pinned, alice } = await world();
    expect(await asUser(t, alice).query(api.functions.texReviews.myTexReviewSharing, {})).toBe(false);
    await asUser(t, alice).mutation(api.functions.texReviews.setMyTexReviewSharing, { share: true });
    expect(await asUser(t, alice).query(api.functions.texReviews.myTexReviewSharing, {})).toBe(true);
    expect(await review(t, { reason: "ended", scores: SCORES, words: WORDS })).toEqual({ review: { filed: "full" } });
    expect(reviews(await notesIn(t, pinned))).toHaveLength(1);

    await asUser(t, alice).mutation(api.functions.texReviews.setMyTexReviewSharing, { share: false });
    expect(await asUser(t, alice).query(api.functions.texReviews.myTexReviewSharing, {})).toBe(false);
    expect(await review(t, { mode: "tier" })).toEqual({ tier: "scores" });
  });

  test("a group chat keeps words only when everybody in it may share", async () => {
    const { t, pinned, grantA, bob, alice, aliceWs } = await world();
    vi.stubEnv("ADMIN_EMAILS", "staff@example.invalid alice@example.invalid");
    // A group's grant reads one workspace everybody in the chat is a member of.
    await addMember(t, aliceWs, bob, "member", alice);
    await asGroup(t, grantA, [bob]);
    expect(await review(t, { mode: "tier" })).toEqual({ tier: "scores" });
    expect(await review(t, { reason: "ended", scores: SCORES, words: WORDS })).toEqual({ review: { filed: "scores" } });
    expect(reviews(await notesIn(t, pinned))).toEqual([]);

    vi.stubEnv("ADMIN_EMAILS", "staff@example.invalid alice@example.invalid bob@example.invalid");
    expect(await review(t, { reason: "ended", scores: SCORES, words: WORDS })).toEqual({ review: { filed: "full" } });
    const [path] = reviews(await notesIn(t, pinned));
    const note = await readNote(t, pinned, path!);
    expect(note).toContain("chat: group");
    expect(note).toContain('people: ["@alice-handle","@bob-handle"]');
  });

  test("a staff address that was never verified is not staff", async () => {
    const { t, alice } = await world();
    vi.stubEnv("ADMIN_EMAILS", "staff@example.invalid alice@example.invalid");
    await t.run((ctx) => ctx.db.patch(alice, { emailVerificationTime: undefined }));
    expect(await review(t, { mode: "tier" })).toEqual({ tier: "scores" });
  });

  test("a grant that is not Tex's, or no token, files nothing", async () => {
    const { t, grantA, pinned } = await world();
    await t.run((ctx) => ctx.db.patch(grantA, { clientId: "some_other_client" }));
    expect(await review(t, { reason: "ended", scores: SCORES })).toEqual({ review: null });
    expect(await bodyOf(await gatewayPost(t, "/gateway/tex-review", { reason: "ended", scores: SCORES }))).toEqual({ review: null });
    expect(await notesIn(t, pinned)).not.toContain(expect.stringContaining("tex-reviews"));
  });

  test("scores out of range are refused", async () => {
    const { t } = await world();
    expect(await review(t, { reason: "ended", scores: { ...SCORES, goal: 11 } })).toEqual({ review: null, refused: "invalid" });
    expect(await review(t, { reason: "because", scores: SCORES })).toEqual({ review: null, refused: "invalid" });
  });

  test("a scores row names nobody", async () => {
    const { t } = await world();
    await review(t, { reason: "frustrated", scores: SCORES });
    const rows = await t.run((ctx) => ctx.db.query("texReviewScores").collect());
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(["_creationTime", "_id", "at", "calm", "day", "friendly", "goal", "independence", "kind", "reason", "signals", "turns", "who"]);
  });

  test("a review keeps what it was for, what frustrated them and what its own turns cost", async () => {
    const { t, grantA, grantB } = await world();
    const turn = async (grantId: Id<"oauthGrants">, model: string, costMicroUsd: number, ago: number) =>
      await t.run(async (ctx) => {
        const grant = await ctx.db.get(grantId);
        await ctx.db.insert("agentTurns", {
          workspaceId: grant!.workspaceId,
          grantId,
          client: "texts",
          provider: "anthropic",
          model,
          outcome: "answered",
          at: Date.now() - ago,
          ms: 1_000,
          modelMs: 900,
          toolMs: 100,
          rounds: 1,
          inputTokens: 10,
          outputTokens: 10,
          costMicroUsd,
          trace: [],
        });
      });
    await turn(grantA, "anthropic/claude-haiku-5-5", 900, 60_000);
    await turn(grantA, "anthropic/claude-opus-5-5", 15_000, 120_000);
    // Older than the two texts reviewed, and another person's: neither counts.
    await turn(grantA, "anthropic/claude-haiku-5-5", 1_000_000, 180_000);
    await turn(grantB, "anthropic/claude-haiku-5-5", 2_000_000, 30_000);
    await review(t, { reason: "frustrated", scores: SCORES, task: "web_errand", signals: ["try_again", "angry about avocados", "try_again"], texts: 2 });
    const [row] = await t.run((ctx) => ctx.db.query("texReviewScores").collect());
    expect(row).toMatchObject({ task: "web_errand", signals: ["try_again"], texts: 2, who: "new", costMicroUsd: 15_900, thought: true });
  });

  test("a task outside the codes, or a count out of range, is dropped and the scores still file", async () => {
    const { t } = await world();
    vi.stubEnv("ADMIN_EMAILS", "staff@example.invalid alice@example.invalid");
    expect(await review(t, { reason: "ended", scores: SCORES, task: "her avocado order", texts: 400 })).toEqual({ review: { filed: "scores" } });
    const [row] = await t.run((ctx) => ctx.db.query("texReviewScores").collect());
    expect(row!.task).toBeUndefined();
    expect(row!.texts).toBeUndefined();
    expect(row!.costMicroUsd).toBeUndefined();
    expect(row!.who).toBe("staff");
  });
});

describe("the review note itself", () => {
  test("nothing the conversation says can close its fence or render", () => {
    const words = parseWords({ ...WORDS, transcript: "```\n# heading\n![x](https://example.invalid/a.png)" })!;
    const note = renderReviewNote({ id: "abcdef123", now: Date.UTC(2026, 9, 24, 16, 31), kind: "one", reason: "ended", people: ["alice-handle"], scores: SCORES, words });
    expect(note).toContain("````text\n```\n# heading");
    expect(reviewNotePath("areas/tex-reviews", { now: Date.UTC(2026, 9, 24, 16, 31), scores: SCORES, id: "abcdef123" })).toBe("areas/tex-reviews/2026-10-24 1631 calm 2 abcdef.md");
  });

  test("scores must be whole numbers 1 to 10", () => {
    expect(parseScores(SCORES)).toEqual(SCORES);
    expect(parseScores({ ...SCORES, calm: 0 })).toBeNull();
    expect(parseScores({ ...SCORES, calm: 2.5 })).toBeNull();
    expect(parseScores({ goal: 5 })).toBeNull();
  });
});
