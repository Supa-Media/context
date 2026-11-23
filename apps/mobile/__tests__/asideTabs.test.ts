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
 * meeting can start while somebody is halfway through a question to Tex, and a
 * panel that swaps out from under them is a panel they stop trusting.
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
 *  4. The Approvals entry put back into `ASIDE_TABS`, so the panel lists a
 *     tab the owner removed (2026-11-19).
 *     → **6 fail**: `there is no Approvals tab` and `visibleAsideTabs never
 *     shows Approvals, whatever it is given`, and four older catalogue tests
 *     that list the tabs exactly.
 */

describe("which tab is showing", () => {
  test("Meetings is where a panel opens", () => {
    expect(asideTabFor(null)).toBe("meetings");
    expect(asideTabFor(undefined)).toBe("meetings");
    expect(DEFAULT_ASIDE_TAB).toBe("meetings");
  });

  test("a person's own press is what moves it", () => {
    expect(asideTabFor("tex")).toBe("tex");
    expect(asideTabFor("meetings")).toBe("meetings");
  });

  test("a tab this build has never heard of falls back", () => {
    // "chat" included: the tab is gone (2026-10-10). "approvals" too: it is gone (2026-11-19), and an old link naming it lands on Meetings.
    for (const bad of ["", "chat", "approvals", "proposals", "Tex", "meetings ", "__proto__"]) {
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
    expect(asideTabFor("tex")).toBe("tex");
  });
});

describe("the dot that makes that safe", () => {
  test("a running meeting is marked while you are elsewhere", () => {
    expect(meetingNeedsAttention("tex", true)).toBe(true);
  });

  test("no dot on the tab you are already reading", () => {
    expect(meetingNeedsAttention("meetings", true)).toBe(false);
  });

  test("and no dot with no meeting behind it", () => {
    expect(meetingNeedsAttention("tex", false)).toBe(false);
    expect(meetingNeedsAttention("meetings", false)).toBe(false);
  });
});

describe("the catalogue", () => {
  /*
    Two: Chat was removed from the panel entirely (Dev2, 2026-10-10, "remove
    chat from the sidebar entirely"). Visibility is decided by
    `visibleAsideTabs`, not by this list.
  */
  test("the map's two tabs lead (only while it is open), then Meetings, Tex and the Vault, and no in-app agent", () => {
    expect(ASIDE_TABS.map((tab) => tab.key)).toEqual(["activity", "note", "meetings", "tex", "vault"]);
    expect(ASIDE_TABS.map((tab) => tab.label)).not.toContain("Chat");
  });

  test("with the map shut a console never shows its tabs", () => {
    expect(visibleAsideTabs({ note: true })).toEqual(["meetings"]);
    expect(visibleAsideTabs({ map: true })).toEqual(["activity", "meetings"]);
    expect(visibleAsideTabs({ map: true, note: true })).toEqual(["activity", "note", "meetings"]);
  });

  /*
    The vault left Settings for the rail (Dev, 2026-11-23), and only a console
    with a workspace open has one: never the demo, a visitor or the landing.
    SABOTAGE: default `vault` to true in `visibleAsideTabs` and the first line fails.
  */
  test("the Vault is a tab only with a workspace open, after Tex", () => {
    expect(visibleAsideTabs({})).toEqual(["meetings"]);
    expect(visibleAsideTabs({ vault: true })).toEqual(["meetings", "vault"]);
    expect(visibleAsideTabs({ tex: true, vault: true })).toEqual(["meetings", "tex", "vault"]);
  });

  test("every tab has a word on it", () => {
    for (const tab of ASIDE_TABS) expect(tab.label.length).toBeGreaterThan(0);
  });
});

/**
 * THERE IS NO APPROVALS TAB.
 *
 * The owner (2026-11-19): "no approvals tab, just make the approvals happen
 * right inside the message box". What an AI client is waiting on is answered
 * inline in the Tex chat, and its count rides on the Tex tab's label. So no
 * console, whatever it is handed, lists Approvals as a tab.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. The Approvals entry put back into `ASIDE_TABS`.
 *     → **6 fail**: `there is no Approvals tab` and `visibleAsideTabs never
 *     shows Approvals, whatever it is given`, and four older catalogue tests
 *     that list the tabs exactly.
 */
describe("which tabs a console shows", () => {
  test("there is no Approvals tab", () => {
    expect(ASIDE_TABS.map((tab) => tab.key)).not.toContain("approvals");
    expect(ASIDE_TABS.map((tab) => tab.label)).not.toContain("Approvals");
  });

  test("visibleAsideTabs never shows Approvals, whatever it is given", () => {
    const flags = [false, true];
    for (const map of flags) {
      for (const note of flags) {
        for (const tex of flags) {
          expect(visibleAsideTabs({ map, note, tex })).not.toContain("approvals");
        }
      }
    }
  });

  test("Tex sits right after Meetings, and only where the owner's chat is open", () => {
    expect(visibleAsideTabs({ tex: true })).toEqual(["meetings", "tex"]);
    expect(visibleAsideTabs({ map: true, tex: true })).toEqual(["activity", "meetings", "tex"]);
    expect(visibleAsideTabs({})).toEqual(["meetings"]);
  });
});
