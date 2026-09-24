/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { PROTOCOL_VERSION, Y, connect, createHostBridge, mountGuest, NOTE } from "./fixtures";

describe("text crosses and comes back unchanged", () => {
  test("the note the host set is the note the editor holds", () => {
    const w = connect({ doc: NOTE, editable: true });
    expect(w.view.state.doc.toString()).toBe(NOTE);
    w.destroy();
  });

  /**
   * THE test this file exists for.
   *
   * Opening a note must not produce a change. If it does, `editorReducer` marks
   * the draft dirty, the bottom bar lights up its Save, and a person who opened
   * a file to read it writes CodeMirror's idea of the file back over their own.
   */
  test("opening a note produces no change at all", () => {
    const w = connect({ doc: NOTE, editable: true });
    w.flush();
    expect(w.changes).toEqual([]);
    w.destroy();
  });

  test("nor does moving the caret through the frontmatter", () => {
    const w = connect({ doc: NOTE, editable: true });
    // Into the YAML, out the other side, and into the heading — every position
    // that changes which markup is revealed.
    for (const anchor of [0, 4, 20, NOTE.indexOf("# Title"), NOTE.indexOf("bold")]) {
      w.view.dispatch({ selection: { anchor } });
    }
    w.flush();
    expect(w.changes).toEqual([]);
    expect(w.view.state.doc.toString()).toBe(NOTE);
    w.destroy();
  });

  test("one typed character comes back as exactly that character inserted", () => {
    const w = connect({ doc: NOTE, editable: true });
    const at = NOTE.indexOf("body.") + "body".length;
    w.view.dispatch({ changes: { from: at, insert: "!" }, selection: { anchor: at + 1 } });
    w.flush();

    const expected = `${NOTE.slice(0, at)}!${NOTE.slice(at)}`;
    expect(w.changes).toEqual([expected]);
    // The frontmatter is byte-identical, fence to fence, including the newline
    // the closing fence sits on.
    expect(expected.slice(0, NOTE.indexOf("---\n\n") + 4)).toBe(
      NOTE.slice(0, NOTE.indexOf("---\n\n") + 4),
    );
    w.destroy();
  });

  test("a trailing newline survives the crossing", () => {
    // CodeMirror joins lines with "\n", so a document whose last character is a
    // newline has an empty final line. Losing it would rewrite every file in a
    // bucket the first time somebody typed in it.
    const w = connect({ doc: "one\ntwo\n", editable: true });
    w.view.dispatch({ changes: { from: 3, insert: "!" } });
    w.flush();
    expect(w.changes).toEqual(["one!\ntwo\n"]);
    w.destroy();
  });
});

describe("the native durable Yjs bridge", () => {
  const encoded = (update: Uint8Array): string => {
    let binary = "";
    for (const byte of update) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  const decoded = (value: string): Uint8Array => {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  };

  const seeded = (text: string): { doc: Y.Doc; update: string } => {
    const doc = new Y.Doc();
    doc.getText("note").insert(0, text);
    return { doc, update: encoded(Y.encodeStateAsUpdate(doc)) };
  };

  test("keeps two rapid local edits and an interleaved remote update exactly once", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const frames: (() => void)[] = [];
    let deliver: (raw: string) => void = () => {};
    const updates: string[] = [];
    const host = createHostBridge((raw) => deliver(raw), {
      onChange: () => {},
      onSave: () => {},
      onCollaborationUpdate: (_documentId, update) => updates.push(update),
    });
    const initial = seeded("base");
    host.setCrdtMode(true);
    host.setEditable(true);
    host.setCrdtSnapshot({ documentId: "doc-1", update: initial.update });
    const guest = mountGuest(
      root,
      {
        post: (message) => host.receive(JSON.stringify(message)),
        listen: (handler) => {
          deliver = handler;
        },
        schedule: (flush) => frames.push(flush),
      },
      document.documentElement,
    );

    expect(guest.view.state.doc.toString()).toBe("base");
    expect(guest.view.state.readOnly).toBe(false);
    guest.view.dispatch({ changes: { from: 4, insert: "-one" } });
    guest.view.dispatch({ changes: { from: guest.view.state.doc.length, insert: "-two" } });
    expect(updates).toHaveLength(2);

    // A remote client writes against the same canonical seed while both local
    // updates are still in flight. Applying its full state must not echo back
    // as a third local update.
    const remote = new Y.Doc();
    Y.applyUpdate(remote, decoded(initial.update));
    remote.getText("note").insert(4, "-remote");
    host.setCrdtSnapshot({ documentId: "doc-1", update: encoded(Y.encodeStateAsUpdate(remote)) });
    expect(updates).toHaveLength(2);

    const server = new Y.Doc();
    Y.applyUpdate(server, decoded(initial.update));
    Y.applyUpdate(server, decoded(encoded(Y.encodeStateAsUpdate(remote))));
    for (const update of updates) {
      Y.applyUpdate(server, decoded(update));
    }
    const canonical = encoded(Y.encodeStateAsUpdate(server));
    host.setCrdtSnapshot({ documentId: "doc-1", update: canonical });
    expect(guest.view.state.doc.toString()).toBe(server.getText("note").toString());

    guest.destroy();
    root.remove();
    initial.doc.destroy();
    remote.destroy();
    server.destroy();
    void frames;
  });

  test("releases editability after seeding, then detaches stale state while navigating", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    let deliver: (raw: string) => void = () => {};
    const updates: Array<{ documentId: string; update: string }> = [];
    const changes: string[] = [];
    const host = createHostBridge((raw) => deliver(raw), {
      onChange: (text) => changes.push(text),
      onSave: () => {},
      onCollaborationUpdate: (documentId, update) => updates.push({ documentId, update }),
    });
    const initial = seeded("base");
    host.setCrdtMode(true);
    host.setEditable(true);
    host.setCrdtSnapshot({ documentId: "doc-1", update: initial.update });
    const guest = mountGuest(
      root,
      {
        post: (message) => host.receive(JSON.stringify(message)),
        listen: (handler) => {
          deliver = handler;
        },
      },
      document.documentElement,
    );

    expect(guest.view.state.readOnly).toBe(false);

    // This is the React effect ordering that used to regress: after the
    // canonical snapshot, a repeated editable=true must not be translated to
    // editable=false merely because durable mode is active.
    host.setEditable(false);
    host.setEditable(true);
    expect(guest.view.state.readOnly).toBe(false);

    // A loading/new-note transition explicitly tears down the old binding and
    // ignores any stale legacy frame that might still be in flight.
    host.setCrdtSnapshot(null);
    expect(guest.view.state.readOnly).toBe(true);
    host.receive(JSON.stringify({ v: PROTOCOL_VERSION, type: "change", text: "stale" }));
    host.receive(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: "crdtUpdate",
        documentId: "doc-1",
        update: "AAAA",
      }),
    );
    expect(changes).toEqual([]);
    const beforeStaleEdit = guest.view.state.doc.toString();
    guest.view.dispatch({ changes: { from: beforeStaleEdit.length, insert: "-ignored" } });
    expect(guest.view.state.doc.toString()).toBe(beforeStaleEdit);
    expect(updates).toHaveLength(0);

    const next = seeded("next");
    host.setCrdtSnapshot({ documentId: "doc-2", update: next.update });
    expect(guest.view.state.doc.toString()).toBe("next");
    expect(guest.view.state.readOnly).toBe(false);
    guest.view.dispatch({ changes: { from: 4, insert: "!" } });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.documentId).toBe("doc-2");

    guest.destroy();
    root.remove();
    initial.doc.destroy();
    next.doc.destroy();
  });

  test("durable guest binds the complete markdown, including frontmatter", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    let deliver: (raw: string) => void = () => {};
    const updates: string[] = [];
    const source = "---\ntitle: Shared note\n---\n\nBody\n";
    const initial = seeded(source);
    const host = createHostBridge((raw) => deliver(raw), {
      onChange: () => {},
      onSave: () => {},
      onCollaborationUpdate: (_documentId, update) => updates.push(update),
    });
    host.setCrdtMode(true);
    host.setEditable(true);
    host.setCrdtSnapshot({ documentId: "frontmatter-doc", update: initial.update });
    const guest = mountGuest(
      root,
      {
        post: (message) => host.receive(JSON.stringify(message)),
        listen: (handler) => {
          deliver = handler;
        },
      },
      document.documentElement,
    );

    expect(guest.view.state.doc.toString()).toBe(source);
    guest.view.dispatch({ changes: { from: source.length - 1, insert: "!" } });
    expect(updates).toHaveLength(1);

    // The native update is a Yjs operation over the full note, so a server
    // applying it preserves the metadata prefix and body in one coordinate
    // space. A body-only bridge would either lose the prefix or duplicate it.
    const server = new Y.Doc();
    Y.applyUpdate(server, decoded(initial.update));
    Y.applyUpdate(server, decoded(updates[0]!));
    expect(server.getText("note").toString()).toBe("---\ntitle: Shared note\n---\n\nBody!\n");
    expect(guest.view.state.doc.toString()).toBe(server.getText("note").toString());

    guest.destroy();
    root.remove();
    initial.doc.destroy();
    server.destroy();
  });
});
