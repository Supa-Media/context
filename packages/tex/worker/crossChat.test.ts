import { describe, expect, it } from "vitest";
import { MemoryStorage } from "./memoryStorage.testing";
import { CHAT_KEY } from "./inbox";
import { CROSS_TIMEOUT_MS, crossCounts, crossFields, crossTimeouts, crossWired, readCrossAsks, readCrossBack, sendCrossAsks, takeCrossAnswer, takeCrossAsk, answerCrossAsk, type CrossAsk } from "./crossChat";

/**
 * Tex asks Tex across chats, the Worker's half (`crossChat.ts`; Dev2, 2026-11-17, design N3ZawPjhhgYcNfHm7xWa37).
 *
 * Sabotage record (temporary local edits, reverted):
 *   `settle`'s `record.state !== "open"` check removed
 *     → "an answer settles its ask once" fails
 *   `takeCrossAsk`'s CHAT_KEY check removed
 *     → "a person who never texted Tex on their own can't be asked" fails
 */

const KEY = "a".repeat(64);
const ASK: CrossAsk = { id: "xabcdefghij0123", pair: `group:${KEY}`, to: { kind: "group", key: KEY, name: "Tex Devs" }, what: "is the Lab demo still Friday?", do: false };
const ME = "+15555550100";

/** Every chat object, by name, as the Worker's namespace holds them; `/chat-where` is the directory entry. */
function world() {
  const objects = new Map<string, MemoryStorage>();
  const at = (name: string) => objects.get(name) ?? (objects.set(name, new MemoryStorage()), objects.get(name)!);
  let now = 1_000_000;
  const call = async (inbox: string, path: string, body: unknown) => {
    if (path === "/chat-where") return Response.json(inbox === `group-key:${KEY}` ? { line: "+15555550199", groupId: "grp-1" } : null);
    if (path === "/cross-ask") return Response.json({ outcome: await takeCrossAsk(at(inbox), body, now) });
    if (path === "/cross-answer") return Response.json({ outcome: await takeCrossAnswer(at(inbox), body, now) });
    return new Response(null, { status: 404 });
  };
  return { at, call, deps: { now: () => now, call }, tick: (ms: number) => void (now += ms), get now() { return now; } };
}

const queued = async (storage: MemoryStorage) => [...storage.data.entries()].filter(([key]) => key.startsWith("pending:") || key.startsWith("gpending:")).map(([, value]) => (value as { message: Record<string, unknown> }).message);

describe("cross-chat asks", () => {
  it("a 1:1's ask is queued in the group as its asker's tag, and the answer comes back as the 1:1's own run", async () => {
    const w = world();
    const one = w.at(ME);
    await sendCrossAsks(one, w.deps, { kind: "one", chatId: "chat-1", from: ME }, [ASK]);
    const group = w.at("sendblue-group:grp-1");
    const [ask] = await queued(group);
    expect(ask).toMatchObject({ kind: "group-message", groupId: "grp-1", from: ME, text: ASK.what, routine: { runId: `xask:${ASK.id}` } });
    expect(ask.crossChat).toMatchObject({ kind: "ask", id: ASK.id, from: "their own 1:1 chat with you", reply: ME });
    expect(await crossCounts(one, w.now)).toEqual({ hour: 1, day: 1, open: [`group:${KEY}`] });
    await answerCrossAsk(w.deps, ask.crossChat as never, { id: ASK.id, state: "answered", texts: ["Yes, Friday at 3 PM."] });
    const [back] = await queued(one);
    expect(back).toMatchObject({ kind: "message", chatId: "chat-1", from: ME, event: "chat_answer" });
    expect(back.crossChat).toMatchObject({ kind: "answer", id: ASK.id, from: "Tex Devs", state: "answered", texts: ["Yes, Friday at 3 PM."] });
    expect((await crossCounts(one, w.now)).open).toEqual([]);
  });

  it("an answer settles its ask once", async () => {
    const w = world();
    const one = w.at(ME);
    await sendCrossAsks(one, w.deps, { kind: "one", chatId: "chat-1", from: ME }, [ASK]);
    expect(await takeCrossAnswer(one, { id: ASK.id, state: "answered", texts: ["a"] }, w.now)).toBe("queued");
    expect(await takeCrossAnswer(one, { id: ASK.id, state: "answered", texts: ["b"] }, w.now)).toBe("unknown");
    expect((await queued(one)).length).toBe(1);
  });

  it("a group's ask reaches the tagger's 1:1, and a person who never texted Tex on their own can't be asked", async () => {
    const w = world();
    const group = w.at("sendblue-group:grp-1");
    const toMe: CrossAsk = { id: "xbbbbbbbbbb", pair: "person", to: { kind: "person", who: "seyi" }, what: "which hotel did I book?", do: false };
    await sendCrossAsks(group, w.deps, { kind: "group", message: { groupId: "grp-1", line: "+15555550199", from: ME } }, [toMe]);
    // Nobody's 1:1 object knows a chat: refused, and the refusal is the group's own run.
    const [refused] = await queued(group);
    expect(refused.crossChat).toMatchObject({ kind: "answer", state: "refused", from: "@seyi's personal Tex" });
    expect(String((refused.crossChat as { why: string }).why)).toMatch(/never texted Tex on their own/);
    await w.at(ME).put(CHAT_KEY, { chatId: "chat-1", at: 1 });
    const again = { ...toMe, id: "xcccccccccc" };
    await sendCrossAsks(group, w.deps, { kind: "group", message: { groupId: "grp-1", line: "+15555550199", from: ME } }, [again]);
    const [asked] = await queued(w.at(ME));
    expect(asked).toMatchObject({ kind: "message", chatId: "chat-1", event: "chat_ask" });
    expect(asked.crossChat).toMatchObject({ from: "a group chat they're in", reply: "sendblue-group:grp-1" });
    // Dev2, 2026-11-25: a group whose people don't all share a workspace marks its ask, and the 1:1 hears it.
    await sendCrossAsks(group, w.deps, { kind: "group", message: { groupId: "grp-1", line: "+15555550199", from: ME } }, readCrossAsks([{ ...toMe, id: "xdddddddddd", strangers: true }]));
    const marked = (await queued(w.at(ME))).find((entry) => (entry.crossChat as { id?: string }).id === "xdddddddddd");
    expect(marked?.crossChat).toMatchObject({ kind: "ask", strangers: true });
    expect(readCrossAsks([{ ...toMe, strangers: "yes" }])[0].strangers).toBeUndefined();
  });

  it("a group nobody has heard from is refused at once", async () => {
    const w = world();
    const one = w.at(ME);
    await sendCrossAsks(one, w.deps, { kind: "one", chatId: "chat-1", from: ME }, [{ ...ASK, to: { kind: "group", key: "f".repeat(64) }, pair: "group:f" }]);
    const [back] = await queued(one);
    expect(back.crossChat).toMatchObject({ state: "refused" });
  });

  it("an ask unanswered for 10 minutes comes back as timed out", async () => {
    const w = world();
    const one = w.at(ME);
    await sendCrossAsks(one, w.deps, { kind: "one", chatId: "chat-1", from: ME }, [ASK]);
    w.tick(CROSS_TIMEOUT_MS - 1);
    await crossTimeouts(one, w.now);
    expect((await queued(one)).length).toBe(0);
    w.tick(1);
    await crossTimeouts(one, w.now);
    const [back] = await queued(one);
    expect(back.crossChat).toMatchObject({ state: "timeout" });
  });

  it("reads the gateway's fields strictly, and only a config that wires the gate turns asks on", () => {
    expect(readCrossAsks([{ ...ASK, id: "../x" }, { ...ASK, to: { kind: "group", key: "../" } }, ASK])).toEqual([ASK]);
    expect(readCrossBack({ id: ASK.id, state: "timeout", texts: [] })).toBeNull();
    expect(crossWired({ edges: [] })).toBe(false);
    expect(crossWired({ edges: [{ from: "tools", to: "crossChatGate" }] })).toBe(true);
    expect(crossWired()).toBe(true); // main's config wires it (the promote, 2026-11-17)
    expect(crossFields({ kind: "ask", id: ASK.id, from: "x", what: "y", do: false, reply: ME })).toEqual({ event: "chat_ask", crossChat: { kind: "ask", id: ASK.id, from: "x", what: "y", do: false } });
  });
});
