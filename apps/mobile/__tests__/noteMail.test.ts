/**
 * Mail in the editor (`files/mail/`): the log at the end of a note, folded to
 * one line, opened in place, and written to from a box at its end.
 *
 * The format and the gateway's half are covered in
 * `apps/mcp/test/noteMail.test.mjs`. What matters here is that the block is
 * out of sight and out of the caret's way, that the folded line says what is
 * there, and that sending is one appended line signed by the viewer.
 */

import { describe as group, expect, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { parseMail } from "@context/shared/src/mail.cjs";
import { comments } from "../features/console/files/comments/extension";
import { mailOpen, mailParsed, noteMail, sendTransaction, setMailOpen } from "../features/console/files/mail/extension";
import { foldedSummary, recipients, timeLabel } from "../features/console/files/mail/model";

const NOTE = [
  "# Launch plan",
  "",
  "Ship on Tuesday.",
  "",
  "```mail",
  "- 2026-10-15T09:40:00.000Z lead (Claude) joined",
  "- 2026-10-15T09:40:30.000Z lead (Claude) to everyone: We check mail every 10 minutes.",
  "- 2026-10-15T09:41:00.000Z builder (Codex) joined",
  "- 2026-10-15T09:42:00.000Z builder (Codex) to lead: Got it.",
  "    Starting on pricing.",
  "```",
  "",
].join("\n");

function stateFor(doc: string, author: string | null = "@seyi", readOnly = false) {
  return EditorState.create({
    doc,
    extensions: [comments({ author: () => author }), noteMail(), EditorState.readOnly.of(readOnly)],
  });
}

group("the folded line", () => {
  const { events } = parseMail(NOTE);
  const now = Date.parse("2026-10-15T09:46:00.000Z");

  test("counts messages, not joins, and names the last sender", () => {
    expect(foldedSummary(events, now)).toBe("Mail · 2 · last from builder 4 min ago");
  });

  test("says who joined when nobody has written yet", () => {
    const joins = events.filter((event) => event.kind === "joined");
    expect(foldedSummary(joins, now)).toBe("Mail · lead and builder joined");
  });

  test("a time today is the clock; another day carries its date", () => {
    const today = timeLabel("2026-10-15T09:42:00.000Z", now);
    expect(today).toMatch(/\d/);
    expect(today).not.toMatch(/Oct/);
    expect(timeLabel("2026-10-01T09:42:00.000Z", now)).toMatch(/Oct/);
  });

  test("a message can go to everyone or anybody who joined", () => {
    expect(recipients(events)).toEqual(["everyone", "lead", "builder"]);
  });
});

group("the editor", () => {
  test("parses the block and starts folded", () => {
    const state = stateFor(NOTE);
    expect(state.field(mailParsed).events).toHaveLength(4);
    expect(state.field(mailOpen)).toBe(false);
    expect(state.update({ effects: setMailOpen.of(true) }).state.field(mailOpen)).toBe(true);
  });

  test("sending appends one line before the closing fence, signed with the viewer's handle", () => {
    const state = stateFor(NOTE);
    const spec = sendTransaction(state, "Keep it on Tuesday.", "everyone", "2026-10-15T09:50:00.000Z");
    expect("error" in spec).toBe(false);
    const after = state.update(spec as never).state.doc.toString();
    expect(after).toBe(
      NOTE.replace(
        "    Starting on pricing.\n```",
        "    Starting on pricing.\n- 2026-10-15T09:50:00.000Z @seyi to everyone: Keep it on Tuesday.\n```",
      ),
    );
    expect(after.startsWith(NOTE.slice(0, NOTE.indexOf("```mail")))).toBe(true);
  });

  test("to one name, and only a name that joined", () => {
    const state = stateFor(NOTE);
    const to = sendTransaction(state, "Thanks", "builder", "2026-10-15T09:50:00.000Z");
    expect(state.update(to as never).state.doc.toString()).toContain("@seyi to builder: Thanks");
    expect(sendTransaction(state, "hi", "reviewer")).toEqual({ error: "Nobody joined this note's mail as reviewer." });
  });

  test("nobody signed in, a read-only note, or an empty message sends nothing", () => {
    expect("error" in sendTransaction(stateFor(NOTE, null), "hi", "everyone")).toBe(true);
    expect("error" in sendTransaction(stateFor(NOTE, "@seyi", true), "hi", "everyone")).toBe(true);
    expect("error" in sendTransaction(stateFor(NOTE), "   ", "everyone")).toBe(true);
  });

  test("a note with no mail has no mail section", () => {
    expect(stateFor("# Plain\n").field(mailParsed).block).toBeNull();
  });
});
