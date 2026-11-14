/**
 * Sabotage record (run by hand, reverted after each):
 * 1. checkLineCall: the allow-list check replaced by `if (false)`, so every method passes. Result: the
 *    "rejects methods outside the line's list" test fails for "toString", "constructor" and "flush".
 * 2. failure(): the ServiceError status forced to null. Result: the "429 keeps its status" and "400 keeps its status"
 *    tests fail, and the refusal check on the 400 returns false.
 */
import { describe, expect, it } from "vitest";
import { checkGroupLineCall, checkLineCall, GROUP_LINE_METHODS, LINE_METHODS, runGroupLineCall, runLineCall } from "./lineCalls";
import { ServiceError } from "./clients";
import { isRefusal } from "./carousel";
import type { LineDeps } from "./line";
import type { GroupLineDeps } from "./groupLine";

const CHAT = "sendblue:+15550100:+15550101";
const WHAPI_CHAT = "whapi:+15550100:+15550101";
const GROUP = "sendblue-group:fake-group-1";
const WHAPI_GROUP = "whapi:120363000000000000@g.us";

/** A fetch that must never be reached: proves a call was refused before any line was touched, or answered in-process. */
const noFetch = (async () => {
  throw new Error("fetch must not run");
}) as unknown as LineDeps["fetch"];

function lineDeps(fetch: LineDeps["fetch"]): LineDeps {
  return { fetch, linqApiKey: "fake-linq-key" };
}

describe("checkLineCall", () => {
  it("accepts every method on the line's list", () => {
    for (const method of LINE_METHODS) {
      expect(checkLineCall({ inbox: "i", chatId: CHAT, method, args: [] }).method).toBe(method);
    }
  });

  it("rejects methods outside the line's list with a TypeError", () => {
    for (const method of ["toString", "constructor", "flush", "__proto__", "readMembers", "react", ""]) {
      expect(() => checkLineCall({ inbox: "i", chatId: CHAT, method, args: [] })).toThrow(TypeError);
    }
  });

  it("rejects a call that is not an object, or names no inbox or chat as text, with a TypeError", () => {
    expect(() => checkLineCall(null)).toThrow(TypeError);
    expect(() => checkLineCall("sendText")).toThrow(TypeError);
    expect(() => checkLineCall({ inbox: 1, chatId: CHAT, method: "startTyping", args: [] })).toThrow(TypeError);
    expect(() => checkLineCall({ inbox: "i", chatId: 15550101, method: "startTyping", args: [] })).toThrow(TypeError);
    expect(() => checkLineCall({ inbox: "i", chatId: undefined, method: "startTyping", args: [] })).toThrow(TypeError);
  });

  it("rejects arguments that are not a list with a TypeError", () => {
    expect(() => checkLineCall({ inbox: "i", chatId: CHAT, method: "sendText", args: "hi" })).toThrow(TypeError);
    expect(() => checkLineCall({ inbox: "i", chatId: CHAT, method: "sendText" })).toThrow(TypeError);
  });
});

describe("checkGroupLineCall", () => {
  it("has no flags method: the flags are read from the group id, not by a call", () => {
    expect(GROUP_LINE_METHODS).not.toContain("flags");
    expect(() => checkGroupLineCall({ inbox: "i", groupId: GROUP, method: "flags", args: [] })).toThrow(TypeError);
  });

  it("rejects a place that names another group, or no place, with a TypeError", () => {
    const other = { line: "+15550100", groupId: "sendblue-group:other" };
    expect(() => checkGroupLineCall({ inbox: "i", groupId: GROUP, method: "react", args: [other, "m1", "like"] })).toThrow(TypeError);
    expect(() => checkGroupLineCall({ inbox: "i", groupId: GROUP, method: "react", args: [] })).toThrow(TypeError);
    expect(() => checkGroupLineCall({ inbox: "i", groupId: GROUP, method: "toString", args: [{ line: "x", groupId: GROUP }] })).toThrow(TypeError);
  });

  it("accepts a place for its own group", () => {
    const place = { line: "+15550100", groupId: GROUP };
    expect(checkGroupLineCall({ inbox: "i", groupId: GROUP, method: "readMembers", args: [place] }).method).toBe("readMembers");
  });
});

describe("runLineCall", () => {
  it("answers a line's value, and a method the line lacks as Absent (not a throw)", async () => {
    // A Sendblue chat with no Sendblue keys answers "not_yet" (`line.ts`); Linq's profile is always "shared".
    const shared = await runLineCall(lineDeps(noFetch), { inbox: "i", chatId: CHAT, method: "shareProfile", args: [] });
    expect(shared).toEqual({ ok: true, value: "not_yet" });
    const linq = await runLineCall(lineDeps(noFetch), { inbox: "i", chatId: "+15550101", method: "shareProfile", args: [] });
    expect(linq).toEqual({ ok: true, value: "shared" });

    const absent = await runLineCall(lineDeps(noFetch), { inbox: "i", chatId: "+15550101", method: "sendCarousel", args: [["https://example.test/a.png"]] });
    expect(absent).toEqual({ ok: false, error: { name: "Absent", message: "this line has no sendCarousel", status: null, service: null } });
  });

  it("keeps a 429 as a service error that is not a refusal", async () => {
    const fetch = (async () => new Response(JSON.stringify({ error: "slow down" }), { status: 429 })) as unknown as LineDeps["fetch"];
    const result = await runLineCall(lineDeps(fetch), { inbox: "i", chatId: "+15550101", method: "sendText", args: ["hi", "key-1"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ name: "ServiceError", status: 429, service: "linq" });
    expect(isRefusal(Object.assign(new Error(result.error.message), { status: result.error.status }))).toBe(false);
  });

  it("keeps a 400 as a service error with its status, which is a refusal", async () => {
    // A picture an uploaded attachment on a WhatsApp chat: only an address goes there, so the line refuses with 400 before fetch.
    const result = await runLineCall(lineDeps(noFetch), { inbox: "i", chatId: WHAPI_CHAT, method: "sendMedia", args: [{ attachment_id: "a1" }, "key-1"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ name: "ServiceError", status: 400, service: "whapi" });
    expect(isRefusal(Object.assign(new Error(result.error.message), { status: result.error.status }))).toBe(true);
  });

  it("answers a thrown non-service error by its name and message, with no status", async () => {
    const deps: LineDeps = { ...lineDeps(noFetch), remote: () => { throw new TypeError("socket went away"); } };
    const result = await runLineCall(deps, { inbox: "i", chatId: CHAT, method: "startTyping", args: [] });
    expect(result).toEqual({ ok: false, error: { name: "TypeError", message: "socket went away", status: null, service: null } });
  });
});

describe("runGroupLineCall", () => {
  it("answers a group's member read and a reaction without keys, never throwing", async () => {
    const deps: GroupLineDeps = { fetch: noFetch };
    const place = { line: "+15550100", groupId: GROUP };
    expect(await runGroupLineCall(deps, { inbox: "i", groupId: GROUP, method: "readOwnMessage", args: [place, "m1"] })).toEqual({ ok: true, value: null });
    expect(await runGroupLineCall(deps, { inbox: "i", groupId: GROUP, method: "react", args: [place, "m1", "like"] })).toEqual({ ok: true, value: undefined });
  });
});
