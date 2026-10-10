import { describe, expect, test } from "@jest/globals";
import {
  ASIDE_TABS,
  DEFAULT_ASIDE_TAB,
  asideTabFor,
  meetingNeedsAttention,
  visibleAsideTabs,
} from "../features/console/aside/tabs";

/**
 * THE RIGHT PANEL'S TABS, AND THE ONE TRADE THEY REST ON.
 *
 * A running meeting is the most urgent thing this panel knows about, and it
 * still does not take the tab. That is a decision rather than an oversight: a
 * meeting can start while somebody is halfway through answering an approval,
 * and a panel that swaps out from under them is a panel they stop trusting.
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
  test("Meetings is where a panel opens", () => {
    expect(asideTabFor(null)).toBe("meetings");
    expect(asideTabFor(undefined)).toBe("meetings");
    expect(DEFAULT_ASIDE_TAB).toBe("meetings");
  });

  test("a person's own press is what moves it", () => {
    expect(asideTabFor("approvals")).toBe("approvals");
    expect(asideTabFor("meetings")).toBe("meetings");
  });

  test("a tab this build has never heard of falls back", () => {
    // "chat" included: the tab is gone (2026-10-10), and an old link naming it lands on Meetings.
    for (const bad of ["", "chat", "proposals", "Approvals", "meetings ", "__proto__"]) {
      expect(asideTabFor(bad)).toBe("meetings");
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
    expect(asideTabFor("approvals")).toBe("approvals");
  });
});

describe("the dot that makes that safe", () => {
  test("a running meeting is marked while you are elsewhere", () => {
    expect(meetingNeedsAttention("approvals", true)).toBe(true);
  });

  test("no dot on the tab you are already reading", () => {
    expect(meetingNeedsAttention("meetings", true)).toBe(false);
  });

  test("and no dot with no meeting behind it", () => {
    expect(meetingNeedsAttention("approvals", false)).toBe(false);
    expect(meetingNeedsAttention("meetings", false)).toBe(false);
  });
});

describe("the catalogue", () => {
  /*
    Two: Chat was removed from the panel entirely (Dev2, 2026-10-10, "remove
    chat from the sidebar entirely"). Visibility is decided by
    `visibleAsideTabs`, not by this list.
  */
  test("two tabs, Meetings first, and no Chat", () => {
    expect(ASIDE_TABS.map((tab) => tab.key)).toEqual(["meetings", "approvals"]);
    expect(ASIDE_TABS.map((tab) => tab.label)).not.toContain("Chat");
  });

  test("every tab has a word on it", () => {
    for (const tab of ASIDE_TABS) expect(tab.label.length).toBeGreaterThan(0);
  });
});

/**
 * THE APPROVALS TAB IS THERE ONLY WHEN IT CAN BE ANSWERED.
 *
 * It is the answer to a question the context's AI clients asked. It is absent
 * when the console has no approvals route to ask — the homepage and the demo
 * pass none — rather than an empty list claiming nothing is waiting.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. The approvals term dropped, so the tab shows where it cannot be answered.
 *     → **1 fails**: `Approvals is absent where it cannot be answered`.
 */
describe("which tabs a console shows", () => {
  test("a console that can answer approvals shows both, in order", () => {
    expect(visibleAsideTabs({ approvals: true })).toEqual(["meetings", "approvals"]);
  });

  test("Approvals is absent where it cannot be answered", () => {
    expect(visibleAsideTabs({ approvals: false })).toEqual(["meetings"]);
  });
});
