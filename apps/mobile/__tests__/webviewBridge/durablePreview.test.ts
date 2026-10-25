/**
 * @jest-environment jsdom
 */

/**
 * A DURABLE NOTE IS NEVER AN EMPTY PAGE WHILE ITS SHARED COPY LOADS.
 *
 * Dev2, 2026-10-16: kings-18 opened on the phone with its name, its property
 * chips and "Saved in your bucket", and nothing in between. The note was a
 * durable (`c2.`) note, so the host put the editor in durable mode and sent no
 * text at all until the collaboration snapshot arrived — a second round trip
 * after the read that had already put the note on screen. A freshly mounted
 * guest has an empty buffer, so the page was blank for as long as that took.
 *
 * Now the host sends the bucket's text as a read-only `preview` until the
 * snapshot is bound, and the snapshot replaces it when it lands.
 */

import { describe, expect, test } from "@jest/globals";
import { Y, createHostBridge, mountGuest } from "./fixtures";

const encoded = (update: Uint8Array): string => {
  let binary = "";
  for (const byte of update) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const seeded = (text: string): string => {
  const doc = new Y.Doc();
  doc.getText("note").insert(0, text);
  return encoded(Y.encodeStateAsUpdate(doc));
};

function harness() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  let deliver: (raw: string) => void = () => {};
  const changes: string[] = [];
  const updates: string[] = [];
  const host = createHostBridge((raw) => deliver(raw), {
    onChange: (text) => changes.push(text),
    onSave: () => {},
    onCollaborationUpdate: (_documentId, update) => updates.push(update),
  });
  const mount = () =>
    mountGuest(
      root,
      {
        post: (message) => host.receive(JSON.stringify(message)),
        listen: (handler) => {
          deliver = handler;
        },
        schedule: () => {},
      },
      document.documentElement,
    );
  return { host, mount, changes, updates };
}

describe("a durable note while its snapshot loads", () => {
  test("a guest mounted before the snapshot draws the bucket's text, read-only", () => {
    const { host, mount, changes, updates } = harness();
    host.setEditable(true);
    host.setCrdtMode(true);
    host.setCrdtSnapshot(null);
    host.setCrdtPreview("# kings-18\n\nSennacherib comes against Jerusalem.");
    const guest = mount();

    expect(guest.view.state.doc.toString()).toBe("# kings-18\n\nSennacherib comes against Jerusalem.");
    expect(guest.view.state.readOnly).toBe(true);
    expect(changes).toEqual([]);
    expect(updates).toEqual([]);
  });

  test("a preview set after the guest is listening is drawn at once", () => {
    const { host, mount } = harness();
    host.setCrdtMode(true);
    const guest = mount();
    expect(guest.view.state.doc.toString()).toBe("");

    host.setCrdtPreview("words");
    expect(guest.view.state.doc.toString()).toBe("words");
    expect(guest.view.state.readOnly).toBe(true);
  });

  test("the snapshot replaces the preview and releases editing, without an update", () => {
    const { host, mount, changes, updates } = harness();
    host.setEditable(true);
    host.setCrdtMode(true);
    host.setCrdtPreview("old words");
    const guest = mount();

    host.setCrdtSnapshot({ documentId: "doc-1", update: seeded("shared words") });
    expect(guest.view.state.doc.toString()).toBe("shared words");
    expect(guest.view.state.readOnly).toBe(false);
    expect(changes).toEqual([]);
    expect(updates).toEqual([]);
  });

  test("a preview never replaces a bound snapshot", () => {
    const { host, mount } = harness();
    host.setEditable(true);
    host.setCrdtMode(true);
    host.setCrdtSnapshot({ documentId: "doc-1", update: seeded("shared words") });
    const guest = mount();

    host.setCrdtPreview("stale bucket words");
    expect(guest.view.state.doc.toString()).toBe("shared words");
  });

  /*
    Dev2, 2026-10-18: kings-20 opened as "Title" and nothing else, again. The
    editor is kept between notes, so a note opened a second time asked for the
    same preview it had sent before; the reset that unbound the last snapshot
    had emptied the guest, and the bridge skipped the preview as already sent.
  */
  test("a note opened again after a reset draws its words, though they are the same as last time", () => {
    const { host, mount } = harness();
    host.setEditable(true);
    host.setCrdtMode(true);
    const guest = mount();
    host.setCrdtPreview("kings-20 words");
    host.setCrdtSnapshot({ documentId: "doc-20", update: seeded("kings-20 words") });
    // Away and back: the snapshot is unbound while the next one loads.
    host.setCrdtSnapshot(null);
    host.setCrdtPreview("kings-20 words");
    expect(guest.view.state.doc.toString()).toBe("kings-20 words");
    expect(guest.view.state.readOnly).toBe(true);
  });

  test("leaving legacy mode for a durable note draws the preview, even one sent before", () => {
    const { host, mount } = harness();
    host.setCrdtMode(true);
    const guest = mount();
    host.setCrdtPreview("durable words");
    host.setCrdtMode(false);
    host.setDoc("legacy words");
    host.setCrdtMode(true);
    host.setCrdtSnapshot(null);
    host.setCrdtPreview("durable words");
    expect(guest.view.state.doc.toString()).toBe("durable words");
  });

  /*
    Dev2, 2026-10-25: offline, "the cursor just doesn't show up". A durable
    note with no snapshot on the device becomes an offline draft
    (`offlineDraft.ts`), and the host hands the guest the same words as an
    editable document. The words equal the preview, so the bridge must not
    skip them as an echo: the guest has to leave durable mode to take typing.
  */
  test("an offline draft over the preview's own words is editable", () => {
    const { host, mount, changes, updates } = harness();
    host.setEditable(true);
    host.setDoc("same words");
    host.setCrdtMode(true);
    host.setCrdtSnapshot(null);
    host.setCrdtPreview("same words");
    const guest = mount();
    expect(guest.view.state.readOnly).toBe(true);

    host.setDoc("same words", "");
    host.setCrdtMode(false);
    expect(guest.view.state.doc.toString()).toBe("same words");
    expect(guest.view.state.readOnly).toBe(false);
    expect(changes).toEqual([]);
    expect(updates).toEqual([]);
  });

  test("a legacy (non-durable) note is not touched by a preview", () => {
    const { host, mount } = harness();
    host.setDoc("legacy words");
    const guest = mount();

    host.setCrdtPreview("preview words");
    expect(guest.view.state.doc.toString()).toBe("legacy words");
  });
});
