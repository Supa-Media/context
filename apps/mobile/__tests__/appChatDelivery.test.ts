import { describe, expect, test } from "@jest/globals";
import { readChat, readStopped, retryRequest, rowFrom, stopRequest, waitRequest } from "../features/tex/chat/appChatGateway";

const base = { id: "e1", who: "me", text: "hi", at: 1_000, kind: "text" };

describe("delivery state, run card and live run on the wire", () => {
  test("a person's row keeps its state, and failedAt only when failed", () => {
    expect(rowFrom({ ...base, state: "failed", failedAt: 2_000 })).toMatchObject({ state: "failed", failedAt: 2_000 });
    expect(rowFrom({ ...base, state: "answered", failedAt: 2_000 })?.failedAt).toBeUndefined();
    expect(rowFrom({ ...base, state: "nonsense" })?.state).toBeUndefined();
    expect(rowFrom({ ...base, who: "tex", state: "sent" })?.state).toBeUndefined();
  });

  test("a Tex row keeps its finished run card; bad steps are left out", () => {
    const row = rowFrom({ ...base, who: "tex", run: { secs: 12, steps: [{ k: "think", at: 0, text: "x" }, { k: "zzz", at: 1 }, { k: "tool", at: 900, name: "read_note", ok: true, ms: 80 }] } });
    expect(row?.run).toEqual({ secs: 12, steps: [{ k: "think", at: 0, text: "x" }, { k: "tool", at: 900, name: "read_note", ok: true, ms: 80 }] });
    expect(rowFrom({ ...base, who: "tex", run: { secs: 3, steps: [] } })?.run).toBeUndefined();
  });

  test("a read answers the live run and the digest the next wait holds on", () => {
    const read = readChat(200, { rows: [base], typing: true, digest: "abc", run: { turn: "t1", covers: ["e1"], startedAt: 500, steps: [{ k: "tool", at: 10, name: "search", ok: true }] } });
    expect(read).toMatchObject({ kind: "listed", digest: "abc", run: { turn: "t1", startedAt: 500 } });
    expect(readChat(200, { rows: [], typing: false })).toMatchObject({ kind: "listed", run: null, digest: null });
  });

  test("wait, stop and retry requests", () => {
    expect(waitRequest(null)).toEqual({ op: "wait" });
    expect(waitRequest("abc")).toEqual({ op: "wait", since: "abc" });
    expect(stopRequest()).toEqual({ op: "stop" });
    expect(retryRequest("e1")).toEqual({ op: "retry", msgId: "e1" });
    expect(readStopped(200, { stopped: true })).toBe(true);
    expect(readStopped(200, { stopped: false })).toBe(false);
    expect(readStopped(503, { stopped: true })).toBe(false);
  });
});
