/**
 * AGENT MAIL SAYS WHICH ASKS ARE STILL OWED AN ANSWER, AND BY WHICH SEAT.
 *
 * Dev, 2026-11-28, after Muse's audit counted twelve asks that looked unanswered: the Mail page shows "Waiting on
 * Areas · 4 h" on a conversation whose newest ask nobody it went to has answered (`mail.cjs` `openAsk`, served by the
 * gateway as `waiting`), and a Waiting view lists those, longest waiting first (artboards 01 and 05).
 *
 * Sabotage: owing an ask to everyone in an area's mail to the sender instead of the area fails "an ask from outside
 * an area is owed by the area".
 */

import { describe, expect, test } from "@jest/globals";
import { conversationsOf, groupsFor, waitingCount, waitingOnOf, type MailNoteRow } from "../features/console/mailPage/model";

const last = (at: string, from: string) => ({ at, from, to: "everyone", used: null, text: "…" });
const ROWS: MailNoteRow[] = [
  {
    path: "areas/operations/mail/areas.md",
    count: 2,
    joined: ["areas", "muse"],
    last: last("2026-11-28T05:04:00.000Z", "muse"),
    waiting: { at: "2026-11-28T05:04:00.000Z", from: "muse", to: "grok-bot" },
  },
  {
    path: "areas/growth/mail/grok-bot.md",
    count: 1,
    joined: ["grok-bot"],
    last: last("2026-11-28T05:03:00.000Z", "grok-bot"),
    waiting: { at: "2026-11-28T01:03:00.000Z", from: "grok-bot", to: "everyone" },
  },
  { path: "areas/finance/mail/seyi.md", count: 2, joined: ["@seyi", "finance"], last: last("2026-11-28T03:12:00.000Z", "finance"), waiting: null },
  { path: "products/plan.md", count: 1, joined: ["builder"], last: last("2026-11-28T02:00:00.000Z", "builder") },
];

describe("who owes an open ask", () => {
  test("an ask to a name is owed by that name, and to the reader by You", () => {
    expect(waitingOnOf({ at: "x", from: "muse", to: "grok-bot" }, { kind: "area", area: "areas/operations" }, "areas", "@seyi")).toBe("Grok Bot");
    expect(waitingOnOf({ at: "x", from: "muse", to: "@seyi" }, { kind: "area", area: "areas/operations" }, "areas", "@seyi")).toBe("You");
  });

  test("an ask from outside an area is owed by the area, and one from inside by the sender the note is for", () => {
    expect(waitingOnOf({ at: "x", from: "grok-bot", to: "everyone" }, { kind: "area", area: "areas/growth" }, "grok-bot", "@seyi")).toBe("Growth");
    expect(waitingOnOf({ at: "x", from: "growth-bot", to: "everyone" }, { kind: "area", area: "areas/growth" }, "grok-bot", "@seyi")).toBe("Grok Bot");
  });

  test("in a bot's own mail and on any other note", () => {
    expect(waitingOnOf({ at: "x", from: "@seyi", to: "everyone" }, { kind: "bot", bot: "grok-bot" }, "@seyi", "@seyi")).toBe("Grok Bot");
    expect(waitingOnOf({ at: "x", from: "grok-bot", to: "everyone" }, { kind: "bot", bot: "grok-bot" }, "@seyi", "@seyi")).toBe("You");
    expect(waitingOnOf({ at: "x", from: "builder", to: "everyone" }, { kind: "note" }, "plan", "@seyi")).toBe("a reply");
    expect(waitingOnOf(null, { kind: "note" }, "plan", "@seyi")).toBeNull();
  });
});

describe("the Waiting view", () => {
  test("lists only conversations owed an answer, longest waiting first, and counts them", () => {
    const conversations = conversationsOf(ROWS, "areas", "@seyi");
    expect(waitingCount(conversations)).toBe(2);
    const [group] = groupsFor("waiting", conversations);
    expect(group?.conversations.map((each) => [each.path, each.waitingOn])).toEqual([
      ["areas/growth/mail/grok-bot.md", "Growth"],
      ["areas/operations/mail/areas.md", "Grok Bot"],
    ]);
  });

  test("a gateway that sends no waiting shows nothing owed", () => {
    const conversations = conversationsOf([ROWS[3]!], "areas", "@seyi");
    expect(conversations[0]?.waitingOn).toBeNull();
    expect(groupsFor("waiting", conversations)).toEqual([]);
  });
});
