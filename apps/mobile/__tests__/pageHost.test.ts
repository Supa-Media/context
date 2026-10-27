/**
 * The app's half of the page runtime (`features/console/files/pageView/pageHost.ts`):
 * what a page frame may say, and what each thing it says may do to the note.
 *
 * The frame draws a note anybody with write access wrote, so the app takes
 * nothing from it on trust. These pin the two halves of that: a message of any
 * other shape is dropped, and a well-formed message can still only change
 * words a reader sees, tick a task the note has, or pick an option a block
 * offers, against the copy of the note the frame was shown.
 *
 * Sabotage record (run as temporary edits and reverted):
 *   `pageChange` skips the `current !== shown` check          → "stale copy" fails
 *   `applyRunEdits` accepts any range, not only runs          → "front matter" and "comments block" fail
 *   `chooseOption` writes any option                          → "not an option" fails
 *   `pageFrameUrls` puts the local copy first in production   → "sites domain first" fails
 */

import { pageChange, pageFrameUrls, readPageMessage, type PageMessage } from "../features/console/files/pageView/pageHost";
import { parsePage } from "@context/shared/src/pages/index.cjs";

const NOTE = [
  "---",
  "title: Dinner for 40",
  "---",
  "",
  "# Dinner for 40",
  "",
  "Three caterers can do **Nov 8**.",
  "",
  "```choose",
  "- Casa Lola | $29",
  "- Ember & Oak | $33",
  "chosen:",
  "```",
  "",
  "- [ ] Book the caterer",
  "",
  "```comments",
  'k7f2 "Nov 8"',
  "- 2026-10-27T15:02:11Z @zay: Friday?",
  "```",
  "",
].join("\n");

const msg = (data: Record<string, unknown>) => readPageMessage({ channel: "context-page", ...data });

function runOf(source: string, words: string) {
  const page = parsePage(source);
  for (const node of page.nodes) {
    const runs = (node as { runs?: { text: string; from: number; to: number }[] }).runs ?? [];
    const run = runs.find((r) => r.text.includes(words));
    if (run) return run;
  }
  throw new Error(`no run with ${words}`);
}

describe("readPageMessage", () => {
  test("drops anything off the channel or of an unknown shape", () => {
    expect(readPageMessage({ type: "ready" })).toBeNull();
    expect(readPageMessage(null)).toBeNull();
    expect(msg({ type: "write", text: "x" })).toBeNull();
    expect(msg({ type: "edit", edits: [] })).toBeNull();
    expect(msg({ type: "edit", edits: [{ from: 5, to: 2, text: "x" }] })).toBeNull();
    expect(msg({ type: "edit", edits: [{ from: 1.5, to: 2, text: "x" }] })).toBeNull();
    expect(msg({ type: "comment", from: 1, to: 2, body: "   " })).toBeNull();
    expect(msg({ type: "reply", thread: "../x", body: "hi" })).toBeNull();
  });

  test("clamps a height and keeps the fields it knows", () => {
    expect(msg({ type: "height", height: 1e9 })).toEqual({ type: "height", height: 60_000 });
    expect(msg({ type: "task", at: 3, checked: true, extra: "x" })).toEqual({ type: "task", at: 3, checked: true });
  });
});

describe("pageChange", () => {
  test("an edit replaces exactly one run, escaped so typed punctuation stays words", () => {
    const run = runOf(NOTE, "Three caterers");
    const change = pageChange(NOTE, NOTE, { type: "edit", edits: [{ from: run.from, to: run.to, text: "Four *caterers* can do " }] }, "@dev2");
    expect(change).toEqual({ text: NOTE.replace("Three caterers can do ", "Four \\*caterers\\* can do ") });
  });

  test("an edit of the front matter or the comments block is refused", () => {
    const at = NOTE.indexOf("title:");
    expect(pageChange(NOTE, NOTE, { type: "edit", edits: [{ from: at, to: at + 6, text: "x" }] }, "@dev2")).toEqual({ error: "stale" });
    const log = NOTE.indexOf("@zay: Friday?");
    expect(pageChange(NOTE, NOTE, { type: "edit", edits: [{ from: log, to: log + 4, text: "x" }] }, "@dev2")).toEqual({ error: "stale" });
  });

  test("a message about a stale copy is refused, whatever it asks", () => {
    const run = runOf(NOTE, "Three caterers");
    // Changed after the run, so the run's range is still a run: only the copy check catches it.
    const newer = `${NOTE}A line a collaborator just typed.\n`;
    const edit: PageMessage = { type: "edit", edits: [{ from: run.from, to: run.to, text: "Hi" }] };
    expect(pageChange(newer, NOTE, edit, "@dev2")).toEqual({ error: "stale" });
  });

  test("a task is ticked at its own box only", () => {
    const at = NOTE.indexOf("- [ ] Book") + 3;
    expect(pageChange(NOTE, NOTE, { type: "task", at, checked: true }, "@dev2")).toEqual({ text: NOTE.replace("- [ ] Book", "- [x] Book") });
    expect(pageChange(NOTE, NOTE, { type: "task", at: at + 2, checked: true }, "@dev2")).toEqual({ error: "stale" });
  });

  test("a pick is one of the block's options, written as chosen:", () => {
    const block = NOTE.indexOf("```choose");
    expect(pageChange(NOTE, NOTE, { type: "choose", block, option: "Ember & Oak" }, "@dev2")).toEqual({ text: NOTE.replace("chosen:\n", "chosen: Ember & Oak\n") });
    expect(pageChange(NOTE, NOTE, { type: "choose", block, option: "title: hacked" }, "@dev2")).toEqual({ error: "not an option" });
  });

  test("a comment anchors words a reader sees, as the signed-in person", () => {
    const run = runOf(NOTE, "Three caterers");
    const change = pageChange(NOTE, NOTE, { type: "comment", from: run.from, to: run.from + 5, body: "Nice" }, "@dev2");
    expect("text" in change! && change.text).toMatch(/<!--c:[A-Za-z0-9_-]+-->Three<!--\/c:[A-Za-z0-9_-]+-->/);
    expect("text" in change! && change.text).toMatch(/@dev2: Nice/);
    expect(pageChange(NOTE, NOTE, { type: "comment", from: 0, to: 3, body: "Nice" }, "@dev2")).toEqual({ error: "stale" });
    expect(pageChange(NOTE, NOTE, { type: "comment", from: run.from, to: run.from + 5, body: "Nice" }, null)).toEqual({
      error: "This note can't take comments here.",
    });
  });
});

describe("pageFrameUrls", () => {
  test("production draws from the sites domain first, with the deployment's own copy as fallback", () => {
    expect(pageFrameUrls({ hostname: "context.lc", origin: "https://context.lc" }, "seyi")).toEqual([
      "https://seyi.ctxlc.site/_page/index.html",
      "https://context.lc/drawing-assets/page/index.html",
    ]);
  });

  test("an odd slug never becomes a hostname; other deployments use their own copy", () => {
    expect(pageFrameUrls({ hostname: "tex.lc", origin: "https://tex.lc" }, "a.b/c")[0]).toBe("https://page.ctxlc.site/_page/index.html");
    expect(pageFrameUrls({ hostname: "staging.context.lc", origin: "https://staging.context.lc" }, "seyi")).toEqual([
      "https://staging.context.lc/drawing-assets/page/index.html",
    ]);
  });
});
