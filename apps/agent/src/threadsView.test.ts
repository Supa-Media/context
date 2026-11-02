/**
 * The live view of a chat's jobs (`jobs.ts` `mintThreadsLink`, `serveThreads`;
 * `answerCards.ts`): a link only the chat is sent, a card where cards go, the
 * link in words anywhere else, a group included.
 *
 * Sabotage record (applied, suite run, named check observed failing, reverted):
 *   `stepOf` keeping a reason with no failure → "keeps that it failed and the tool's short reason" fails.
 *   `serveThreads` not checking the age → "a token it never made, a malformed one and an expired link" fails.
 *   `threadsPart` ignoring `cardsOn` → "the link in words where cards are off" fails.
 */

import { describe, expect, it } from "vitest";

import { withAnswerCards } from "./answerCards";
import { MAX_THREADS_LINKS, mintThreadsLink, serveThreads, startJobs, THREADS_FOR_MS, threadsKey, threadsLines } from "./jobs";
import { MemoryStorage } from "./memoryStorage.testing";

const OBJECT = "a".repeat(64);
const NOW = 1_000_000;
const CONFIG = { extensionBundleId: "lc.context.mobile.messages", teamId: "T".repeat(10) };

async function withJob(storage: MemoryStorage): Promise<void> {
  await startJobs(storage, [{ title: "Research <venues>", brief: "secret brief" }], {
    now: NOW,
    inbox: "+15555550100",
    origin: { kind: "phone", phone: "+15555550100", question: "q" },
    place: { chatId: "chat_1" },
    spawn: async () => {},
  });
}

const tokenOf = (link: string) => threadsKey(new URL(link).searchParams.get("k"))!.token;

describe("a chat's live view link", () => {
  it("is a context.lc link carrying this object and a fresh 256-bit token", async () => {
    const storage = new MemoryStorage();
    const link = await mintThreadsLink(storage, OBJECT, NOW);
    expect(link).toMatch(/^https:\/\/context\.lc\/messages\/threads\?k=a{64}\.[0-9a-f]{64}$/);
    expect(tokenOf(await mintThreadsLink(storage, OBJECT, NOW))).not.toBe(tokenOf(link));
    await expect(mintThreadsLink(storage, "not-an-id", NOW)).rejects.toThrow();
  });

  it("shows the chat's jobs, never the ask, and nothing to anyone without it", async () => {
    const storage = new MemoryStorage();
    await withJob(storage);
    const token = tokenOf(await mintThreadsLink(storage, OBJECT, NOW));
    const served = await serveThreads(storage, token, NOW + 1_000);
    expect(served.status).toBe(200);
    expect(served.headers.get("cache-control")).toBe("private, no-store");
    const body = (await served.json()) as { jobs: { title: string; state: string }[]; max: number };
    expect(body.jobs).toEqual([expect.objectContaining({ title: "Research <venues>", state: "running" })]);
    expect(body.max).toBe(3);
    expect(JSON.stringify(body)).not.toContain("secret brief");
    expect(JSON.stringify(body)).not.toContain("chat_1");
  });

  it("a token it never made, a malformed one and an expired link show nothing, all the same way", async () => {
    const storage = new MemoryStorage();
    await withJob(storage);
    const token = tokenOf(await mintThreadsLink(storage, OBJECT, NOW));
    for (const miss of ["b".repeat(64), "short", `${token}x`, "../" + token]) expect((await serveThreads(storage, miss, NOW)).status).toBe(404);
    expect((await serveThreads(storage, token, NOW + THREADS_FOR_MS + 1)).status).toBe(404);
  });

  it("keeps only the newest few links", async () => {
    const storage = new MemoryStorage();
    const links: string[] = [];
    for (let i = 0; i < MAX_THREADS_LINKS + 2; i++) links.push(await mintThreadsLink(storage, OBJECT, NOW + i));
    expect((await storage.list({ prefix: "threads-link:" })).size).toBe(MAX_THREADS_LINKS);
    expect((await serveThreads(storage, tokenOf(links[0]), NOW + 10)).status).toBe(404);
    expect((await serveThreads(storage, tokenOf(links.at(-1)!), NOW + 10)).status).toBe(200);
  });

  it("reads a view key only in its exact shape", () => {
    expect(threadsKey(`${OBJECT}.${"c".repeat(64)}`)).toEqual({ objectId: OBJECT, token: "c".repeat(64) });
    for (const bad of [null, "", OBJECT, `${OBJECT}.${"c".repeat(64)}.x`, `${OBJECT.toUpperCase()}.${"c".repeat(64)}`]) expect(threadsKey(bad)).toBeNull();
  });
});

describe("offering the view", () => {
  const link = `https://context.lc/messages/threads?k=${OBJECT}.${"c".repeat(64)}`;
  const mint = async () => link;

  it("is a Context card that opens the view, where cards go", async () => {
    const parts = await withAnswerCards(["On it."], { texts: ["On it."], choices: [], offers: ["threads"] }, CONFIG, mint);
    expect(parts).toHaveLength(2);
    expect(parts[1]).toMatchObject({ card: { url: `https://context.lc/tex/threads?k=${OBJECT}.${"c".repeat(64)}`, layout: { caption: "What Tex is working on" } } });
  });

  it("is the link in words where cards are off, and in a group", async () => {
    const parts = await withAnswerCards(["On it."], { texts: ["On it."], choices: [], offers: ["threads"] }, null, mint);
    expect(parts).toEqual(["On it.", expect.stringContaining(link)]);
    const noApp = await withAnswerCards(["On it."], { texts: ["On it."], choices: [], offers: ["threads"] }, { ...CONFIG, onlyWhereApp: true }, mint);
    expect(noApp).toEqual(["On it.", expect.stringContaining(link)]);
    expect(await threadsLines(["threads"], mint)).toEqual([expect.stringContaining(link)]);
  });

  it("sends nothing when it wasn't offered, or the link could not be made", async () => {
    expect(await withAnswerCards(["Hi."], { texts: ["Hi."], choices: [], offers: [] }, CONFIG, mint)).toEqual(["Hi."]);
    const broken = async () => Promise.reject(new Error("no"));
    expect(await withAnswerCards(["Hi."], { texts: ["Hi."], choices: [], offers: ["threads"] }, CONFIG, broken)).toEqual(["Hi."]);
    expect(await threadsLines(["threads"], broken)).toEqual([]);
    expect(await threadsLines(undefined, mint)).toEqual([]);
  });
});

describe("a failed step on the live view", () => {
  it("keeps that it failed and the tool's short reason, and a step that worked carries neither", async () => {
    const { noteJobUpdate, readJobUpdate, chatJobs } = await import("./jobs");
    const storage = new MemoryStorage();
    await withJob(storage);
    const [job] = await chatJobs(storage, NOW);
    const failed = readJobUpdate({ id: job!.id, state: "running", step: "browse: maritime.sh (failed)", stepFailed: true, stepWhy: "  goto step:   out of time; run it again " });
    expect(failed).toMatchObject({ stepFailed: true, stepWhy: expect.any(String) });
    await noteJobUpdate(storage, failed!, NOW + 1);
    // A reason with no failure is dropped: only a failed step says why.
    await noteJobUpdate(storage, readJobUpdate({ id: job!.id, state: "running", step: "browse: maritime.sh/pricing", stepWhy: "made up" })!, NOW + 2);
    expect(readJobUpdate({ id: job!.id, state: "running", step: "s", stepWhy: "made up" })).not.toHaveProperty("stepWhy");
    // And kept that way when an update skips the reader.
    await noteJobUpdate(storage, { id: job!.id, state: "running", step: "read: x", stepWhy: "made up" }, NOW + 2);
    const [after] = await chatJobs(storage, NOW + 3);
    expect(after!.steps).toEqual([
      { at: NOW + 1, text: "browse: maritime.sh (failed)", failed: true, why: "goto step: out of time; run it again" },
      { at: NOW + 2, text: "browse: maritime.sh/pricing" },
      { at: NOW + 2, text: "read: x" },
    ]);
  });
});
