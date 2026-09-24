/**
 * AN AGENT'S WRITE IN A DURABLE NOTE — who made it, and where it landed.
 *
 * The room names the agent on the committed frame; the client finds the span
 * from the Yjs event its own authorized read produced. These checks cover both
 * halves without a socket: the frame decoder, and the span arithmetic run
 * against a real `Y.Text` so the delta shapes are the library's and not a
 * fixture's idea of them.
 */

import { describe, expect, test } from "@jest/globals";
import * as Y from "yjs";
import { decodeServerFrame } from "../features/console/presence/protocol";
import { changedSpan, type TextDeltaOp } from "../features/console/presence/agentSpan";
import { createSharedDoc } from "../features/console/presence/sharedDoc";
import { toBase64 } from "../features/console/presence/sharedDoc";

const AGENT = { id: "a:0123456789abcdef", name: "Somebody's Claude", color: "#3b82f6" };

describe("a committed frame names the agent", () => {
  test("a well-formed agent is decoded", () => {
    const frame = decodeServerFrame(
      JSON.stringify({ t: "committed", documentId: "doc", etag: "c2.doc.1", agent: AGENT }),
    );
    expect(frame).toEqual({ t: "committed", documentId: "doc", etag: "c2.doc.1", agent: AGENT });
  });

  test("an agent id outside the room's shape names nobody", () => {
    // A seated member's id is a uuid. Accepting one here would let a
    // committed frame move somebody's own caret and relabel it.
    const frame = decodeServerFrame(
      JSON.stringify({
        t: "committed",
        documentId: "doc",
        etag: "c2.doc.1",
        agent: { ...AGENT, id: "5b0c2c1e-6c1a-4b7e-9f55-0d1f8b0c1a2b" },
      }),
    );
    expect(frame).toEqual({ t: "committed", documentId: "doc", etag: "c2.doc.1" });
  });

  test("a hostile name and colour are contained, not dropped", () => {
    const frame = decodeServerFrame(
      JSON.stringify({
        t: "committed",
        documentId: "doc",
        etag: "c2.doc.1",
        agent: { id: AGENT.id, name: "Evil\u202Ename\n", color: "red; background:url(x)" },
      }),
    );
    expect(frame?.t).toBe("committed");
    const agent = frame && frame.t === "committed" ? frame.agent : undefined;
    expect(agent?.name).not.toContain("\u202E");
    expect(agent?.name).not.toContain("\n");
    expect(agent?.color).toBeNull();
  });

  test("a frame with no agent is the ordinary change hint", () => {
    const frame = decodeServerFrame(JSON.stringify({ t: "committed", documentId: "doc", etag: "c2.doc.1" }));
    expect(frame).toEqual({ t: "committed", documentId: "doc", etag: "c2.doc.1" });
  });
});

/** Apply `edit` to a document holding `before`, and return the span the event reports. */
function spanOf(before: string, edit: (text: Y.Text) => void): { from: number; to: number } | null {
  const doc = new Y.Doc();
  const text = doc.getText("note");
  text.insert(0, before);
  let span: { from: number; to: number } | null = null;
  text.observe((event) => {
    span = changedSpan(event.delta as TextDeltaOp[]);
  });
  doc.transact(() => edit(text));
  return span;
}

describe("the span an agent's write touched", () => {
  test("an appended paragraph is exactly the new text", () => {
    const before = "# Plan\n\nFirst paragraph.\n";
    const added = "\nA paragraph an agent wrote.\n";
    expect(spanOf(before, (text) => text.insert(before.length, added))).toEqual({
      from: before.length,
      to: before.length + added.length,
    });
  });

  test("a replacement in the middle covers the inserted words", () => {
    const before = "price is TBD per month";
    const at = before.indexOf("TBD");
    expect(
      spanOf(before, (text) => {
        text.delete(at, 3);
        text.insert(at, "[PRICE]");
      }),
    ).toEqual({ from: at, to: at + "[PRICE]".length });
  });

  test("two separate edits are one span from the first to the last", () => {
    const before = "aaaa bbbb cccc";
    expect(
      spanOf(before, (text) => {
        text.insert(0, "X");
        text.insert(text.length, "Y");
      }),
    ).toEqual({ from: 0, to: before.length + 2 });
  });

  test("a pure deletion is a caret where the text was", () => {
    const before = "keep this, drop this";
    const at = before.indexOf(", drop this");
    expect(spanOf(before, (text) => text.delete(at, ", drop this".length))).toEqual({ from: at, to: at });
  });

  test("no change is no span", () => {
    expect(changedSpan([{ retain: 12 }])).toBeNull();
    expect(changedSpan([])).toBeNull();
  });
});

describe("only an authorized read counts as the agent's write", () => {
  test("applyRemote is recognised and a local edit is not", () => {
    const source = new Y.Doc();
    source.getText("note").insert(0, "from the bucket");
    const shared = createSharedDoc({});
    const origins: unknown[] = [];
    shared.doc.on("afterTransaction", (transaction: Y.Transaction) => origins.push(transaction.origin));
    shared.applyRemote(toBase64(Y.encodeStateAsUpdate(source)));
    shared.doc.transact(() => shared.text.insert(0, "typed "), "local");
    expect(shared.appliedRemotely?.(origins[0])).toBe(true);
    expect(shared.appliedRemotely?.(origins[1])).toBe(false);
    // A peer's live keystroke is applied with its own origin, never this one.
    expect(shared.appliedRemotely?.(Symbol("live-remote"))).toBe(false);
  });
});
