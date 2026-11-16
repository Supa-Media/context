import { describe, expect, it } from "vitest";
import { TEXTS_QUEUE, withdrawItem } from "./chatQueue";
import { editedText, editStep } from "./editStep";
import { unwritten } from "./events";
import { accept, keepEdit } from "./inbox";
import { MemoryStorage } from "./memoryStorage.testing";
import type { PhotonEdit } from "./photonInbound";
import type { Message } from "./reply";

const CHAT = "photon:+15555550199:+15555550100";
const PHONE = "+15555550100";
const NOW = 1_800_000_000_000;

const text = (over: Partial<Message> = {}): Message => ({ kind: "message", eventId: "photon:m-1", chatId: CHAT, from: PHONE, messageId: "m-1", text: "dinner at 6 tonight?", ...over });
const edit = (over: Partial<PhotonEdit> = {}): PhotonEdit => ({ kind: "edited", eventId: "photon:message.edited:m-1:2", chatId: CHAT, line: "+15555550199", from: PHONE, messageId: "m-1", text: "dinner at 7 tonight?", at: "2026-11-16T10:00:00.000Z", ...over });

/** The gateway's `edit` node, answering `answer` and keeping what it was asked. */
function gateway(answer: (input: Record<string, unknown>) => Response = () => Response.json({ to: "turn", why: "the words changed" })) {
  const asked: Record<string, unknown>[] = [];
  const texts = {
    fetch: async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://gateway/texts/edit");
      const input = JSON.parse(String(init?.body)) as Record<string, unknown>;
      asked.push(input);
      return answer(input);
    },
  };
  return { asked, deps: { texts, now: () => NOW } };
}

describe("editStep", () => {
  it("finds the text an edit changed by its handle, hands the node both words, and logs the step without words", async () => {
    const storage = new MemoryStorage();
    expect(await accept(storage, text(), NOW - 60_000)).toBe("queued");
    const original = (await unwritten(storage)).find((event) => event.kind === "text");
    const { asked, deps } = gateway();
    const outcome = await editStep(storage, edit(), deps);
    expect(outcome).toEqual({ to: "turn", edited: { of: original?.id, words: "dinner at 6 tonight?" } });
    expect(asked).toEqual([{ kind: "one", change: "edit", words: "dinner at 7 tonight?", earlier: "dinner at 6 tonight?" }]);
    const step = (await unwritten(storage)).find((event) => event.kind === "step" && event.step?.name === "edit");
    expect(step?.step).toMatchObject({ name: "edit", of: "edit-one", ok: true, input: { kind: "one", change: "edit", chars: 20, earlier: "event", earlierChars: 20 }, output: { to: "turn", why: "the words changed" } });
    expect(JSON.stringify(step)).not.toContain("dinner");
  });

  it("queues a changed edit as a text marked as the edit of the earlier one, with its words, for Triage", async () => {
    const storage = new MemoryStorage();
    await accept(storage, text(), NOW - 60_000);
    const { deps } = gateway();
    const { edited } = await editStep(storage, edit(), deps);
    expect(await accept(storage, editedText(edit(), edited), NOW)).toBe("queued");
    const events = (await unwritten(storage)).filter((event) => event.kind === "text");
    expect(events.at(-1)).toMatchObject({ text: "dinner at 7 tonight?", edited: true, replyTo: events[0].id, quoted: "dinner at 6 tonight?" });
    expect((await storage.list({ prefix: TEXTS_QUEUE.prefix })).size).toBe(2);
  });

  it("keeps a typo's worth in the chat's record with no turn, once", async () => {
    const storage = new MemoryStorage();
    const { deps } = gateway(() => Response.json({ to: "record", why: "a typo's worth: 1 character" }));
    const { to, edited } = await editStep(storage, edit({ previous: "dinner at 7 tonigt?" }), deps);
    expect(to).toBe("record");
    expect(edited).toEqual({ words: "dinner at 7 tonigt?" });
    expect(await keepEdit(storage, editedText(edit(), edited), NOW)).toBe("kept");
    expect(await keepEdit(storage, editedText(edit(), edited), NOW)).toBe("duplicate");
    expect((await storage.list({ prefix: TEXTS_QUEUE.prefix })).size).toBe(0);
    expect((await unwritten(storage)).filter((event) => event.kind === "text")).toMatchObject([{ edited: true, quoted: "dinner at 7 tonigt?", text: "dinner at 7 tonight?" }]);
  });

  it("takes an unsent text back out of the queue, and keeps the unsend as that text taken back", async () => {
    const storage = new MemoryStorage();
    await accept(storage, text(), NOW - 60_000);
    const { asked, deps } = gateway(() => Response.json({ to: "withdraw", why: "they took the text back" }));
    const unsend = edit({ kind: "unsent", eventId: "photon:message.unsent:m-1:3", text: undefined });
    const { to, edited } = await editStep(storage, unsend, deps);
    expect(to).toBe("withdraw");
    expect(asked).toEqual([{ kind: "one", change: "unsend", earlier: "dinner at 6 tonight?" }]);
    expect(await withdrawItem(storage, TEXTS_QUEUE, unsend.messageId)).toBe(1);
    expect((await storage.list({ prefix: TEXTS_QUEUE.prefix })).size).toBe(0);
    expect(await keepEdit(storage, editedText(unsend, edited), NOW)).toBe("kept");
    const events = (await unwritten(storage)).filter((event) => event.kind === "text");
    expect(events.at(-1)).toMatchObject({ text: "", unsent: true, replyTo: events[0].id, quoted: "dinner at 6 tonight?" });
    expect(events.at(-1)).not.toHaveProperty("edited");
  });

  it("never drops an edit or an unsend when the gateway does not answer: an edit takes a turn, an unsend is taken back", async () => {
    const storage = new MemoryStorage();
    const down = { texts: { fetch: async () => new Response(null, { status: 500 }) }, now: () => NOW };
    expect((await editStep(storage, edit(), down)).to).toBe("turn");
    expect((await editStep(storage, edit({ kind: "unsent", text: undefined }), down)).to).toBe("withdraw");
    expect((await editStep(storage, edit(), { now: () => NOW })).to).toBe("turn");
    const steps = (await unwritten(storage)).filter((event) => event.kind === "step");
    expect(steps.map((event) => [event.step?.ok, event.step?.cause])).toEqual([[false, "gateway_500"], [false, "gateway_500"], [false, "no_gateway"]]);
  });

  it("refuses a node's answer that does not fit the change", async () => {
    const storage = new MemoryStorage();
    const { deps } = gateway(() => Response.json({ to: "withdraw", why: "?" }));
    expect((await editStep(storage, edit(), deps)).to).toBe("turn");
  });
});
