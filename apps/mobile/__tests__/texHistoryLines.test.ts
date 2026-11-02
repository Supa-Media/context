/**
 * @jest-environment jsdom
 */

/**
 * The chat's history drawn one line a message (owner, 2026-11-02: "go back to
 * the ltr, 1 line slack style"), and the history file opened in the app as
 * that chat's history rather than as its JSON.
 *
 * ## Sabotage record
 *
 * Applied, run, named test seen failing, reverted (2026-11-02):
 *  1. A person's text left as a turn of its own → "a person's text sits with
 *     the turn that answered it" fails.
 *  2. Lines within a turn left newest first → same test fails.
 *  3. `historyFileChat` answering "me" for `tex/history.ledger.json` in a
 *     workspace that is not the viewer's own → "the file names its chat"
 *     fails.
 *  4. `groupChatAt` matching the folder in any workspace → same test fails.
 *  5. `HistoryFileView`'s source keyed on the `own` row and the minter again
 *     → "a person's own file reads their own chat" fails (read twice).
 *  6. `collapseCalls` left out → "tool calls in a row are one line" fails.
 *  7. Reactions not folded → "a reaction sits under the text it is on" fails.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { dayAsked, dayTitle, DEFAULT_SHOWN, historyDays, kindsFor, timeOf } from "../features/tex/history/historyLines";
import { groupChatAt, historyFileChat } from "../features/tex/history/historyFile";
import { fixtureSource } from "../features/tex/page/texPageFixture";
import type { LedgerEntry } from "../features/tex/page/texPageTypes";

const at = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m).getTime();
const NOW = new Date(2026, 10, 2, 18, 0);

describe("the history's lines", () => {
  test("a person's text sits with the turn that answered it, each day in order, newest day first", () => {
    const entries: LedgerEntry[] = [
      { id: "b3", at: at(2, 9, 41), kind: "text", turn: "t2", from: { kind: "tex" }, text: "Dessert." },
      { id: "b2", at: at(2, 9, 41), kind: "tool", turn: "t2", name: "search", ok: true },
      { id: "b1", at: at(2, 9, 40), kind: "text", from: { kind: "person" }, text: "What do I bring?" },
      { id: "a2", at: at(1, 7, 58), kind: "text", turn: "t1", from: { kind: "tex" }, text: "Morning." },
      { id: "a1", at: at(1, 7, 58), kind: "note", turn: "t1", text: "check-in ran" },
    ];
    const days = historyDays(entries, NOW);
    expect(days.map((d) => d.title)).toEqual(["Today", "Yesterday"]);
    expect(days[0]!.turns).toHaveLength(1);
    expect(days[0]!.turns[0]!.lines.map((l) => [l.time, l.who, l.text])).toEqual([
      ["9:40 AM", "You", "What do I bring?"],
      ["", "", "search"],
      ["9:41 AM", "Tex", "Dessert."],
    ]);
    expect(days[1]!.turns[0]!.lines.map((l) => l.text)).toEqual(["check-in ran", "Morning."]);
  });

  test("a group names who sent each text, and says what a reply answers, a reaction and a picture", () => {
    const entries: LedgerEntry[] = [
      { id: "c3", at: at(2, 18, 15), kind: "text", event: "reaction", from: { kind: "person", name: "@mom" }, text: "👍" },
      { id: "c2", at: at(2, 18, 14), kind: "text", eid: "w2", replyTo: "w1", from: { kind: "person", name: "Seyi" }, text: "I'll do the rice." },
      { id: "c1", at: at(2, 18, 12), kind: "text", eid: "w1", event: "picture", from: { kind: "person", name: "Ada" }, text: "the list" },
    ];
    const lines = historyDays(entries, NOW, { group: true }).flatMap((d) => d.turns.flatMap((t) => t.lines));
    expect(lines.map((l) => [l.who, l.text, l.replyTo ?? null, l.reactions ?? null])).toEqual([
      ["Ada", "(sent a picture) the list", null, null],
      ["Seyi", "I'll do the rice.", "Ada: (sent a picture) the list", "👍 mom"],
    ]);
  });

  test("a reaction sits under the text it is on, never as a line, as in the mock; one taken back is gone", () => {
    const entries: LedgerEntry[] = [
      { id: "r5", at: at(2, 12, 5), kind: "text", event: "reaction", from: { kind: "person", name: "Ada" }, text: 'took back ❤️ on the message "Will do. I\'ll text you"' },
      { id: "r4", at: at(2, 12, 4), kind: "text", event: "reaction", from: { kind: "person", name: "Ada" }, text: '❤️ on the message "Will do. I\'ll text you"' },
      { id: "r3", at: at(2, 12, 3), kind: "text", event: "reaction", from: { kind: "person", name: "Mom" }, text: '👍 (yes) on Tex\'s message "Will do. I\'ll text you"' },
      { id: "r2", at: at(2, 12, 2), kind: "text", event: "reaction", from: { kind: "person", name: "Seyi" }, text: "👍" },
      { id: "r1", at: at(2, 12, 1), kind: "text", turn: "t1", from: { kind: "tex" }, text: "Will do. I'll text you Saturday." },
      { id: "r0", at: at(2, 12, 0), kind: "text", from: { kind: "person", name: "Seyi" }, text: "remind me Saturday" },
    ];
    const lines = historyDays(entries, NOW, { group: true }).flatMap((d) => d.turns.flatMap((t) => t.lines));
    expect(lines.map((l) => [l.who, l.text, l.reactions ?? null])).toEqual([
      ["Seyi", "remind me Saturday", null],
      ["Tex", "Will do. I'll text you Saturday.", "👍 Seyi, Mom"],
    ]);
  });

  test("a reaction whose text isn't in view stays a line of its own", () => {
    const lines = historyDays([{ id: "x", at: at(2, 9, 0), kind: "text", event: "reaction", from: { kind: "person" }, text: "👍" }], NOW).flatMap((d) => d.turns.flatMap((t) => t.lines));
    expect(lines.map((l) => l.text)).toEqual(["(reacted) 👍"]);
  });

  test("tool calls in a row are one line that opens to them; a single call stays a line", () => {
    const entries: LedgerEntry[] = [
      { id: "k6", at: at(2, 9, 6), kind: "text", turn: "t", from: { kind: "tex" }, text: "Done." },
      { id: "k5", at: at(2, 9, 5), kind: "tool", turn: "t", name: "write_note", ok: true },
      { id: "k4", at: at(2, 9, 4), kind: "said", turn: "t", text: "Writing it down." },
      { id: "k3", at: at(2, 9, 3), kind: "tool", turn: "t", name: "browse", ok: false },
      { id: "k2", at: at(2, 9, 2), kind: "tool", turn: "t", name: "vault_list", ok: true },
      { id: "k1", at: at(2, 9, 1), kind: "tool", turn: "t", name: "browse", ok: true },
    ];
    const lines = historyDays(entries, NOW)[0]!.turns[0]!.lines;
    expect(lines.map((l) => l.text)).toEqual(["3 tool calls · browse ×2, vault_list · 1 failed", "Writing it down.", "write_note", "Done."]);
    expect(lines[0]!.calls!.map((c) => c.id)).toEqual(["k1", "k2", "k3"]);
    expect(lines[2]!.calls).toBeUndefined();
  });

  test("background lines say what each is", () => {
    const entries: LedgerEntry[] = [
      { id: "n4", at: at(2, 9, 4), kind: "job", job: "j1", title: "Code transactions", state: "keep_going" },
      { id: "n3", at: at(2, 9, 3), kind: "mail_check", to: "jo@example.com", verdict: "stopped", why: "they said Thursday" },
      { id: "n2", at: at(2, 9, 2), kind: "advisor", question: "Is this right?" },
      { id: "n1", at: at(2, 9, 1), kind: "note", routine: "tex/routines/morning.md", text: "Sent the brief." },
    ];
    const lines = historyDays(entries, NOW).flatMap((d) => d.turns.flatMap((t) => t.lines));
    expect(lines.map((l) => l.text)).toEqual([
      "routine · tex/routines/morning · Sent the brief.",
      "advisor · asked: Is this right?",
      "mail checker · email to jo@example.com · stopped · they said Thursday",
      "job · Code transactions · keep going",
    ]);
  });

  test("days and kinds as the gateway is asked for them", () => {
    expect(kindsFor(DEFAULT_SHOWN)).toEqual(["text", "tool", "note", "advisor", "mail_check", "job"]);
    expect(kindsFor({ texts: false, tools: false, thinking: true, background: false })).toEqual(["thinking", "said"]);
    expect(dayAsked("today", "", NOW)).toBe("2026-11-02");
    expect(dayAsked("yesterday", "", new Date(2026, 10, 1, 9))).toBe("2026-10-31");
    expect(dayAsked("all", "", NOW)).toBeUndefined();
    expect(dayAsked("pick", "2026-10", NOW)).toBeUndefined();
    expect(dayAsked("pick", " 2026-10-30 ", NOW)).toBe("2026-10-30");
    expect(dayTitle("2026-10-31", NOW)).toBe("Saturday, Oct 31");
    expect(timeOf(at(2, 0, 5))).toBe("12:05 AM");
    expect(timeOf(at(2, 12, 30))).toBe("12:30 PM");
  });
});

describe("the history file opened in the app", () => {
  const own = { id: "ws_me", slug: "seyi" };
  test("the file names its chat: the viewer's own, a group home's, or none", () => {
    expect(historyFileChat("tex/history.ledger.json", own, own)).toEqual({ kind: "me" });
    expect(historyFileChat("tex/history.ledger.json", { id: "ws_ada", slug: "ada" }, own)).toEqual({ kind: "none" });
    expect(historyFileChat("tex/history.ledger.json", own, null)).toEqual({ kind: "none" });
    expect(historyFileChat("tex/groups/blue-lake-fox/history.ledger.json", { id: "ws_cl", slug: "context-lc" }, own)).toEqual({ kind: "group", folder: "tex/groups/blue-lake-fox" });
    expect(historyFileChat("tex/about.md", own, own)).toEqual({ kind: "none" });
    const chats = [
      { key: "me", name: "Just you" },
      { key: "g1", name: "Family", home: { context: "@context-lc", folder: "tex/groups/blue-lake-fox" } },
      { key: "g2", name: "Other", home: { context: "@elsewhere", folder: "tex/groups/red-hill-owl" } },
    ];
    expect(groupChatAt(chats, "context-lc", "tex/groups/blue-lake-fox")?.key).toBe("g1");
    expect(groupChatAt(chats, "@Context-LC", "tex/groups/blue-lake-fox")?.key).toBe("g1");
    expect(groupChatAt(chats, "elsewhere", "tex/groups/blue-lake-fox")).toBeNull();
    expect(groupChatAt(chats, "context-lc", "tex/groups/red-hill-owl")).toBeNull();
  });
});

let mockSource = fixtureSource();
jest.mock("../features/agent/useConsoleGrant", () => ({ useConsoleGrant: () => async () => ({ accessToken: "t" }) }));
// A new source each call, as the real one is: a view that builds it again reads again.
jest.mock("../features/tex/page/texPageSource", () => ({ gatewaySource: () => ({ ...mockSource }) }));

// Imported after the mocks, so the view reads the fixture.
import { HistoryFileView } from "../features/tex/history/HistoryFileView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const tick = () =>
  act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  });

describe("the history file's view", () => {
  test("a person's own file reads their own chat; a group home's reads that group, found by its home; another's reads none", async () => {
    const asked: string[] = [];
    const base = fixtureSource();
    mockSource = {
      ...base,
      ledger: (chat, q) => (asked.push(chat), base.ledger(chat, { ...q, day: undefined })),
      overview: async (chat) => {
        const r = await base.overview(chat);
        if (r.kind !== "ok") return r;
        return { kind: "ok", value: { ...r.value, chats: [{ key: "me", name: "Just you" }, { key: "g-team", name: "Team Night", home: { context: "@context-lc", folder: "tex/groups/blue-lake-fox" } }] } };
      },
    };
    const own = { id: "ws_me", slug: "seyi" };
    act(() => root.render(createElement(HistoryFileView, { path: "tex/history.ledger.json", workspace: own, own })));
    await tick();
    expect(asked).toEqual(["me"]);
    expect(container.textContent).toContain("what's on my calendar today?");
    // The console's data refreshing hands new rows and a new minter (the mock's is new each render): nothing is read again.
    act(() => root.render(createElement(HistoryFileView, { path: "tex/history.ledger.json", workspace: { ...own }, own: { ...own } })));
    await tick();
    expect(asked).toEqual(["me"]);

    act(() => root.render(createElement(HistoryFileView, { path: "tex/groups/blue-lake-fox/history.ledger.json", workspace: { id: "ws_cl", slug: "context-lc" }, own })));
    await tick();
    expect(asked.at(-1)).toBe("g-team");
    expect(container.textContent).toContain("History · Team Night");
    expect(container.textContent).toContain("Ada");

    asked.length = 0;
    act(() => root.render(createElement(HistoryFileView, { path: "tex/history.ledger.json", workspace: { id: "ws_ada", slug: "ada" }, own })));
    await tick();
    expect(asked).toEqual([]);
    expect(document.querySelector('[data-testid="history-file-not-yours"]')).not.toBeNull();

    act(() => root.render(createElement(HistoryFileView, { path: "tex/groups/red-hill-owl/history.ledger.json", workspace: { id: "ws_cl", slug: "context-lc" }, own })));
    await tick();
    expect(asked).toEqual([]);
    expect(document.querySelector('[data-testid="history-file-not-yours"]')).not.toBeNull();
  });
});
