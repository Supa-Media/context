/**
 * A job's answer carries its pictures, a page's cover above all, read
 * strictly (`jobs.ts`, `jobRun.ts`). Since 2026-10-30 nothing of a job's is
 * texted straight to the chat: its words go to the chat's own turn
 * (`jobTexts.ts`, `jobReports.test.ts`), which draws a page's cover itself.
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `outcomeOf` dropping `answer.pictures` → "a finished job's update carries its cover, counted with its texts".
 *  2. `jobPictures` without the size check → "reads an update's pictures strictly: two at most, and under the size a stored update may hold".
 */

import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { acceptJob, runJob, type JobDeps } from "./jobRun";
import { MAX_JOB_PICTURE_CHARS, readJobUpdate, type JobRun, type JobUpdate } from "./jobs";
import { MemoryStorage } from "./memoryStorage.testing";

const NOW = 2_000_000;
const PHONE = "+15555550100";
const LINK = "https://context.lc/note/@dev2/projects/trip/plan.page.md";
const COVER = { name: "page.png", mediaType: "image/png", data: "iVBORw0KGgo=" };

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

  it("reads an update's pictures strictly: two at most, and under the size a stored update may hold", () => {
    const big = { name: "big.png", mediaType: "image/png", data: "A".repeat(MAX_JOB_PICTURE_CHARS) };
    expect(readJobUpdate({ id: "job-cover-1234", state: "done", pictures: [COVER, COVER, COVER] })?.pictures).toEqual([COVER, COVER]);
    expect(readJobUpdate({ id: "job-cover-1234", state: "done", pictures: [COVER, big] })?.pictures).toEqual([COVER]);
    expect(readJobUpdate({ id: "job-cover-1234", state: "done", pictures: [{ name: "x", mediaType: "text/html", data: "PGgxPg==" }, "junk"] })).not.toHaveProperty("pictures");
    expect(readJobUpdate({ id: "job-cover-1234", state: "done", pictures: [{ url: "http://plain.example/x.png" }] })).not.toHaveProperty("pictures");
  });
});
