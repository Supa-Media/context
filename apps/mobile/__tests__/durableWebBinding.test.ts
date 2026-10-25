/**
 * @jest-environment jsdom
 */

/**
 * The web editor binds a durable note's shared document once its controller
 * is ready, never on the document's text alone.
 *
 * Before that the editor can be holding an offline draft
 * (`collaboration/offlineDraft.ts`), and the server's text lands in the
 * shared document a moment before the draft is merged into it. Bound on
 * text, the editor replaced the draft's words with the server's and took
 * keystrokes into a document that was not queueing them.
 */
import { describe, expect, test } from "@jest/globals";
import { Compartment } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createSharedDoc, type SharedDoc } from "../features/console/presence/sharedDoc";
import { bindSharedDocument } from "../features/console/files/liveEditorWeb/sharedBinding";

function setup(durable: boolean) {
  const collab = new Compartment();
  const view = new EditorView({ doc: "my offline draft", extensions: [collab.of([])], parent: document.body });
  const shared = createSharedDoc({});
  const settledRef = { current: false };
  const bound: { current: SharedDoc | null } = { current: null };
  const bindIfWaiting: { current: (() => void) | null } = { current: null };
  const presence = {
    shared,
    settled: false,
    ...(durable ? { collaboration: { ready: false } } : {}),
  } as never;
  const cleanup = bindSharedDocument({
    view: { current: view },
    collab: { current: collab },
    bound,
    bindIfWaiting,
    latestValue: { current: "my offline draft" },
    settledRef,
    presence,
  });
  return { view, shared, settledRef, bound, bindIfWaiting, cleanup };
}

describe("binding a durable note on the web", () => {
  test("text in the shared document before ready does not bind or replace the draft", () => {
    const { view, shared, settledRef, bound, bindIfWaiting, cleanup } = setup(true);
    shared.doc.transact(() => shared.text.insert(0, "server words"), "server");
    expect(bound.current).toBeNull();
    expect(view.state.doc.toString()).toBe("my offline draft");

    // The draft merged, the controller ready: now it binds, to the merged text.
    shared.doc.transact(() => shared.text.insert(shared.text.length, " + my offline draft"), "server");
    settledRef.current = true;
    bindIfWaiting.current?.();
    expect(bound.current).toBe(shared);
    expect(view.state.doc.toString()).toBe("server words + my offline draft");
    cleanup?.();
    view.destroy();
    shared.destroy();
  });

  test("a live room with no durable controller still binds as soon as it has text", () => {
    const { view, shared, bound, cleanup } = setup(false);
    shared.doc.transact(() => shared.text.insert(0, "room words"), "server");
    expect(bound.current).toBe(shared);
    expect(view.state.doc.toString()).toBe("room words");
    cleanup?.();
    view.destroy();
    shared.destroy();
  });
});
