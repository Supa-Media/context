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
 *
 * Applied, run, named test seen failing, reverted (2026-11-03):
 *  8. `HistoryFileLines` drawing `history.days` unreversed → "reads as a
 *     chat" fails.
 *  9. The filters moved inside the scroller → same test fails.
 * 10. `away` never set → "scrolled up, a Latest button" fails.
 *
 * Applied, run, named test seen failing, reverted (2026-11-04):
 * 11. `historyDays` drawing every entry of an event (no `firstOf` skip) → "a
 *     voice message heard later is one line" fails.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { dayAsked, dayTitle, DEFAULT_SHOWN, historyDays, jobCount, kindsFor, timeOf } from "../features/tex/history/historyLines";
import { groupChatAt, historyFileChat } from "../features/tex/history/historyFile";
import { displayName } from "../features/console/files/paths";
import { PARTS } from "../features/console/files/contextIcons/drawings";
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

  test("a voice message heard later is one line, in its words, where it came; a passed-on agent message says so (2026-11-04)", () => {
    const entries: LedgerEntry[] = [
      { id: "v4", at: at(2, 10, 3), kind: "text", turn: "t9", from: { kind: "tex" }, text: "Drafted it." },
      { id: "v3h", at: at(2, 10, 2), kind: "text", eid: "e1", event: "file", heard: "voice", from: { kind: "person" }, text: "Email Joe that we submitted it" },
      { id: "v2", at: at(2, 10, 2), kind: "tool", turn: "t9", name: "search", ok: true },
      { id: "v1", at: at(2, 10, 2), kind: "text", eid: "e1", event: "file", from: { kind: "person" }, text: "" },
      { id: "n1", at: at(2, 9, 55), kind: "note", text: "ChatGPT: Both connector submissions are started.", about: "(Not a text from them. Another of their agents asked you to get their attention, and you texted them what follows.)" },
    ];
    const lines = historyDays(entries, NOW).flatMap((d) => d.turns.flatMap((t) => t.lines));
    expect(lines.map((l) => l.text)).toEqual([
      "passed on from another agent · ChatGPT: Both connector submissions are started.",
      "(sent a voice message) Email Joe that we submitted it",
      "search",
      "Drafted it.",
    ]);
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

  test("a reply shows the message it answers in full, and the words kept with it when that message is out of view", () => {
    const long = "Drafted in the wrong account. Want me to save it in the other account, where the thread is? 👍 or 👎?";
    const entries: LedgerEntry[] = [
      { id: "q3", at: at(2, 9, 51), kind: "text", eid: "w3", replyTo: "w0", quoted: "An older message this view doesn't hold", from: { kind: "person" }, text: "I never sent a note?" },
      { id: "q2", at: at(2, 9, 48), kind: "text", eid: "w2", replyTo: "w1", quoted: long, from: { kind: "person" }, text: "what do you mean?" },
      { id: "q1", at: at(2, 9, 47), kind: "text", eid: "w1", turn: "t1", from: { kind: "tex" }, text: long },
    ];
    const lines = historyDays(entries, NOW).flatMap((d) => d.turns.flatMap((t) => t.lines)).filter((l) => l.entry.kind === "text");
    expect(lines.map((l) => [l.text, l.replyTo ?? null])).toEqual([
      [long, null],
      ["what do you mean?", `Tex: ${long}`],
      ["I never sent a note?", "An older message this view doesn't hold"],
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

  test("a judging of a draft says which draft, whether it went, the judges that failed and the draft (2026-11-05)", () => {
    const entries: LedgerEntry[] = [
      { id: "j2", at: at(2, 9, 3), kind: "judge", turn: "t", by: "gates", round: 1, went: true, text: "Here's the logo.", judges: [{ id: "heard_them", yes: 0.12, at: 0.7, passed: true }] },
      { id: "j1", at: at(2, 9, 2), kind: "judge", turn: "t", by: "gates", round: 0, went: false, text: "Here's the icon.", judges: [{ id: "heard_them", yes: 0.82, at: 0.7, passed: false }, { id: "finished", yes: 0.19, at: 0.35, passed: true }] },
    ];
    const lines = historyDays(entries, NOW)[0]!.turns[0]!.lines;
    expect(lines.map((l) => l.text)).toEqual([
      'judges · draft 1 · sent back · heard_them 0.82 ≥ 0.70 · 1 passed · "Here\'s the icon."',
      'judges · draft 2 · went out · all 1 passed · "Here\'s the logo."',
    ]);
    expect(kindsFor({ ...DEFAULT_SHOWN, tools: false })).not.toContain("judge");
    expect(kindsFor(DEFAULT_SHOWN)).toContain("judge");
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
      // A job is its own line, Tex · Minion 1, its state beside it.
      "Code transactions",
    ]);
    expect(lines[3]!.run).toMatchObject({ minion: 1, state: "running", steps: [] });
  });

  test("each job's work folds under one line a job, Tex · Minion 1, 2 in the order they began, its texts left in the chat", () => {
    const job = (id: string, title: string) => ({ jobId: id, jobTitle: title });
    // Newest first, as the gateway answers.
    const entries: LedgerEntry[] = [
      { id: "m4", at: at(2, 9, 30), kind: "job", turn: "c2", ...job("cut", "Book a haircut"), job: "cut", title: "Book a haircut", state: "stuck" },
      { id: "m3", at: at(2, 9, 29), kind: "text", turn: "c2", ...job("cut", "Book a haircut"), from: { kind: "tex" }, text: "I couldn't book it." },
      { id: "m2", at: at(2, 9, 28), kind: "tool", turn: "c2", ...job("cut", "Book a haircut"), name: "vault_fill", ok: false },
      { id: "b1", at: at(2, 9, 20), kind: "tool", turn: "b", ...job("brief", "Morning brief"), name: "calendar_events", ok: true },
      { id: "m1", at: at(2, 9, 10), kind: "tool", turn: "c1", ...job("cut", "Book a haircut"), name: "browse", ok: true },
      { id: "s1", at: at(2, 9, 5), kind: "job", turn: "t", job: "cut", title: "Book a haircut", state: "started" },
      { id: "t1", at: at(2, 9, 5), kind: "text", turn: "t", from: { kind: "tex" }, text: "On it." },
    ];
    const lines = historyDays(entries, NOW)[0]!.turns.flatMap((t) => t.lines);
    expect(lines.map((l) => [l.who, l.text])).toEqual([
      ["Tex", "On it."],
      ["Tex · Minion 1", "Book a haircut"],
      ["Tex · Minion 2", "Morning brief"],
      ["Tex · Minion 1", "I couldn't book it."],
    ]);
    const cut = lines[1]!.run!;
    expect(cut.steps.map((s) => s.id)).toEqual(["m1", "m2"]);
    expect(cut.state).toBe("stuck");
    expect(jobCount(cut)).toBe("2 tries · 2 steps");
    expect(lines[2]!.run!.state).toBeNull();
    expect(jobCount(lines[2]!.run!)).toBe("1 step");
    // One job's own page shows its work as lines, unfolded.
    expect(historyDays(entries, NOW, { fold: false })[0]!.turns.flatMap((t) => t.lines).some((l) => l.run)).toBe(false);
  });

  test("days and kinds as the gateway is asked for them", () => {
    expect(kindsFor(DEFAULT_SHOWN)).toEqual(["text", "tool", "judge", "note", "advisor", "mail_check", "job"]);
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
  test("is called History wherever its name is shown, and has a drawing of its own", () => {
    // Dev, 2026-11-03: "view history.ledger.json as “history” and also give it an image".
    expect(displayName("history.ledger.json")).toBe("History");
    expect(displayName("history.md")).toBe("history");
    expect(displayName("notes.ledger.json")).toBe("notes.ledger.json");
    expect(PARTS.tex_history.length).toBeGreaterThan(0);
  });

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
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("../features/agent/useConsoleGrant", () => ({ useConsoleGrant: () => async () => ({ accessToken: "t" }) }));
jest.mock("../features/tex/history/useSeesTurnTiming", () => ({ useSeesTurnTiming: () => false }));
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
    expect(document.querySelector('[data-testid="history-file-title"]')?.textContent).toBe("History");
    expect(document.querySelector('[data-testid="history-file-head"]')?.textContent).toContain("Team Night");
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

  test("reads as a chat: oldest day at the top, newest at the bottom, the title and filters above the scroller", async () => {
    // Dev, 2026-11-03: "start scrolled all the way to the bottom of the page ... keep the filters sticky".
    const base = fixtureSource();
    mockSource = { ...base, ledger: (chat, q) => base.ledger(chat, { ...q, day: undefined }) };
    const own = { id: "ws_me", slug: "seyi" };
    act(() => root.render(createElement(HistoryFileView, { path: "tex/history.ledger.json", workspace: own, own })));
    await tick();
    const scroll = document.querySelector('[data-testid="history-file-scroll"]')!;
    const head = document.querySelector('[data-testid="history-file-head"]')!;
    expect(scroll.contains(head)).toBe(false);
    expect(head.querySelector('[data-testid="tex-history-show-texts"]')).not.toBeNull();
    const days = [...scroll.querySelectorAll('[data-testid^="tex-history-day-"]')].map((d) => d.getAttribute("data-testid")!.slice("tex-history-day-".length));
    expect(days.length).toBeGreaterThan(1);
    expect(days).toEqual([...days].sort());
  });

  test("scrolled up, a Latest button goes back down; at the newest line there is none", async () => {
    const base = fixtureSource();
    mockSource = { ...base, ledger: (chat, q) => base.ledger(chat, { ...q, day: undefined }) };
    const own = { id: "ws_me", slug: "seyi" };
    act(() => root.render(createElement(HistoryFileView, { path: "tex/history.ledger.json", workspace: own, own })));
    await tick();
    expect(document.querySelector('[data-testid="history-file-latest"]')).toBeNull();
    const scroll = document.querySelector('[data-testid="history-file-scroll"]') as HTMLElement;
    const at = (top: number) => {
      Object.defineProperty(scroll, "scrollHeight", { configurable: true, value: 2000 });
      Object.defineProperty(scroll, "clientHeight", { configurable: true, value: 500 });
      Object.defineProperty(scroll, "offsetHeight", { configurable: true, value: 500 });
      scroll.scrollTop = top;
      act(() => {
        scroll.dispatchEvent(new Event("scroll"));
      });
    };
    at(200);
    await tick();
    expect(document.querySelector('[data-testid="history-file-latest"]')).not.toBeNull();
    // Past the scroller's throttle, so the second scroll is heard.
    await act(() => new Promise((r) => setTimeout(r, 120)));
    at(1500);
    await tick();
    expect(document.querySelector('[data-testid="history-file-latest"]')).toBeNull();
  });

  test("a new line arrives as it is written: the chat's live feed is heard, and the newest page read again", async () => {
    // Dev, 2026-11-03: "are we making sure we are opening a websocket for realtime updates?"
    const base = fixtureSource();
    let extra: { id: string; at: number; kind: string; seq: number; [k: string]: unknown }[] = [];
    let patch: ((p: { section: string }) => void) | null = null;
    mockSource = {
      ...base,
      ledger: async (chat, q) => {
        const r = await base.ledger(chat, { ...q, day: undefined });
        return r.kind === "ok" ? { kind: "ok", value: { ...r.value, entries: [...extra, ...r.value.entries] } } : r;
      },
      live: (_chat, onPatch, onLive) => {
        patch = onPatch;
        onLive(true);
        return { close: () => void (patch = null), watch: () => {} } as never;
      },
    };
    const own = { id: "ws_me", slug: "seyi" };
    act(() => root.render(createElement(HistoryFileView, { path: "tex/history.ledger.json", workspace: own, own })));
    await tick();
    expect(patch).not.toBeNull();
    expect(container.textContent).not.toContain("Just landed");
    const now = Date.now();
    extra = [{ id: "new-1", at: now, seq: 9_999, kind: "text", from: { kind: "person", name: "Ada" }, text: "Just landed" }];
    act(() => patch!({ section: "behind" }));
    await act(() => new Promise((r) => setTimeout(r, 500)));
    await tick();
    expect(container.textContent).toContain("Just landed");
  });
});
