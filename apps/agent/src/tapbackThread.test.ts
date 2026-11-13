/**
 * A group answer to a tapback never threads under the tapback (Nov Babies,
 * 2026-11-12): Dev2's 👍 on "Want me to fill in the form?" was answered with
 * three texts sent as replies to the 👍 itself; Sendblue took each send and
 * then failed it (ERROR, class 5000), and none reached the chat. The answer
 * goes under the Tex text the tapback was on, or plain, as a 1:1 tapback's
 * answer does (`sendParts.ts` `threadFor`); `groupSay.ts` `threadUnder`.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted (2026-11-12).
 *
 *  1. `threadUnder` returning `message.messageId` always (the old anchor)
 *     -> "is answered under the question it was on" and "goes plain when
 *     Tex's text isn't named" fail.
 *  2. `toolStarted` not skipping `answersTapback` -> "never taps the
 *     tapback" fails.
 *  3. `groupPartLine` not keeping threaded sends -> "keeps each threaded
 *     text for the plain resend" fails.
 */

import { describe, expect, it } from "vitest";
import { acceptGroup, drainGroup, type GroupDeps } from "./groupInbox";
import { MemoryStorage } from "./memoryStorage.testing";
import type { GroupMessage } from "./sendblueGroups";
import type { Reaction } from "./reactions";
import type { Fetch } from "./clients";
import { answerAll, fakeJudge, newestLine, type Decide } from "./groupWorld.testing";
import { THREADED_KEY, type Threaded } from "./threadedResend";
import type { TexEvent } from "./events";

const LINE = "+15555550199";
const ADA = "+15555550101";
const BO = "+15555550102";
const GROUP = "11111111-2222-3333-4444-555555555555";
const QUESTION = "Nothing's sent yet. Want me to fill in the form? 👍 or 👎?";

const msg = (text: string, extra: Partial<GroupMessage> = {}): GroupMessage => ({
  kind: "group-message",
  eventId: `sendblue:${extra.messageId ?? "in"}`,
  groupId: GROUP,
  line: LINE,
  from: ADA,
  participants: [ADA, BO, LINE],
  messageId: extra.messageId ?? "in",
  text,
  ...extra,
});
const reacted = (id: string, reaction: Reaction, extra: Partial<GroupMessage> = {}) => msg(`${reaction.how} “${reaction.words}”`, { messageId: id, reaction, ...extra });

type World = { sends: { content?: string; reply_to?: { message_handle?: string } }[]; tapped: string[]; asks: Record<string, unknown>[]; ledger: TexEvent[] };

const judge = (body: Decide) => (/on Tex's message/.test(newestLine(body)) ? answerAll(body) : fakeJudge(body));

function deps(w: World, answer: Record<string, unknown>): GroupDeps {
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.startsWith("/api/v2/groups/")) return Response.json({ participants: [{ number: ADA }, { number: BO }] });
    const body = JSON.parse(String(init.body));
    if (path === "/agent-texts/group") return Response.json({ status: "ready", slug: "band", intro: false, bound: true, handle: "ada", accessToken: "cat" });
    if (path === "/agent-texts/decide") return Response.json(judge(body));
    if (path === "/agent/events") return w.ledger.push(...body.events), Response.json({ written: body.events.map((event: { id: string }) => event.id) });
    if (path === "/agent/chat") return Response.json({ events: w.ledger });
    if (path === "/api/send-reaction") return w.tapped.push(body.message_handle), Response.json({});
    if (path === "/api/send-group-message") return w.sends.push(body), Response.json({ message_handle: `out_${w.sends.length}` });
    if (path === "/agent") {
      w.asks.push(body);
      // The model starts a tool, as the form-fill turn did: the slow-ask tapback would go now.
      return new Response([JSON.stringify({ step: "Searching the web" }), JSON.stringify({ status: 200, body: answer })].join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
    }
    throw new Error(`unexpected ${path}`);
  }) as unknown as Fetch;
  return { fetch: fetcher, controlPlaneOrigin: "https://c.test", workerSecret: "s", gatewayOrigin: "https://g.test", sendblue: { keyId: "i", secret: "k" }, now: () => 1_000 };
}

/** Tex asks its question in the chat as Ada's turn; it goes as `out_1`. */
async function texAsked(storage: MemoryStorage, w: World): Promise<void> {
  await acceptGroup(storage, msg("Tex how do we reserve puttery for 20 people", { messageId: "tag" }), 0);
  await drainGroup(storage, deps(w, { answer: QUESTION }));
  expect(w.sends.map((sent) => sent.content)).toEqual([QUESTION]);
}

const world = (): World => ({ sends: [], tapped: [], asks: [], ledger: [] });
const ANSWER = { answer: "I can fill most of the form.\n\nFirst name, last name, email and phone?" };

describe("a group answer to a tapback", () => {
  it("is answered under the question it was on, never under the tapback", async () => {
    const storage = new MemoryStorage();
    const w = world();
    await texAsked(storage, w);
    expect(await acceptGroup(storage, reacted("tb", { how: "Liked", words: QUESTION }, { replyTo: "out_1" }), 1_000)).toBe("kept");
    await drainGroup(storage, deps(w, ANSWER));
    const answer = w.sends.slice(1);
    expect(answer.length).toBeGreaterThan(0);
    expect(answer.map((sent) => sent.reply_to?.message_handle)).toEqual(answer.map(() => "out_1"));
  });

  it("goes plain when Tex's text isn't named", async () => {
    const storage = new MemoryStorage();
    const w = world();
    await texAsked(storage, w);
    expect(await acceptGroup(storage, reacted("tb", { how: "Liked", words: QUESTION }), 1_000)).toBe("kept");
    await drainGroup(storage, deps(w, ANSWER));
    const answer = w.sends.slice(1);
    expect(answer.length).toBeGreaterThan(0);
    expect(answer.every((sent) => sent.reply_to === undefined)).toBe(true);
  });

  it("never taps the tapback", async () => {
    const storage = new MemoryStorage();
    const w = world();
    await texAsked(storage, w);
    const before = [...w.tapped];
    await acceptGroup(storage, reacted("tb", { how: "Liked", words: QUESTION }, { replyTo: "out_1" }), 1_000);
    await drainGroup(storage, deps(w, ANSWER));
    expect(w.tapped.slice(before.length)).not.toContain("tb");
  });

  it("keeps each threaded text for the plain resend, and nothing sent plain", async () => {
    const storage = new MemoryStorage();
    const w = world();
    await texAsked(storage, w);
    // The question went under the tag: kept, by its handle, with where it went.
    expect((await storage.get<Threaded[]>(THREADED_KEY)) ?? []).toEqual([{ h: "out_1", text: QUESTION, place: { kind: "group", line: LINE, groupId: GROUP }, at: 1_000 }]);
    await acceptGroup(storage, reacted("tb", { how: "Liked", words: QUESTION }), 1_000);
    await drainGroup(storage, deps(w, ANSWER));
    // The plain answer adds nothing.
    expect(((await storage.get<Threaded[]>(THREADED_KEY)) ?? []).map((entry) => entry.h)).toEqual(["out_1"]);
  });
});
