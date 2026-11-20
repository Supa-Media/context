import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { keptEvents, type TexEvent } from "./events";
import { accept, CHAT_KEY } from "./inbox";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Message } from "./reply";
import { textRoutine } from "./routines";
import { tellNewLine, newNumberText } from "./newLine";
import { recordedTurn, sendRecorded } from "./texSends";
import type { Line } from "./line";

const ANSWER = "Your **plan** for today\n\nsecond paragraph";
const PHONE = "+15555550100";
const TURN = "ck0123456789abcdef";

const msg = (over: Partial<Message> = {}): Message => ({
  kind: "message",
  eventId: "e1",
  chatId: "chat_1",
  from: PHONE,
  messageId: "m1",
  text: "hi",
  ...over,
});

type Sent = { url: string; text: string; key: string };

function linq(sent: Sent[], status: (n: number) => number = () => 200): Fetch {
  let n = 0;
  return (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const code = status(n++);
    if (code < 300) sent.push({ url, text: body.message.parts[0].value, key: body.message.idempotency_key });
    return new Response("{}", { status: code });
  }) as unknown as Fetch;
}

const deps = (sent: Sent[], status?: (n: number) => number) => ({ fetch: linq(sent, status), linqApiKey: "k", now: () => 5_000 });

/** Tex's own texts in the chat's outbox, as the ledger will get them. */
const texOf = async (storage: MemoryStorage) => (await keptEvents(storage, "chat_1")).filter((event: TexEvent) => event.from.kind === "tex");

describe("a text Tex sends on its own is recorded", () => {
  it("a check-in records one Tex text per part, with its source and turn", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg(), 1_000);
    const sent: Sent[] = [];
    const status = await textRoutine(
      storage,
      { text: ANSWER, idempotencyKey: `heartbeat:r1:${PHONE}`, turn: TURN },
      { ...deps(sent), simulator: false },
    );
    expect(status).toBe("texted");
    expect(sent).toHaveLength(2);
    const events = await texOf(storage);
    expect(events.map((event) => [event.text, event.source, event.delivered, event.turn, event.kind])).toEqual([
      ["Your plan for today", "checkin", true, TURN, "text"],
      ["second paragraph", "checkin", true, TURN, "text"],
    ]);
  });

  it("a routine's text records source routine, and no turn when none came", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg(), 1_000);
    const sent: Sent[] = [];
    await textRoutine(storage, { text: "Ran it.", idempotencyKey: `routine:r1:${PHONE}` }, { ...deps(sent), simulator: false });
    const [event] = await texOf(storage);
    expect(event).toMatchObject({ text: "Ran it.", source: "routine", delivered: true });
    expect(event).not.toHaveProperty("turn");
  });

  it("an explicit source the gateway names wins over the key's", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg(), 1_000);
    const sent: Sent[] = [];
    await textRoutine(storage, { text: "Still waiting.", idempotencyKey: `heartbeat:r1:${PHONE}`, source: "ping", turn: TURN }, { ...deps(sent), simulator: false });
    const [event] = await texOf(storage);
    expect(event).toMatchObject({ source: "ping", turn: TURN });
  });

  it("a source that is not one Tex sends on its own is ignored in favour of the key's", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg(), 1_000);
    const sent: Sent[] = [];
    await textRoutine(storage, { text: "x", idempotencyKey: `heartbeat:r1:${PHONE}`, source: "reply" }, { ...deps(sent), simulator: false });
    expect((await texOf(storage))[0]).toMatchObject({ source: "checkin" });
  });

  it("records nothing when no chat is remembered", async () => {
    const storage = new MemoryStorage();
    const sent: Sent[] = [];
    expect(await textRoutine(storage, { text: ANSWER, idempotencyKey: `heartbeat:r1:${PHONE}`, turn: TURN }, { ...deps(sent), simulator: false })).toBe("no_chat");
    expect(sent).toEqual([]);
    expect(await keptEvents(storage, "chat_1")).toEqual([]);
    expect(storage.data.has(CHAT_KEY)).toBe(false);
  });

  it("a part the line refuses is recorded as not delivered, with its turn, and the answer is failed", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg(), 1_000);
    const sent: Sent[] = [];
    const status = await textRoutine(storage, { text: ANSWER, idempotencyKey: `heartbeat:r1:${PHONE}`, turn: TURN }, { ...deps(sent, () => 503), simulator: false });
    expect(status).toBe("failed");
    expect(sent).toEqual([]);
    const events = await texOf(storage);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ text: "Your plan for today", delivered: false, reason: "failed", source: "checkin", turn: TURN });
  });

  it("the new-number text records source new_line, delivered", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg(), 1_000);
    const sent: Sent[] = [];
    const text = newNumberText("+18133350746");
    expect(await tellNewLine(storage, { text, dryRun: false }, { ...deps(sent), now: () => 5_000 })).toBe("told");
    const [event] = await texOf(storage);
    expect(event).toMatchObject({ source: "new_line", delivered: true, text });
    expect(event).not.toHaveProperty("turn");
  });

  it("a send recorded with no turn leaves the turn off the event", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg(), 1_000);
    const line = { sendText: async () => "h1" } as unknown as Line;
    await sendRecorded(storage, line, { chatId: "chat_1", text: "hey", key: "k1" }, { source: "job", now: () => 9 });
    const [event] = await texOf(storage);
    expect(event).toMatchObject({ source: "job", delivered: true });
    expect(event).not.toHaveProperty("turn");
  });
});

describe("recordedTurn", () => {
  it("keeps only an id-shaped turn", () => {
    expect(recordedTurn(TURN)).toBe(TURN);
    expect(recordedTurn("short")).toBeUndefined();
    expect(recordedTurn("has space in it!!")).toBeUndefined();
    expect(recordedTurn("x".repeat(65))).toBeUndefined();
    expect(recordedTurn(undefined)).toBeUndefined();
    expect(recordedTurn(12345678)).toBeUndefined();
  });
});
