import { describe, expect, it } from "vitest";
import { MemoryStorage } from "./memoryStorage.testing";
import { CHAT_KEY } from "./inbox";
import { readAsides, sendAsides, takeCrossAside } from "./crossChat";

/**
 * A group's sensitive asks go to the tagger's own 1:1 (`crossChat.ts` `sendAsides`; Dev2, 2026-11-25: logins and
 * anything sensitive "should be handled 1:1 side"; gateway `privateAside.js`).
 *
 * Sabotage record (temporary local edits, reverted):
 *   `sendAsides` calling the inbox of anyone but `message.from`
 *     → "only the tagger's own 1:1 is texted" fails
 *   `takeCrossAside`'s CHAT_KEY check removed
 *     → "someone who never texted Tex on their own is told in the group" fails
 */

const ME = "+15555550100";
const OTHER = "+15555550111";
const GROUP = { groupId: "grp-1", line: "+15555550199", from: ME };

function world() {
  const objects = new Map<string, MemoryStorage>();
  const at = (name: string) => objects.get(name) ?? (objects.set(name, new MemoryStorage()), objects.get(name)!);
  const called: string[] = [];
  const call = async (inbox: string, path: string, body: unknown) => {
    called.push(`${inbox}${path}`);
    if (path === "/cross-aside") return Response.json({ outcome: await takeCrossAside(at(inbox), body, 1_000) });
    return new Response(null, { status: 404 });
  };
  return { at, called, deps: { now: () => 1_000, call } };
}

const queued = (storage: MemoryStorage) => [...storage.data.entries()].filter(([key]) => key.startsWith("pending:")).map(([, value]) => (value as { message: Record<string, unknown> }).message);

describe("private asides", () => {
  it("only the tagger's own 1:1 is texted, as a run of its own with the link the gateway wrote", async () => {
    const w = world();
    await w.at(ME).put(CHAT_KEY, { chatId: "chat-me" });
    await w.at(OTHER).put(CHAT_KEY, { chatId: "chat-other" });
    const link = "Link to save the login: https://context.lc/vault/" + "a".repeat(32);
    expect(await sendAsides(w.deps, GROUP, [{ what: "a private link to save instacart.com", texts: [link] }])).toBe("sent");
    expect(w.called).toEqual([`${ME}/cross-aside`]);
    const [run] = queued(w.at(ME));
    expect(run).toMatchObject({ kind: "message", chatId: "chat-me", from: ME, event: "chat_answer" });
    expect(run.crossChat).toMatchObject({ kind: "answer", state: "aside", from: "a group chat they're in", texts: [link] });
    expect((run.crossChat as { key?: string }).key).toMatch(/^[0-9a-f]{64}$/);
    expect(queued(w.at(OTHER))).toEqual([]);
  });

  it("someone who never texted Tex on their own is told in the group", async () => {
    const w = world();
    expect(await sendAsides(w.deps, GROUP, [{ what: "the code Instacart sent", texts: [] }])).toBe("no_1to1");
    expect(queued(w.at(ME))).toEqual([]);
  });

  it("reads asides strictly", async () => {
    expect(readAsides([{ what: "" }, { what: "a", texts: [1, "", " x "] }, { what: "b" }, { what: "c" }])).toEqual([{ what: "a", texts: ["x"] }]);
    expect(readAsides("nope")).toEqual([]);
    expect(await takeCrossAside(new MemoryStorage(), { id: "bad", what: "x", asker: ME, from: "a group" }, 1)).toBe("bad");
    expect(await takeCrossAside(new MemoryStorage(), { id: "xabcdefghij", what: "x", asker: "not-a-phone", from: "a group" }, 1)).toBe("bad");
  });
});
