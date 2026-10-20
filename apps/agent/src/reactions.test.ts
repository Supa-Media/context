import { describe, expect, it } from "vitest";
import { accept, drain, react, type InboxDeps } from "./inbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { answers, notedReactions, readTapback, REACTIONS_FOR_MS, REACTIONS_KEY } from "./reactions";

const NOW = 1_800_000_000_000;

const tapback = (eventId: string, how: "Loved" | "Liked" | "Laughed at" | "Questioned", words: string) => ({
  kind: "reaction" as const,
  eventId,
  chatId: "chat_1",
  from: "+15555550100",
  messageId: `m_${eventId}`,
  reaction: { how, words },
});

/** A Linq chat whose gateway answers every turn, keeping each `/agent` body. */
function deps(asks: Record<string, unknown>[], sent: string[]): InboxDeps {
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
    if (path === "/agent") {
      asks.push(body);
      return Response.json({ answer: `answer to ${body.question}` });
    }
    if (path.endsWith("/messages")) {
      sent.push(body.message.parts[0].value);
      return Response.json({ id: "x" });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as InboxDeps["fetch"];
  return {
    fetch: fetcher,
    controlPlaneOrigin: "https://control.example",
    workerSecret: "secret",
    gatewayOrigin: "https://gateway.example",
    linqApiKey: "key",
    now: () => NOW,
  } as InboxDeps;
}

describe("tapbacks", () => {
  it("reads a tapback's name and the words it was on, and drops one taken back", () => {
    expect(readTapback("Liked “Want me to book it?”")).toEqual({ how: "Liked", words: "Want me to book it?" });
    expect(readTapback("Reacted 🎉 to “done”")).toEqual({ how: "Reacted", words: "done" });
    expect(readTapback("Le encantó “x”")).toEqual({ how: "Loved", words: "x" });
    expect(readTapback("Removed a heart from “x”")).toBeNull();
    expect(readTapback("Loved the movie")).toBeNull();
  });

  it("answers a question mark on anything, and a yes or no only on a question", () => {
    expect(answers({ how: "Questioned", words: "Your flight is at 6." })).toBe(true);
    expect(answers({ how: "Liked", words: "Want me to book it?" })).toBe(true);
    expect(answers({ how: "Loved", words: "Your flight is at 6." })).toBe(false);
    expect(answers({ how: "Laughed at", words: "Want me to book it?" })).toBe(false);
  });

  it("a thumbs up on a question is answered, with the question sent apart as somebody else's words", async () => {
    const storage = new MemoryStorage();
    const asks: Record<string, unknown>[] = [];
    expect(await react(storage, tapback("e1", "Liked", "Want me to book it?"), NOW)).toBe("queued");
    await drain(storage, deps(asks, []));
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ question: "👍", quoted: "Want me to book it?", tapback: "Liked" });
  });

  it("a heart on a statement is noted, not answered, and told to the next text's turn once", async () => {
    const storage = new MemoryStorage();
    const asks: Record<string, unknown>[] = [];
    expect(await react(storage, tapback("e1", "Loved", "Dinner is booked for 7."), NOW)).toBe("noted");
    expect(await react(storage, tapback("e1", "Loved", "Dinner is booked for 7."), NOW)).toBe("duplicate");
    expect(await notedReactions(storage, NOW)).toEqual([{ how: "Loved", words: "Dinner is booked for 7." }]);
    expect(await storage.get(REACTIONS_KEY)).toBeDefined();

    await accept(storage, { kind: "message", eventId: "e2", chatId: "chat_1", from: "+15555550100", messageId: "m_e2", text: "thanks" }, NOW);
    await drain(storage, deps(asks, []));
    expect(asks[0]).toMatchObject({ question: "thanks", reacted: [{ how: "Loved", words: "Dinner is booked for 7." }] });
    expect(await storage.get(REACTIONS_KEY)).toBeUndefined();
  });

  it("forgets a noted tapback after a day", async () => {
    const storage = new MemoryStorage();
    await react(storage, tapback("e1", "Laughed at", "ha"), NOW);
    expect(await notedReactions(storage, NOW + REACTIONS_FOR_MS)).toEqual([]);
  });
});
