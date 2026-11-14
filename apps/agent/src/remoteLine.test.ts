/**
 * Sabotage record (run by hand, reverted after each):
 * 1. unwrapLineCall: the ServiceError branch rebuilt with status null. Result: the 429 and 400 tests both fail
 *    (a 400 then is no refusal, and a 429 loses its status).
 * 2. remoteGroupLine: the flags spread removed. Result: "flags agree with the real line" fails for the WhatsApp group.
 * 3. lineFor: the `deps.remote` branch removed. Result: "lineFor with remote returns the remote line and never fetches" fails.
 */
import { describe, expect, it } from "vitest";
import { isRefusal } from "./carousel";
import { ServiceError } from "./clients";
import { lineFor, type Line, type LineDeps } from "./line";
import { groupLineFlags, groupLineFor, type GroupLine, type GroupLineDeps } from "./groupLine";
import { lineDeps, type InboxDeps, type InboxStorage } from "./inbox";
import { say } from "./groupSay";
import { remoteGroupLine, remoteLine, unwrapLineCall, type GroupLineRpc, type LineRpc } from "./remoteLine";
import type { CallError, GroupLineCall, LineCall, LineCallResult } from "./lineCalls";

const CHAT = "sendblue:+15550100:+15550101";
const LINQ_CHAT = "+15550101";
const WHAPI_GROUP = "whapi:120363000000000000@g.us";
const SENDBLUE_GROUP = "sendblue-group:fake-group-1";
const INBOX = "fake-inbox";

/** Records each call and answers from `answer`. */
function fakeRpc(answer: (call: LineCall) => LineCallResult = () => ({ ok: true, value: undefined })) {
  const calls: LineCall[] = [];
  const rpc: LineRpc = {
    lineCall: async (call) => {
      calls.push(call);
      return answer(call);
    },
  };
  return { rpc, calls };
}

function fakeGroupRpc(answer: (call: GroupLineCall) => LineCallResult = () => ({ ok: true, value: undefined })) {
  const calls: GroupLineCall[] = [];
  const rpc: GroupLineRpc = {
    groupLineCall: async (call) => {
      calls.push(call);
      return answer(call);
    },
  };
  return { rpc, calls };
}

/** What `fn` threw, or undefined when it did not throw. */
function catchOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

const failed = (error:Partial<CallError> & Pick<CallError, "name" | "message">): LineCallResult => ({
  ok: false,
  error: { status: null, service: null, ...error },
});

/** A fetch that must never run: a remote line never reaches the line keys here. */
const noFetch = (async () => {
  throw new Error("fetch must not run");
}) as unknown as LineDeps["fetch"];

describe("remoteLine: calls the Worker", () => {
  it("sends each method as one call with the chat, and drops trailing undefined arguments", async () => {
    const { rpc, calls } = fakeRpc(() => ({ ok: true, value: "handle-1" }));
    const line = remoteLine(rpc, INBOX, CHAT);
    expect(await line.sendText(CHAT, "hello", "key-1")).toBe("handle-1");
    await line.markRead(CHAT);
    expect(calls[0]).toEqual({ inbox: INBOX, chatId: CHAT, method: "sendText", args: ["hello", "key-1"] });
    expect(calls[1]).toEqual({ inbox: INBOX, chatId: CHAT, method: "markRead", args: [] });
  });

  it("returns a value the Worker answered with, and passes uploadPicture's picture through", async () => {
    const { rpc, calls } = fakeRpc(() => ({ ok: true, value: { url: "https://example.test/p.png" } }));
    const picture = { name: "p.png", mediaType: "image/png", data: "AAAA" };
    expect(await remoteLine(rpc, INBOX, LINQ_CHAT).uploadPicture(picture)).toEqual({ url: "https://example.test/p.png" });
    expect(calls[0]).toMatchObject({ method: "uploadPicture", args: [picture] });
  });
});

describe("unwrapLineCall: errors come back the way a local line throws them", () => {
  it("a 429 stays a ServiceError with its status, and is not a refusal", async () => {
    const { rpc } = fakeRpc(() => failed({ name: "ServiceError", message: "sendblue request failed (429)", status: 429, service: "sendblue" }));
    const error = await remoteLine(rpc, INBOX, CHAT).sendText(CHAT, "hi", "k").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({ service: "sendblue", status: 429 });
    expect(isRefusal(error)).toBe(false);
  });

  it("a 400 is a ServiceError that is a refusal", async () => {
    const { rpc } = fakeRpc(() => failed({ name: "ServiceError", message: "whapi request failed (400)", status: 400, service: "whapi" }));
    const error = await remoteLine(rpc, INBOX, "whapi:+15550100:+15550101").sendMedia("x", { url: "https://example.test/a.png" }, "k").catch((e: unknown) => e);
    expect(error).toMatchObject({ service: "whapi", status: 400 });
    expect(isRefusal(error)).toBe(true);
  });

  it("Absent (a method the Worker's line lacks) is a refusal, so callers treat it as a line without carousels", async () => {
    const { rpc } = fakeRpc(() => failed({ name: "Absent", message: "this line has no sendCarousel" }));
    const error = await remoteLine(rpc, INBOX, LINQ_CHAT).sendCarousel!(LINQ_CHAT, ["https://example.test/a.png"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "Absent", status: 400 });
    expect(isRefusal(error)).toBe(true);
  });

  it("any other error keeps its name and message, and its status when it had one", () => {
    const plain = catchOf(() => unwrapLineCall(failed({ name: "TypeError", message: "bad" })));
    expect(plain).toMatchObject({ name: "TypeError", message: "bad" });
    expect(plain).not.toBeInstanceOf(ServiceError);
    expect(catchOf(() => unwrapLineCall(failed({ name: "Error", message: "boom", status: 500 })))).toMatchObject({ message: "boom", status: 500 });
  });

  it("a successful answer comes back as its value", () => {
    expect(unwrapLineCall({ ok: true, value: "shared" })).toBe("shared");
  });
});

describe("remoteGroupLine: flags are synchronous and agree with the real line", () => {
  const realDeps: GroupLineDeps = { fetch: noFetch, whapi: { token: "fake-token", line: "+15550100" }, sendblue: null };

  it.each([
    ["a WhatsApp group", WHAPI_GROUP],
    ["an iMessage group", SENDBLUE_GROUP],
  ])("for %s, the remote line's webhook flags equal the real line's", (_label, groupId) => {
    const real = groupLineFor(realDeps, groupId);
    const remote = remoteGroupLine(fakeGroupRpc().rpc, INBOX, groupId);
    expect(remote.senderOnlyWebhook).toBe(real.senderOnlyWebhook);
    expect(remote.membershipEvents).toBe(real.membershipEvents);
    expect(groupLineFlags(groupId).senderOnlyWebhook).toBe(real.senderOnlyWebhook);
  });

  it("is a WhatsApp group's flags only; an iMessage group has none", () => {
    expect(remoteGroupLine(fakeGroupRpc().rpc, INBOX, WHAPI_GROUP)).toMatchObject({ senderOnlyWebhook: true, membershipEvents: true });
    expect(remoteGroupLine(fakeGroupRpc().rpc, INBOX, SENDBLUE_GROUP).senderOnlyWebhook).toBeUndefined();
  });

  it("sends each method with the place first, and answers the Worker's values", async () => {
    const { rpc, calls } = fakeGroupRpc((call) => (call.method === "readMembers" ? { ok: true, value: ["+15550101"] } : { ok: true, value: undefined }));
    const group = remoteGroupLine(rpc, INBOX, SENDBLUE_GROUP);
    const place = { line: "+15550100", groupId: SENDBLUE_GROUP };
    expect(await group.readMembers(place)).toEqual(["+15550101"]);
    await group.react(place, "m1", "like");
    expect(calls[1]).toEqual({ inbox: INBOX, groupId: SENDBLUE_GROUP, method: "react", args: [place, "m1", "like"] });
  });
});

describe("the seam: a line served from elsewhere is used, and nothing is fetched here", () => {
  it("lineFor with deps.remote returns the remote line and never calls fetch", () => {
    const remote = remoteLine(fakeRpc().rpc, INBOX, LINQ_CHAT);
    const got = lineFor({ fetch: noFetch, linqApiKey: "fake-linq-key", remote: () => remote }, LINQ_CHAT);
    expect(got).toBe(remote);
  });

  it("groupLineFor with deps.remote returns the remote group line and never calls fetch", () => {
    const remote = remoteGroupLine(fakeGroupRpc().rpc, INBOX, SENDBLUE_GROUP);
    const got = groupLineFor({ fetch: noFetch, remote: () => remote }, SENDBLUE_GROUP);
    expect(got).toBe(remote);
  });

  it("the inbox's lineDeps passes its remoteLine on as the line seam", () => {
    const remote = remoteLine(fakeRpc().rpc, INBOX, LINQ_CHAT);
    const inbox = { fetch: noFetch, linqApiKey: "fake-linq-key", controlPlaneOrigin: "https://control.example.test", workerSecret: "fake-secret", remoteLine: () => remote } as unknown as InboxDeps;
    expect(lineFor(lineDeps(inbox), LINQ_CHAT)).toBe(remote);
  });

  it("a group's say sends through its remoteGroupLine and never fetches", async () => {
    const sent: string[] = [];
    const group: GroupLine = {
      ...groupLineFlags(SENDBLUE_GROUP),
      sendText: async (_place, text) => {
        sent.push(text);
        return "handle-1";
      },
      sendMedia: async () => {},
      react: async () => {},
      readMembers: async () => null,
      readOwnMessage: async () => null,
    };
    const values = new Map<string, unknown>();
    const storage: InboxStorage = {
      get: async <T,>(key: string) => values.get(key) as T | undefined,
      put: async (key, value) => {
        values.set(key, value);
      },
      delete: async (key) => values.delete(key),
      list: async <T,>({ prefix }: { prefix: string }) => new Map([...values].filter(([k]) => k.startsWith(prefix)) as [string, T][]),
      setAlarm: async () => {},
    };
    const deps = { fetch: noFetch, now: () => 1_700_000_000_000, remoteGroupLine: () => group } as unknown as Parameters<typeof say>[1];
    await say(storage, deps, { line: "+15550100", groupId: SENDBLUE_GROUP, messageId: "m1", reaction: undefined, answersTapback: undefined }, "hello there");
    expect(sent).toEqual(["hello there"]);
  });
});
