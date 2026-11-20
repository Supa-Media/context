/**
 * A LONG PASTED TEXT REACHES THE TURN WHOLE (2026-11-11).
 *
 * In a 1:1 iMessage Dev2 pasted a brief written for another AI, its instructions first and the brief after. The
 * Worker cut it at 4,000 and its event at 3,000, with no mark, and Tex said the brief was missing.
 * Sabotage: `MAX_INBOUND_TEXT` back to 4000 in `inbound.ts`: the brief's last line is lost and these fail.
 */
import { describe, expect, it } from "vitest";
import { cut, cutText, MAX_INBOUND_TEXT } from "./inbound";
import { parseSendblueInbound } from "./sendblue";
import { parseSendblueGroup } from "./sendblueGroups";
import { addEvent, keptEvents, MAX_EVENT_TEXT } from "./events";
import { AlarmStorage } from "./memoryStorage.testing";

const LINE = "+15555550199";
const ADA = "+15555550101";
const LAST = "Last line of the brief: ship the screens by Friday.";
/** About 6,000 characters: instructions for another AI first, the brief's content after, its last line at the end. */
const BRIEF = `${"Instructions for the screens: read the brief below and draw each screen it names.\n".repeat(40)}\nThe brief:\n${"The home screen lists every chat, newest first.\n".repeat(55)}${LAST}`;

describe("a pasted brief", () => {
  it("is about 6,000 characters, so the old caps cut it", () => {
    expect(BRIEF.length).toBeGreaterThan(5_500);
    expect(BRIEF.length).toBeLessThan(6_500);
  });

  it("reaches a 1:1 turn with its last line", () => {
    const parsed = parseSendblueInbound({ content: BRIEF, is_outbound: false, message_handle: "h_brief", from_number: ADA, sendblue_number: LINE, message_type: "message", group_id: "", service: "iMessage" });
    expect(parsed.kind === "message" && parsed.text.endsWith(LAST)).toBe(true);
  });

  it("reaches a group turn with its last line", () => {
    const parsed = parseSendblueGroup({ content: BRIEF, is_outbound: false, message_handle: "h_brief_g", from_number: ADA, sendblue_number: LINE, service: "iMessage", group_id: "11111111-2222-3333-4444-555555555555", participants: [ADA, "+15555550102"] });
    expect(parsed?.kind === "group-message" && parsed.text.endsWith(LAST)).toBe(true);
  });

  it("is kept whole as the chat's event", async () => {
    const storage = new AlarmStorage();
    await addEvent(storage, { chat: "c1", at: Date.now(), from: { kind: "person" }, kind: "text", text: BRIEF });
    expect((await keptEvents(storage, "c1")).at(-1)?.text?.endsWith(LAST)).toBe(true);
  });
});

describe("a text over the limit", () => {
  it("is cut to the limit, the marker included, and says how much it left out", () => {
    const long = "a".repeat(MAX_INBOUND_TEXT + 50);
    const kept = cut(long);
    expect(kept.length).toBe(MAX_INBOUND_TEXT);
    const left = Number(/\[cut: (\d+) more characters\]$/.exec(kept)![1]);
    expect(kept.indexOf("\n[cut:") + left).toBe(long.length);
    expect(MAX_EVENT_TEXT).toBe(MAX_INBOUND_TEXT);
  });
});

describe("a cut is told by `left`, never by the words", () => {
  const LONG = `${BRIEF}${"x".repeat(MAX_INBOUND_TEXT)}`;

  it("a text over the limit carries the count it cut, onto its event", async () => {
    const parsed = parseSendblueInbound({ content: LONG, is_outbound: false, message_handle: "h_long", from_number: ADA, sendblue_number: LINE, message_type: "message", group_id: "", service: "iMessage" });
    expect(parsed.kind === "message" && parsed.left).toBe(cutText(LONG).left);
    const storage = new AlarmStorage();
    await addEvent(storage, { chat: "c2", at: Date.now(), from: { kind: "person" }, kind: "text", text: LONG });
    const [kept] = await keptEvents(storage, "c2");
    expect(kept?.left).toBe(cutText(LONG).left);
    expect(kept!.text!.length + kept!.left! - `\n[cut: ${kept!.left} more characters]`.length).toBe(LONG.length);
  });

  it("a typed mark is words: no count", async () => {
    const typed = `${BRIEF}\n[cut: 99 more characters]`;
    expect(cutText(typed).left).toBeUndefined();
    const storage = new AlarmStorage();
    await addEvent(storage, { chat: "c3", at: Date.now(), from: { kind: "person" }, kind: "text", text: typed });
    expect((await keptEvents(storage, "c3"))[0]?.left).toBeUndefined();
  });

  it("only a person's text event carries one, as the gateway takes it", async () => {
    const storage = new AlarmStorage();
    await addEvent(storage, { chat: "c4", at: Date.now(), from: { kind: "tex" }, kind: "text", text: LONG });
    await addEvent(storage, { chat: "c4", at: Date.now(), from: { kind: "person" }, kind: "picture", text: LONG, left: 5 });
    expect((await keptEvents(storage, "c4")).map((event) => event.left)).toEqual([undefined, undefined]);
  });
});
