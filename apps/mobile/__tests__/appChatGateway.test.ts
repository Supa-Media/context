import { describe, expect, test } from "@jest/globals";
import {
  EDIT_SENTENCE,
  MAX_PICTURES,
  MAX_TEXT,
  REACT_SENTENCE,
  UNSEND_SENTENCE,
  editRequest,
  mergeRows,
  pictureRequest,
  readChat,
  readPictureHead,
  readReact,
  readSend,
  rowFrom,
  sendRequest,
  tapbackRequest,
  unsendRequest,
  type AppChatRow,
  type ChatLine,
  type PendingLine,
} from "../features/tex/chat/appChatGateway";
import { reactionsAfterTap, replyRefFor, serverRowOf, withReactions } from "../features/tex/chat/appChatLines";

/**
 * THE APP CHAT WIRE, FIELD BY FIELD.
 *
 * `/tex/app-chat` is the server half. Every row field the page draws is read
 * by name here, a malformed optional field is dropped rather than failing the
 * read, a malformed `ask` still fails it, and every failure is a sentence.
 * Pure: no DOM, no network.
 */

const PIC = "0123456789abcdef0123456789abcdef";
const PIC2 = "fedcba9876543210fedcba9876543210";
const SENTINEL = "zarquon-plumbago-9471-not-for-the-chat-page";

function row(over: Record<string, unknown> = {}) {
  return { id: "m_1", who: "tex", text: "hello", at: 1_700_000_000_000, kind: "text", ...over };
}

function serverRow(over: Partial<AppChatRow> = {}): AppChatRow {
  return { id: "m_1", who: "me", text: "hi", at: 1_000, kind: "text", ...over };
}

describe("rowFrom: the required fields", () => {
  test("a plain row keeps its id, who, text, time and kind", () => {
    expect(rowFrom(row())).toEqual({ id: "m_1", who: "tex", text: "hello", at: 1_700_000_000_000, kind: "text" });
  });

  test("a row missing a required field fails the read", () => {
    expect(rowFrom(row({ id: "" }))).toBeNull();
    expect(rowFrom(row({ who: "bot" }))).toBeNull();
    expect(rowFrom(row({ kind: "video" }))).toBeNull();
    expect(rowFrom(row({ text: 3 }))).toBeNull();
    expect(rowFrom(row({ at: -1 }))).toBeNull();
    expect(rowFrom(null)).toBeNull();
  });

  test("a sentinel the server did not name stays off the row", () => {
    const parsed = rowFrom(row({ [SENTINEL]: true, bookkeeping: SENTINEL }));
    expect(JSON.stringify(parsed)).not.toContain(SENTINEL);
  });
});

describe("rowFrom: pictures", () => {
  test("valid picture ids are kept in order", () => {
    expect(rowFrom(row({ kind: "picture", pics: [PIC, PIC2] }))?.pics).toEqual([PIC, PIC2]);
  });

  test("one malformed id drops the whole picture field, not the row", () => {
    const parsed = rowFrom(row({ kind: "picture", pics: [PIC, "../etc/passwd"] }));
    expect(parsed).not.toBeNull();
    expect(parsed?.pics).toBeUndefined();
  });

  test("uppercase hex and short ids are malformed", () => {
    expect(rowFrom(row({ pics: [PIC.toUpperCase()] }))?.pics).toBeUndefined();
    expect(rowFrom(row({ pics: ["abc"] }))?.pics).toBeUndefined();
    expect(rowFrom(row({ pics: "nope" }))?.pics).toBeUndefined();
  });
});

describe("rowFrom: replyTo", () => {
  test("id and words are kept", () => {
    expect(rowFrom(row({ replyTo: { id: "m_0", text: "earlier" } }))?.replyTo).toEqual({ id: "m_0", text: "earlier" });
  });

  test("an id alone is kept without words", () => {
    expect(rowFrom(row({ replyTo: { id: "m_0" } }))?.replyTo).toEqual({ id: "m_0" });
  });

  test("malformed words drop only the words", () => {
    expect(rowFrom(row({ replyTo: { id: "m_0", text: 5 } }))?.replyTo).toEqual({ id: "m_0" });
  });

  test("no id drops the whole reference", () => {
    expect(rowFrom(row({ replyTo: { id: "" } }))?.replyTo).toBeUndefined();
    expect(rowFrom(row({ replyTo: "m_0" }))?.replyTo).toBeUndefined();
  });
});

describe("rowFrom: flags", () => {
  test("edited, unsent and editable appear only when they are exactly true", () => {
    const parsed = rowFrom(row({ edited: true, unsent: true, editable: true }));
    expect(parsed?.edited).toBe(true);
    expect(parsed?.unsent).toBe(true);
    expect(parsed?.editable).toBe(true);
    const off = rowFrom(row({ edited: "yes", unsent: 1, editable: false }));
    expect(off?.edited).toBeUndefined();
    expect(off?.unsent).toBeUndefined();
    expect(off?.editable).toBeUndefined();
  });
});

describe("rowFrom: reactions", () => {
  test("each tapback keeps who and emoji", () => {
    expect(
      rowFrom(
        row({
          reactions: [
            { who: "me", emoji: "❤️" },
            { who: "tex", emoji: "👍" },
          ],
        }),
      )?.reactions,
    ).toEqual([
      { who: "me", emoji: "❤️" },
      { who: "tex", emoji: "👍" },
    ]);
  });

  test("one malformed tapback drops the whole field", () => {
    expect(rowFrom(row({ reactions: [{ who: "me", emoji: "👍" }, { who: "bot", emoji: "👍" }] }))?.reactions).toBeUndefined();
    expect(rowFrom(row({ reactions: [{ who: "me", emoji: "" }] }))?.reactions).toBeUndefined();
    expect(rowFrom(row({ reactions: [{ who: "me", emoji: "far-too-long-for-a-tapback" }] }))?.reactions).toBeUndefined();
    expect(rowFrom(row({ reactions: "👍" }))?.reactions).toBeUndefined();
  });

  test("a malformed reactions field never fails the row", () => {
    expect(rowFrom(row({ reactions: [null] }))).not.toBeNull();
  });
});

describe("rowFrom: ask", () => {
  test("an ask is kept with its id and open flag", () => {
    expect(rowFrom(row({ ask: { id: "ask_1", open: true } }))?.ask).toEqual({ id: "ask_1", open: true });
  });

  test("a malformed ask still fails the whole row", () => {
    expect(rowFrom(row({ ask: { id: "", open: true } }))).toBeNull();
    expect(rowFrom(row({ ask: { id: "ask_1", open: "yes" } }))).toBeNull();
    expect(rowFrom(row({ ask: null }))).toBeNull();
  });

  test("a row with every new field keeps all of them together", () => {
    const parsed = rowFrom(
      row({
        kind: "picture",
        pics: [PIC],
        replyTo: { id: "m_0" },
        edited: true,
        editable: true,
        reactions: [{ who: "tex", emoji: "❓" }],
        ask: { id: "ask_1", open: false },
      }),
    );
    expect(parsed).toEqual({
      id: "m_1",
      who: "tex",
      text: "hello",
      at: 1_700_000_000_000,
      kind: "picture",
      pics: [PIC],
      replyTo: { id: "m_0" },
      edited: true,
      editable: true,
      reactions: [{ who: "tex", emoji: "❓" }],
      ask: { id: "ask_1", open: false },
    });
  });
});

describe("sendRequest", () => {
  test("words are trimmed and a plain send carries nothing else", () => {
    expect(sendRequest("  hi  ")).toEqual({ op: "send", text: "hi" });
  });

  test("pictures and a reply ride along when given", () => {
    expect(sendRequest("look", { pictures: [PIC], replyTo: "m_0" })).toEqual({
      op: "send",
      text: "look",
      pictures: [PIC],
      replyTo: "m_0",
    });
  });

  test("pictures alone are a send", () => {
    expect(sendRequest("", { pictures: ["aGk="] })).toEqual({ op: "send", text: "", pictures: ["aGk="] });
  });

  test("nothing to send is null", () => {
    expect(sendRequest("   ")).toBeNull();
    expect(sendRequest("", { pictures: [] })).toBeNull();
  });

  test("the text limit is the route's", () => {
    expect(sendRequest("a".repeat(MAX_TEXT))).not.toBeNull();
    expect(sendRequest("a".repeat(MAX_TEXT + 1))).toBeNull();
  });

  test("more than the picture limit is null", () => {
    expect(sendRequest("x", { pictures: Array(MAX_PICTURES).fill("aGk=") })).not.toBeNull();
    expect(sendRequest("x", { pictures: Array(MAX_PICTURES + 1).fill("aGk=") })).toBeNull();
  });
});

describe("edit, unsend, tapback and picture builders", () => {
  test("editRequest trims and refuses empty or too long words", () => {
    expect(editRequest("m_1", "  new  ")).toEqual({ op: "edit", msgId: "m_1", text: "new" });
    expect(editRequest("m_1", "   ")).toBeNull();
    expect(editRequest("m_1", "a".repeat(MAX_TEXT + 1))).toBeNull();
  });

  test("unsendRequest names the row", () => {
    expect(unsendRequest("m_1")).toEqual({ op: "unsend", msgId: "m_1" });
  });

  test("tapbackRequest carries the emoji on the row", () => {
    expect(tapbackRequest("m_1", "‼️")).toEqual({ op: "react", msgId: "m_1", emoji: "‼️" });
  });

  test("pictureRequest names the picture", () => {
    expect(pictureRequest(PIC)).toEqual({ op: "picture", id: PIC });
  });
});

describe("readers", () => {
  test("a read that is not a 200 fails with the route's own sentence when it has one", () => {
    expect(readChat(503, { error: "Tex is resting. Try later." })).toEqual({
      kind: "failed",
      sentence: "Tex is resting. Try later.",
    });
  });

  test("an internal word from the route is not shown", () => {
    const read = readChat(500, { error: SENTINEL });
    expect(read.kind === "failed" && read.sentence).not.toContain(SENTINEL);
  });

  test("a read with one unreadable row fails the whole read", () => {
    const read = readChat(200, { rows: [row(), row({ ask: { id: "", open: true } })], typing: false });
    expect(read.kind).toBe("failed");
  });

  test("a good read reports the typing mark", () => {
    const read = readChat(200, { rows: [row()], typing: true });
    expect(read).toEqual({ kind: "listed", rows: [rowFrom(row())], typing: true });
  });

  test("a send answer without an id fails", () => {
    expect(readSend(200, {}).kind).toBe("failed");
    expect(readSend(200, { msgId: "m_9" })).toEqual({ kind: "sent", msgId: "m_9" });
  });

  test("react, edit and unsend answers have their own sentences", () => {
    expect(readReact(200, {})).toEqual({ kind: "reacted" });
    expect(readReact(500, null)).toEqual({ kind: "failed", sentence: REACT_SENTENCE });
    expect(readReact(500, null, EDIT_SENTENCE)).toEqual({ kind: "failed", sentence: EDIT_SENTENCE });
    expect(readReact(500, null, UNSEND_SENTENCE)).toEqual({ kind: "failed", sentence: UNSEND_SENTENCE });
    expect(EDIT_SENTENCE).toBe("That change did not go through. Nothing changed. Try again in a moment.");
  });

  test("a picture answer is accepted only as an image", () => {
    expect(readPictureHead(200, "image/jpeg")).toEqual({ kind: "image" });
    expect(readPictureHead(200, "IMAGE/PNG")).toEqual({ kind: "image" });
    expect(readPictureHead(200, "application/json").kind).toBe("failed");
    expect(readPictureHead(200, null).kind).toBe("failed");
    expect(readPictureHead(404, "image/png").kind).toBe("failed");
  });
});

function pending(over: Partial<PendingLine> = {}): PendingLine {
  return { pending: true, localId: "local-1", who: "me", text: "hi", at: 1_000, state: "sending", ...over };
}

describe("mergeRows", () => {
  test("a pending line with an id is replaced by the row with that id", () => {
    const merged = mergeRows([pending({ msgId: "m_9", text: "something else" })], [serverRow({ id: "m_9", text: "hi" })]);
    expect(merged.some((line) => "pending" in line)).toBe(false);
    expect(merged).toEqual([serverRow({ id: "m_9", text: "hi" })]);
  });

  test("a pending line with an id and no matching row stays", () => {
    const merged = mergeRows([pending({ msgId: "m_9" })], [serverRow({ id: "m_8" })]);
    expect(merged.filter((line) => "pending" in line)).toHaveLength(1);
  });

  test("a pending line with an id is not matched by text", () => {
    const merged = mergeRows([pending({ msgId: "m_9", text: "hi" })], [serverRow({ id: "m_8", text: "hi" })]);
    expect(merged.filter((line) => "pending" in line)).toHaveLength(1);
  });

  test("without an id, a pending line is matched by text, one row each", () => {
    const merged = mergeRows(
      [pending({ localId: "a", text: "same" }), pending({ localId: "b", text: "same", at: 1_001 })],
      [serverRow({ id: "m_1", text: "same" })],
    );
    expect(merged.filter((line) => "pending" in line)).toHaveLength(1);
    expect(merged.filter((line) => !("pending" in line))).toHaveLength(1);
  });

  test("a row the page already holds is replaced in place, not duplicated", () => {
    const first = serverRow({ id: "m_1", text: "old" });
    const merged = mergeRows([first], [serverRow({ id: "m_1", text: "new" })]);
    expect(merged).toEqual([serverRow({ id: "m_1", text: "new" })]);
  });

  test("rows the fresh read does not mention stay", () => {
    const merged = mergeRows([serverRow({ id: "m_0" })], [serverRow({ id: "m_1", at: 2_000 })]);
    expect(merged.map((line) => ("id" in line ? line.id : ""))).toEqual(["m_0", "m_1"]);
  });
});

describe("tapback toggling and line helpers", () => {
  test("a new tapback replaces the person's own and keeps Tex's", () => {
    const row = serverRow({ reactions: [{ who: "me", emoji: "👍" }, { who: "tex", emoji: "❓" }] });
    expect(reactionsAfterTap(row, "❤️")).toEqual([
      { who: "tex", emoji: "❓" },
      { who: "me", emoji: "❤️" },
    ]);
  });

  test("the same emoji the person already has is taken back", () => {
    const row = serverRow({ reactions: [{ who: "me", emoji: "👍" }, { who: "tex", emoji: "❓" }] });
    expect(reactionsAfterTap(row, "👍")).toEqual([{ who: "tex", emoji: "❓" }]);
  });

  test("a first tapback on a bare row adds one", () => {
    expect(reactionsAfterTap(serverRow(), "😂")).toEqual([{ who: "me", emoji: "😂" }]);
  });

  test("withReactions removes the field when the list is empty", () => {
    const row = serverRow({ reactions: [{ who: "me", emoji: "😂" }] });
    expect("reactions" in withReactions(row, [])).toBe(false);
    expect(withReactions(row, undefined)).toEqual(serverRow());
  });

  test("replyRefFor carries the words of a row on the page", () => {
    const lines: ChatLine[] = [serverRow({ id: "m_1", text: "earlier" }), serverRow({ id: "m_2", text: "" })];
    expect(replyRefFor(lines, "m_1")).toEqual({ id: "m_1", text: "earlier" });
    expect(replyRefFor(lines, "m_2")).toEqual({ id: "m_2" });
    expect(replyRefFor(lines, "m_404")).toEqual({ id: "m_404" });
  });

  test("serverRowOf never matches a pending line", () => {
    expect(serverRowOf([pending({ localId: "m_1" })], "m_1")).toBeUndefined();
  });
});
