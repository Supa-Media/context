/**
 * How a job ended reaches the chat's turn as facts, never as a line code wrote (Dev2, 2026-11-25: "Tex's code never
 * writes what Tex says"; docs/decisions/texting-assistant/no-scripted-wording.md).
 */
import { describe, expect, it } from "vitest";
import { jobEndOf, readJobUpdate, type JobEntry } from "./jobs";
import { reportOf } from "./jobTexts";

const entry = { title: "Trip plan" } as JobEntry;

describe("a job's end, as facts", () => {
  it("reports an end with no words of its own", () => {
    const end = { action: "job" as const, status: "failed", why: "every_try_failed" };
    expect(reportOf(entry, { id: "job-abcdefgh", state: "failed", texts: [], end })).toMatchObject({ title: "Trip plan", state: "failed", texts: [], end });
    expect(reportOf(entry, { id: "job-abcdefgh", state: "failed", texts: [] })).toBeNull();
  });

  it("is read strictly from the job's object", () => {
    expect(jobEndOf({ action: "job", status: "paused", resumes_by_itself: true })).toEqual({ action: "job", status: "paused", resumes_by_itself: true });
    expect(jobEndOf({ action: "invite", status: "invited" })).toBeNull();
    expect(jobEndOf({ action: "job", status: "I paused it" })).toBeNull();
    const read = readJobUpdate({ id: "job-abcdefgh", state: "failed", texts: [], end: { action: "job", status: "failed", extra: { nested: 1 } } });
    expect(read?.end).toBeUndefined();
  });
});
