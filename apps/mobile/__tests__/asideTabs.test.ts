import { describe, expect, test } from "@jest/globals";
import {
  ASIDE_TABS,
  DEFAULT_ASIDE_TAB,
  asideTabFor,
  meetingNeedsAttention,
} from "../features/console/aside/tabs";

/**
 * THE RIGHT PANEL'S TABS, AND THE ONE TRADE THEY REST ON.
 *
 * A running meeting is the most urgent thing this panel knows about, and it
 * still does not take the tab. That is a decision rather than an oversight: a
 * meeting can start while somebody is halfway through typing a question, and a
 * panel that swaps out from under a composer loses what they wrote and answers
 * something they did not ask.
 *
 * What makes that trade safe is the dot — so the dot has to be exactly right,
 * in both directions. A dot with no meeting behind it teaches people to ignore
 * it; no dot with a meeting behind it is a recording somebody misses. Both are
 * here.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `asideTabFor` taking a `meetingLive` argument and answering `"meetings"`
 *     for it — the seize this file exists to refuse, written as somebody
 *     helpful would write it.
 *     → **1 fails**: `a meeting does not take the tab`.
 *  2. `meetingNeedsAttention` dropping its `showing` term, so the dot is on
 *     whenever a meeting runs.
 *     → **1 fails**: `no dot on the tab you are already reading`.
 *  3. `asideTabFor` returning its argument unchecked.
 *     → **1 fails**: `a tab this build has never heard of falls back`.
 */

describe("which tab is showing", () => {
  test("chat is where a panel opens", () => {
    expect(asideTabFor(null)).toBe("chat");
    expect(asideTabFor(undefined)).toBe("chat");
    expect(DEFAULT_ASIDE_TAB).toBe("chat");
  });

  test("a person's own press is what moves it", () => {
    expect(asideTabFor("meetings")).toBe("meetings");
    expect(asideTabFor("chat")).toBe("chat");
  });

  test("a tab this build has never heard of falls back", () => {
    for (const bad of ["", "proposals", "Chat", "meetings ", "__proto__"]) {
      expect(asideTabFor(bad)).toBe("chat");
    }
  });

  /**
   * Stated as an absence, which is the only way to state it: `asideTabFor`
   * takes no `meetingLive` argument at all, so a meeting *cannot* move the tab
   * — the seize is unrepresentable rather than merely unwritten.
   */
  test("a meeting does not take the tab", () => {
    expect(asideTabFor.length).toBe(1);
    // ...and the tab somebody chose survives one, because nothing here reads it.
    expect(asideTabFor("chat")).toBe("chat");
  });
});

describe("the dot that makes that safe", () => {
  test("a running meeting is marked while you are elsewhere", () => {
    expect(meetingNeedsAttention("chat", true)).toBe(true);
  });

  test("no dot on the tab you are already reading", () => {
    expect(meetingNeedsAttention("meetings", true)).toBe(false);
  });

  test("and no dot with no meeting behind it", () => {
    expect(meetingNeedsAttention("chat", false)).toBe(false);
    expect(meetingNeedsAttention("meetings", false)).toBe(false);
  });
});

describe("the catalogue", () => {
  test("two tabs, and chat leads", () => {
    expect(ASIDE_TABS.map((tab) => tab.key)).toEqual(["chat", "meetings"]);
  });

  test("every tab has a word on it", () => {
    for (const tab of ASIDE_TABS) expect(tab.label.length).toBeGreaterThan(0);
  });
});
