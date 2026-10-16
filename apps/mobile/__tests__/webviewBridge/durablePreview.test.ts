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

  test("a legacy (non-durable) note is not touched by a preview", () => {
    const { host, mount } = harness();
    host.setDoc("legacy words");
    const guest = mount();

    host.setCrdtPreview("preview words");
    expect(guest.view.state.doc.toString()).toBe("legacy words");
  });
});
