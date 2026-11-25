/**
 * THE BOTS AND MAIL VIEWS READ BOTS AND THEIR CONVERSATIONS FROM THE NOTES (`areas/bots.ts`).
 *
 * The owner, 2026-11-25: "how can I view all the bots we have, view the conversations happening across bots, and maybe
 * even talk to a bot directly inside of context". A bot is a card in `bots/<bot>/about.md` (or an older `people/`
 * card that says `bot:`); a conversation is one mail note, in an area's `mail/` or a bot's own.
 */

import { describe, expect, test } from "@jest/globals";
import { botMailNote, botsOf, conversationsOf, mailOfBot, routinesOfBot } from "../features/console/files/folderPage/areas/bots";
import { capWords } from "../features/console/files/folderPage/areas/BotsPage";
import type { ListNote } from "../features/console/files/listBlock/model";

const note = (path: string, properties: Record<string, string | readonly string[]> = {}): ListNote => ({ path, properties, updatedAt: 1_000 });

const NOTES: ListNote[] = [
  note("areas/about.md", { agents: ["Grok Bot", "Socials", "Pipeline"] }),
  note("areas/bots/about.md", { area: "false" }),
  note("areas/bots/grok-bot/about.md", { holder: "Grok Bot", kind: "agent", bot: "grok", belongs_to: "@seyi", reach: "webhook", works_in: ["areas/operations/scorecard · 20%", "areas/growth"] }),
  note("areas/bots/socials/about.md", { holder: "Socials", kind: "agent", bot: "grok", belongs_to: "@shyoh" }),
  note("areas/people/pipeline.md", { holder: "Pipeline", kind: "agent", bot: "grok", belongs_to: "@seyi" }),
  note("areas/people/dev2.md", { kind: "person", phone: "+1 555 010 0177" }),
  note("areas/operations/about.md", { owner: "@seyi" }),
  note("areas/operations/scorecard/about.md", { owner: "Grok Bot" }),
  note("areas/operations/scorecard/routines/weekly/score-every-area.md", { at: "9:00 am", on: "monday" }),
  note("areas/operations/scorecard/mail/seyi.md"),
  note("areas/operations/scorecard/mail/socials.md"),
  note("areas/growth/about.md", { owner: "@shyoh", delegate: "Socials" }),
  note("areas/growth/mail/grok-bot.md"),
  note("areas/finance/about.md", { owner: "@seyi", delegate: "Grok Bot" }),
  note("areas/bots/grok-bot/mail/seyi.md"),
];

describe("bots", () => {
  const bots = botsOf("areas", NOTES, "@seyi");

  test("every bot card, in bots/ or an older people/ card, theirs first; a person's card is no bot", () => {
    expect(bots.map((bot) => bot.name)).toEqual(["Grok Bot", "Pipeline", "Socials"]);
    expect(bots.map((bot) => bot.mine)).toEqual([true, true, false]);
    expect(bots[1]!.card.path).toBe("areas/people/pipeline.md");
  });

  test("the areas it holds, with its cap on each, and an area its card doesn't list", () => {
    const grok = bots[0]!;
    expect(grok.areas).toEqual([
      { folder: "areas/finance", title: "Finance", role: "delegate", cap: null, listed: false },
      { folder: "areas/operations/scorecard", title: "Scorecard", role: "owner", cap: 20, listed: true },
    ]);
    expect(capWords(grok)).toBe("20% of its week here");
    expect(capWords(bots[2]!)).toBe("No caps");
  });

  test("its mail, its own folder's note, and the routines of the areas it holds", () => {
    const grok = bots[0]!;
    const talks = conversationsOf("areas", NOTES, bots, "@seyi");
    expect(mailOfBot(grok, talks).map((each) => each.path).sort()).toEqual([
      "areas/bots/grok-bot/mail/seyi.md",
      "areas/growth/mail/grok-bot.md",
      "areas/operations/scorecard/mail/seyi.md",
      "areas/operations/scorecard/mail/socials.md",
    ]);
    expect(botMailNote(grok, "@seyi")).toBe("areas/bots/grok-bot/mail/seyi.md");
    expect(routinesOfBot(grok, "areas", NOTES)).toEqual([
      { path: "areas/operations/scorecard/routines/weekly/score-every-area.md", name: "Score every area", how: "weekly", area: "Scorecard" },
    ]);
  });

  test("a conversation says who is on each side, whether both are bots, and whether it is the reader's", () => {
    const talks = conversationsOf("areas", NOTES, bots, "@seyi");
    const byPath = new Map(talks.map((each) => [each.path, each]));
    expect(byPath.get("areas/operations/scorecard/mail/socials.md")).toMatchObject({ sender: "socials", with: "Grok Bot", botToBot: true, mine: false, placeTitle: "Scorecard mail" });
    expect(byPath.get("areas/growth/mail/grok-bot.md")).toMatchObject({ with: "Socials", botToBot: true });
    expect(byPath.get("areas/bots/grok-bot/mail/seyi.md")).toMatchObject({ with: "Grok Bot", botToBot: false, mine: true, placeTitle: "Grok Bot's mail" });
  });
});
