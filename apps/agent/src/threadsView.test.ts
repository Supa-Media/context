/**
 * The live view of a chat's jobs (`jobs.ts` `mintThreadsLink`, `serveThreads`;
 * `answerCards.ts`): a link only the chat is sent, a card where cards go, the
 * link in words anywhere else, a group included.
 *
 * Sabotage record (applied, suite run, named check observed failing, reverted):
 *   `stepOf` keeping a reason with no failure → "keeps that it failed and the tool's short reason" fails.
 *   `serveThreads` not checking the age → "a token it never made, a malformed one and an expired link" fails.
 *   `withViewLine` appending a bubble of its own → "inside the first text" fails.
 *   `threadsPart` ignoring `cardsOn` → "the link in words where cards are off" fails.
 *   `readHub` dropping its path pattern → "only the person's or a group's Tex page" fails.
 *   `viewLink` always minting → "points at the Tex page the gateway named" fails.
 */

import { describe, expect, it } from "vitest";

import { withAnswerCards } from "./answerCards";
import { agentAnswer } from "./clients";
import { MAX_THREADS_LINKS, mintThreadsLink, readHub, serveThreads, startJobs, THREADS_FOR_MS, threadsKey, viewLink, withThreadsLine } from "./jobs";
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

  it("is the link in words, inside the first text, where cards are off, and in a group (the owner, 2026-11-03)", async () => {
    const parts = await withAnswerCards(["On it.", "More."], { texts: ["On it.", "More."], choices: [], offers: ["threads"] }, null, mint);
    expect(parts).toEqual([`On it.\n\nWatch it live at ${link} while I work.`, "More."]);
    const noApp = await withAnswerCards(["On it."], { texts: ["On it."], choices: [], offers: ["threads"] }, { ...CONFIG, onlyWhereApp: true }, mint);
    expect(noApp).toEqual([`On it.\n\nWatch it live at ${link} while I work.`]);
    expect(await withThreadsLine(["On it.", "More."], ["threads"], mint)).toEqual([`On it.\n\nWatch it live at ${link} while I work.`, "More."]);
  });

  it("never ends its text with the link, so Sendblue adds nothing to it", async () => {
    const { tappable } = await import("./linkPreviews");
    const [first] = await withThreadsLine(["On it."], ["threads"], mint);
    expect(tappable(first!)).toBe(first);
  });

  it("never rides in a text that must go exactly as written, and goes alone when there is no other", async () => {
    const ask = "Send this email to Bo? Reply YES to send.";
    expect(await withThreadsLine([ask], ["threads"], mint, [ask])).toEqual([ask, `Watch it live at ${link} while I work.`]);
    expect(await withThreadsLine([], ["threads"], mint)).toEqual([`Watch it live at ${link} while I work.`]);
  });

  it("sends nothing when it wasn't offered, or the link could not be made", async () => {
    expect(await withAnswerCards(["Hi."], { texts: ["Hi."], choices: [], offers: [] }, CONFIG, mint)).toEqual(["Hi."]);
    const broken = async () => Promise.reject(new Error("no"));
    expect(await withAnswerCards(["Hi."], { texts: ["Hi."], choices: [], offers: ["threads"] }, CONFIG, broken)).toEqual(["Hi."]);
    expect(await withThreadsLine(["Hi."], ["threads"], broken)).toEqual(["Hi."]);
    expect(await withThreadsLine(["Hi."], undefined, mint)).toEqual(["Hi."]);
  });
});

describe("the Tex page instead of the view (the owner, 2026-11-03)", () => {
  const minted = `https://context.lc/messages/threads?k=${OBJECT}.${"c".repeat(64)}`;
  const mint = async () => minted;

  it("only the person's or a group's Tex page, exactly as named", () => {
    expect(readHub("https://context.lc/tex/@seyi")).toBe("https://context.lc/tex/@seyi");
    expect(readHub("https://staging.context.lc/tex/group/brave-otter-lamp")).toBe("https://staging.context.lc/tex/group/brave-otter-lamp");
    for (const bad of [
      "http://context.lc/tex/@seyi",
      "https://context.lc/tex/seyi",
      "https://context.lc/tex/@seyi?k=1",
      "https://context.lc/tex/@seyi#x",
      "https://user@context.lc/tex/@seyi",
      "https://context.lc:8443/tex/@seyi",
      "https://context.lc/tex/@seyi/../../login",
      "https://context.lc/tex/group/Brave-Otter",
      "https://context.lc/tex/group/one",
      "https://context.lc/note/@seyi/a.md",
      "javascript:alert(1)",
      7,
      null,
    ]) expect(readHub(bad), String(bad)).toBeNull();
  });

  it("points at the Tex page the gateway named, and mints the chat's own view only without one", async () => {
    expect(await viewLink("https://context.lc/tex/@seyi", mint)!()).toBe("https://context.lc/tex/@seyi");
    expect(await viewLink(undefined, mint)!()).toBe(minted);
    expect(await viewLink("https://evil.example/x", mint)!()).toBe(minted);
    expect(viewLink(undefined, undefined)).toBeUndefined();
  });

  it("is read off the gateway's answer only beside the offer", () => {
    const answer = agentAnswer(200, { answer: "On it.", offers: ["threads"], hub: "https://context.lc/tex/group/brave-otter-lamp" });
    expect(answer).toMatchObject({ kind: "answer", offers: ["threads"], hub: "https://context.lc/tex/group/brave-otter-lamp" });
    expect(agentAnswer(200, { answer: "Hi.", hub: "https://context.lc/tex/@seyi" })).not.toHaveProperty("hub");
    expect(agentAnswer(200, { answer: "On it.", offers: ["threads"], hub: "https://evil.example/tex/@seyi?x" })).not.toHaveProperty("hub");
  });

  it("goes as a card that opens the page where cards go, and in words, kept tappable, anywhere else", async () => {
    const hub = viewLink("https://context.lc/tex/@seyi", mint);
    const parts = await withAnswerCards(["On it."], { texts: ["On it."], choices: [], offers: ["threads"] }, CONFIG, hub);
    expect(parts[1]).toMatchObject({ card: { url: "https://context.lc/tex/@seyi", layout: { caption: "What Tex is working on", subcaption: "Tap to open your Tex page" } } });
    const group = await withThreadsLine(["On it: summary of this chat."], ["threads"], viewLink("https://context.lc/tex/group/brave-otter-lamp", mint));
    expect(group).toEqual(["On it: summary of this chat.\n\nWatch it live at https://context.lc/tex/group/brave-otter-lamp while I work."]);
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
