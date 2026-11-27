/**
 * A BOT'S HEALTH READS AT A GLANCE, WHOEVER LOOKS.
 *
 * Dev, 2026-11-27: "I can see the health of each bot at a glance, even if I dont own the bot", and, the same day,
 * "as long as the agent is pinging every 5 minutes it can be in good standing". A bot is reached by its webhook or
 * by checking in; each has its good and bad words.
 */

import { describe, expect, test } from "@jest/globals";
import { botHealth, botLookups, CHECK_STALE_MS } from "../features/console/files/folderPage/areas/botHealth";
import type { HookRow } from "../features/console/files/folderPage/areas/PanelBotHook";

const NOW = Date.UTC(2026, 10, 27, 17, 0);
const MIN = 60_000;
const ROW: HookRow = { bot: "grok-bot", host: "bot.example.com", headerEnds: "1234", setByName: "seyi", lastCallAt: NOW - 5 * MIN, lastCallOk: true, lastCallStatus: 200, canReplace: true };
const answered = { lastAt: NOW - 3 * 60 * MIN, outcome: "sent" as const, answeredAt: NOW - 2 * 60 * MIN };
const unanswered = { lastAt: NOW - 2 * 60 * MIN, outcome: "sent" as const, answeredAt: null };

describe("a webhook bot", () => {
  test("answering, failing, not answering, not tried", () => {
    expect(botHealth(ROW, [answered], NOW)).toMatchObject({ state: "answering", tone: "ok", via: "webhook", routines: "1 of 1 routine answered this week" });
    expect(botHealth({ ...ROW, lastCallOk: false, lastCallStatus: 503 }, [], NOW)).toMatchObject({ state: "webhook failing", tone: "crit", bad: true });
    expect(botHealth({ ...ROW, lastCallOk: false, lastCallStatus: 0 }, [], NOW).why).toContain("didn't reach");
    expect(botHealth(ROW, [answered, unanswered], NOW)).toMatchObject({ state: "not answering", tone: "warn", routines: "1 of 2 routines answered this week" });
    // Sent minutes ago is not yet missed, and not yet answered: a call that landed is not an answer (Dev, 2026-11-27).
    expect(botHealth(ROW, [{ ...unanswered, lastAt: NOW - 10 * MIN }], NOW)).toMatchObject({ state: "reachable", bad: false, why: expect.stringContaining("No answer yet.") });
    expect(botHealth(ROW, [], NOW)).toMatchObject({ state: "reachable", why: expect.stringContaining("Nothing to answer yet this week.") });
    // Its own check-in counts as answering, as for a bot with no webhook.
    expect(botHealth(ROW, [], NOW, { checkedAt: NOW - 2 * MIN })).toMatchObject({ state: "answering", why: "Checks every 5 min · last check 2 min ago" });
    expect(botHealth({ ...ROW, lastCallAt: null, lastCallOk: null, lastCallStatus: null }, [], NOW)).toMatchObject({ state: "not tried", bad: false });
  });

  test("no webhook and no check-ins is not set up", () => {
    expect(botHealth(null, [], NOW)).toMatchObject({ state: "not set up", via: null, bad: true });
    expect(botHealth(null, [], NOW, { reach: "webhook" }).state).toBe("not set up");
  });
});

describe("a bot that checks in", () => {
  test("checking within ten minutes, stopped after, not checking before the first", () => {
    expect(botHealth(null, [], NOW, { reach: "mail", checkedAt: NOW - 4 * MIN })).toMatchObject({ state: "checking", tone: "ok", via: "check", why: "Checks every 5 min · last check 4 min ago" });
    expect(botHealth(null, [], NOW, { reach: "mail", checkedAt: NOW - CHECK_STALE_MS - MIN })).toMatchObject({ state: "stopped checking", tone: "crit", bad: true });
    expect(botHealth(null, [], NOW, { reach: "mail" })).toMatchObject({ state: "not checking", bad: true, via: "check" });
    expect(botHealth(null, [unanswered], NOW, { reach: "mail", checkedAt: NOW - MIN })).toMatchObject({ state: "not answering", via: "check" });
  });

  test("a check-in counts even where the card says nothing of its reach; a webhook row wins", () => {
    expect(botHealth(null, [], NOW, { checkedAt: NOW - MIN }).state).toBe("checking");
    expect(botHealth(ROW, [], NOW, { reach: "mail", checkedAt: NOW - CHECK_STALE_MS * 3 }).via).toBe("webhook");
  });

  test("the lookups match a bot by its mail name, in the hook list and the check-ins", () => {
    const state = { week: "2026-11-23", routines: [], usage: [], checks: [{ bot: "muse-bot", at: NOW - 2 * MIN }] };
    const lookups = botLookups([ROW], state, NOW);
    expect(lookups.hookRowOf("Grok Bot")).toEqual(ROW);
    expect(lookups.healthOf("Grok Bot")?.state).toBe("reachable");
    expect(lookups.healthOf("Muse Bot", "mail")?.state).toBe("checking");
    expect(lookups.healthOf("Instinct", "mail")?.state).toBe("not checking");
    expect(botLookups(undefined, state, NOW).healthOf("Grok Bot")).toBeUndefined();
  });
});
