/**
 * Agent Mail asks again soon after a failed ask that left nothing to show, and tells a failure on the way apart from a
 * workspace whose mail is not gathered (Dev, 2026-11-27: "all the sudden agentmail stopped working?", then "it came
 * back all the sudden"). See `features/console/mailPage/useMailNotes.ts`.
 */
import { describe, expect, test } from "@jest/globals";
import { mailNotesThroughGateway, nextMailState, NOT_SERVED, RETRY_MS, type MailState } from "../features/console/mailPage/useMailNotes";

const READY: MailState = { status: "ready", notes: [], complete: true };
const answer = { notes: [], complete: true };

const gateway = (status: number, body: unknown) =>
  mailNotesThroughGateway({
    url: "https://gateway.example.test/files/mail",
    token: async () => "token",
    fetchImpl: (async () => ({ status, json: async () => body })) as unknown as typeof fetch,
  });

describe("a failed ask", () => {
  test("on the way leaves the page retrying, not saying mail can't be gathered", () => {
    expect(nextMailState({ status: "loading" }, null)).toEqual({ status: "unavailable", retrying: true });
  });

  test("that the gateway refused as not gathered says so, and does not retry", () => {
    expect(nextMailState({ status: "loading" }, NOT_SERVED)).toEqual({ status: "unavailable", retrying: false });
  });

  test("keeps the list already shown", () => {
    expect(nextMailState(READY, null)).toBe(READY);
    expect(nextMailState(READY, NOT_SERVED)).toBe(READY);
  });

  test("an answer replaces whatever was shown", () => {
    expect(nextMailState({ status: "unavailable", retrying: true }, answer)).toEqual({ status: "ready", ...answer });
  });

  test("retries within seconds first, never slower than a minute", () => {
    expect(RETRY_MS[0]).toBeLessThanOrEqual(5_000);
    expect(Math.max(...RETRY_MS)).toBeLessThanOrEqual(60_000);
  });
});

describe("the gateway's answer", () => {
  test("409 not_object is not served", async () => {
    expect(await gateway(409, { error: "not_object" })).toBe(NOT_SERVED);
  });

  test("503 or a body this build cannot read is a failure on the way", async () => {
    expect(await gateway(503, { error: "unavailable" })).toBeNull();
    expect(await gateway(200, { kind: "other" })).toBeNull();
  });

  test("200 is the notes", async () => {
    expect(await gateway(200, { kind: "mailNotes", notes: [], complete: true })).toEqual(answer);
  });
});
