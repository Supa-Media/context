/**
 * A job's answer texts its pictures, a page's cover above all (owner,
 * 2026-10-27: "Cover picture + link"): the cover goes first, the link after
 * it inside a sentence with no name card of its own, and a retry repeats
 * nothing (`jobs.ts`, `jobRun.ts`, `jobTexts.ts`).
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `outcomeOf` dropping `answer.pictures` → "a finished job's update carries its cover, counted with its texts".
 *  2. `jobUpdate` sending pictures after the texts → "sends the cover, then the link with no name card, and repeats nothing when offered again".
 *  3. `afterPicture` always rewriting the link → "a cover that would not send leaves the link its name card".
 *  4. `jobPictures` without the size check → "reads an update's pictures strictly: two at most, and under the size a stored update may hold".
 *  5. `groupJobUpdate` not passing its texts through `afterPicture` → "posts a group job's cover before its words".
 */

import { describe, expect, it, vi } from "vitest";
import type { Fetch } from "./clients";
import { acceptJob, runJob, type JobDeps } from "./jobRun";
import { chatJobs, MAX_JOB_PICTURE_CHARS, readJobUpdate, startJobs, type JobEntry, type JobRun, type JobUpdate } from "./jobs";
import { jobUpdate, type JobTextDeps } from "./jobTexts";
import { linkAfterCard } from "./noteCards";
import { MemoryStorage } from "./memoryStorage.testing";
import { sendblueChatId } from "./sendblue";

const NOW = 2_000_000;
const LINE = "+15555550199";
const PHONE = "+15555550100";
const GROUP = "11111111-2222-3333-4444-555555555555";
const LINK = "https://context.lc/note/@dev2/projects/trip/plan.page.md";
const COVER = { name: "page.png", mediaType: "image/png", data: "iVBORw0KGgo=" };
const HOSTED = "https://agent.example/media/cover.png";
const chatId = sendblueChatId(LINE, PHONE);

type Call = { path: string; body: Record<string, unknown> };

function sendblue(calls: Call[], mediaStatus = 200): Fetch {
  return (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ path: new URL(url).pathname, body });
    return new Response('{"status":"QUEUED","message_handle":"mh_1"}', { status: body.media_url ? mediaStatus : 200 });
  }) as unknown as Fetch;
}

function lineDeps(calls: Call[], extra: Partial<JobTextDeps> = {}): JobTextDeps & { drawn: ReturnType<typeof vi.fn> } {
  const drawn = vi.fn(async () => COVER);
  return {
    fetch: sendblue(calls),
    linqApiKey: "",
    sendblue: { keyId: "k", secret: "s" },
    controlPlaneOrigin: "",
    workerSecret: "",
    gatewayOrigin: "",
    hostPicture: async () => HOSTED,
    noteCardPicture: drawn,
    now: () => NOW + 1,
    ...extra,
    drawn,
  };
}

async function oneJob(storage: MemoryStorage, place: Parameters<typeof startJobs>[2]["place"]): Promise<string> {
  await startJobs(storage, [{ title: "Trip plan", brief: "b" }], {
    now: NOW,
    inbox: PHONE,
    origin: { kind: "phone", phone: PHONE, question: "q" },
    place,
    spawn: async () => {},
  });
  return (await chatJobs(storage, NOW))[0].id;
}

const said = (calls: Call[]) => calls.map((call) => call.body.media_url ?? call.body.content);

describe("a job's cover picture", () => {
  it("a finished job's update carries its cover, counted with its texts", async () => {
    const storage = new MemoryStorage();
    const reports: JobUpdate[] = [];
    const run: JobRun = {
      id: "job-cover-1234",
      inbox: PHONE,
      title: "Trip plan",
      brief: "Plan it.",
      origin: { kind: "phone", phone: PHONE, question: "plan our trip" },
      attempt: 1,
      tries: 0,
      startedAt: NOW,
    };
    const deps: JobDeps = {
      fetch: (async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t", timeZone: "UTC" });
        if (path === "/agent") return Response.json({ answer: `Planned it.\n\n${LINK}`, pictures: [COVER] });
        throw new Error(`unexpected ${path}`);
      }) as unknown as Fetch,
      controlPlaneOrigin: "https://cp.example",
      workerSecret: "s",
      gatewayOrigin: "https://gw.example",
      now: () => NOW,
      report: async (_inbox, update) => (reports.push(update), true),
    };
    await acceptJob(storage, run, NOW);
    await runJob(storage, deps);
    const done = reports.at(-1)!;
    expect(done).toMatchObject({ state: "done", first: 0, pictures: [COVER] });
    expect(done.texts?.at(-1)).toBe(LINK);
  });

  it("sends the cover, then the link with no name card, and repeats nothing when offered again", async () => {
    const storage = new MemoryStorage();
    const id = await oneJob(storage, { chatId, messageId: "mh_ask" });
    const calls: Call[] = [];
    const deps = lineDeps(calls);
    const update: JobUpdate = { id, state: "done", status: "Planned it.", pictures: [COVER], texts: ["Planned it.", LINK], first: 0 };
    expect(await jobUpdate(storage, deps, update)).toBe(true);
    expect(await jobUpdate(storage, deps, update)).toBe(true);
    const link = linkAfterCard({ url: LINK, slug: "dev2", folder: "projects/trip", caption: "" });
    expect(said(calls)).toEqual([HOSTED, "Planned it.", link]);
    expect(deps.drawn).not.toHaveBeenCalled();
    expect(calls.every((call) => (call.body.reply_to as { message_handle?: string })?.message_handle === "mh_ask")).toBe(true);
    expect((await storage.get<JobEntry>(`job:${id}`))?.sent).toBe(3);
  });

  it("a retry after the cover went still sends the link without a name card", async () => {
    const storage = new MemoryStorage();
    const id = await oneJob(storage, { chatId });
    const calls: Call[] = [];
    const deps = lineDeps(calls);
    // The cover went last time; the texts did not.
    await jobUpdate(storage, deps, { id, state: "running", pictures: [COVER], first: 0 });
    await jobUpdate(storage, deps, { id, state: "done", pictures: [COVER], texts: [LINK], first: 0 });
    expect(said(calls)).toEqual([HOSTED, linkAfterCard({ url: LINK, slug: "", folder: "", caption: "" })]);
    expect(deps.drawn).not.toHaveBeenCalled();
  });

  it("a cover that would not send leaves the link its name card", async () => {
    const storage = new MemoryStorage();
    const id = await oneJob(storage, { chatId });
    const calls: Call[] = [];
    let hosted = 0;
    // Hosting the cover fails; the name card's own picture hosts fine.
    const deps = lineDeps(calls, {
      hostPicture: async () => {
        hosted += 1;
        if (hosted === 1) throw new Error("no origin");
        return HOSTED;
      },
    });
    expect(await jobUpdate(storage, deps, { id, state: "done", pictures: [COVER], texts: [LINK], first: 0 })).toBe(true);
    expect(deps.drawn).toHaveBeenCalledTimes(1);
    expect(said(calls)).toEqual([HOSTED, linkAfterCard({ url: LINK, slug: "", folder: "", caption: "" })]);
    expect((await storage.get<JobEntry>(`job:${id}`))?.sent).toBe(2);
  });

  it("words that are not a bare link go as they are after a cover", async () => {
    const storage = new MemoryStorage();
    const id = await oneJob(storage, { chatId });
    const calls: Call[] = [];
    await jobUpdate(storage, lineDeps(calls), { id, state: "done", pictures: [COVER], texts: [`Here it is: ${LINK}`], first: 0 });
    expect(said(calls)).toEqual([HOSTED, `Here it is: ${LINK}`]);
  });

  it("reads an update's pictures strictly: two at most, and under the size a stored update may hold", () => {
    const big = { name: "big.png", mediaType: "image/png", data: "A".repeat(MAX_JOB_PICTURE_CHARS) };
    expect(readJobUpdate({ id: "job-cover-1234", state: "done", pictures: [COVER, COVER, COVER] })?.pictures).toEqual([COVER, COVER]);
    expect(readJobUpdate({ id: "job-cover-1234", state: "done", pictures: [COVER, big] })?.pictures).toEqual([COVER]);
    expect(readJobUpdate({ id: "job-cover-1234", state: "done", pictures: [{ name: "x", mediaType: "text/html", data: "PGgxPg==" }, "junk"] })).not.toHaveProperty("pictures");
    expect(readJobUpdate({ id: "job-cover-1234", state: "done", pictures: [{ url: "http://plain.example/x.png" }] })).not.toHaveProperty("pictures");
  });

  it("posts a group job's cover before its words", async () => {
    const storage = new MemoryStorage();
    await startJobs(storage, [{ title: "Trip plan", brief: "b" }], {
      now: NOW,
      inbox: `sendblue-group:${GROUP}`,
      origin: { kind: "phone", phone: PHONE, question: "q" },
      place: { line: LINE, groupId: GROUP, messageId: "h_ask" },
      spawn: async () => {},
    });
    const [{ id }] = await chatJobs(storage, NOW);
    const calls: Call[] = [];
    const deps = lineDeps(calls);
    const update: JobUpdate = { id, state: "done", pictures: [COVER], texts: [LINK], first: 0 };
    expect(await jobUpdate(storage, deps, update)).toBe(true);
    expect(await jobUpdate(storage, deps, update)).toBe(true);
    expect(calls.map((call) => call.path)).toEqual(["/api/send-group-message", "/api/send-group-message"]);
    expect(said(calls)).toEqual([HOSTED, linkAfterCard({ url: LINK, slug: "", folder: "", caption: "" })]);
    expect(deps.drawn).not.toHaveBeenCalled();
  });
});
