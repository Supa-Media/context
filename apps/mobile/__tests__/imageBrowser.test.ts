/**
 * @jest-environment jsdom
 */

/**
 * IMAGES, THROUGH THE HOOK THAT TALKS TO THE BUCKET.
 *
 * `imageBlock.test.ts` proves what a gesture decides; this proves what the
 * console does about it. Three properties, and two of them are invisible in the
 * editor:
 *
 *  1. **The cache is what makes a row survive a keystroke.** A widget asks for
 *     its bytes on every rebuild, and the decoration set is rebuilt on every
 *     keystroke and every cursor move — so without a cache, typing in a note
 *     with three images in it is three round trips per character. The key is a
 *     content hash, which is what makes caching it forever correct rather than
 *     merely fast.
 *  2. **An encrypted note refuses, in words.** Its text is encrypted on the
 *     device and an image's bytes are not, so storing one would put in the clear
 *     what encryption was turned on to hide, under a name the note spells out.
 *  3. **The note is the hook's to supply, not the widget's.** An image borrows
 *     its visibility from the notes that reference it, so `loadImage` names the
 *     open note itself: a widget that passed one would be choosing which note
 *     vouches for the image it is asking for.
 */

import { beforeEach, afterEach, describe, expect, jest, test } from "@jest/globals";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { ConvexError } from "convex/values";

import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing } from "../features/console/files/types";

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};
const calls: { name: string; args: unknown }[] = [];

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  const record = (ref: never) => {
    const name = getFunctionName(ref);
    bound[name] ??= (args: never) => {
      calls.push({ name, args });
      return actions[name]!(args);
    };
    return bound[name];
  };
  return { useAction: record, useMutation: record, useQuery: () => undefined };
});

import { useFileBrowser } from "../features/console/files/useFileBrowser";

const NOTE = "1-projects/note.md";
const OTHER = "1-projects/other.md";
const KEY = "paste-4b2c9f1a.png";

function entry(path: string, kind: "file" | "folder") {
  return {
    kind,
    path,
    name: path.split("/").pop()!,
    visibility: "private" as const,
    inherited: "private" as const,
    exception: false,
    readOnly: false,
  };
}

const ROOT: FolderListing = {
  path: "",
  folderDefault: "private",
  entries: [entry(NOTE, "file"), entry(OTHER, "file")],
  truncated: false,
  manifestUsable: true,
};

function name(fn: string): string {
  return `functions/files:${fn}`;
}

let browser: FileBrowser;

function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  function Probe() {
    browser = useFileBrowser({ workspaceId: "w1", tier: "private", canEdit: true, isOwner: true });
    return null;
  }
  act(() => {
    root.render(createElement(Probe));
  });
  return () => {
    act(() => root.unmount());
    container.remove();
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The bytes a stubbed read hands back: a PNG is not text. */
const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

describe("images through the file browser", () => {
  let unmount: (() => void) | null = null;

  beforeEach(() => {
    calls.length = 0;
    actions[name("listFiles")] = async () => ROOT;
    actions[name("readNote")] = async () => ({
      path: NOTE,
      text: `# Note\n\n![[${KEY}|320]]\n`,
      etag: "e1",
      readOnly: false,
      encrypted: false,
      visibility: "private",
      inherited: "private",
      exception: false,
    });
    actions[name("readNoteImage")] = async () => ({
      bytes: BYTES.buffer,
      contentType: "image/png",
    });
    actions[name("storeNoteImage")] = async () => ({ leaf: KEY });
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
  });

  test("no note open is no image, and no request", async () => {
    unmount = mount();
    await settle();
    expect(await browser.loadImage(KEY)).toBeNull();
    expect(calls.filter((call) => call.name === name("readNoteImage")).length).toBe(0);
  });

  test("an open note's image loads once and is cached after that", async () => {
    unmount = mount();
    await settle();
    await act(async () => browser.select(NOTE));
    await settle();

    const first = await browser.loadImage(KEY);
    const second = await browser.loadImage(KEY);
    expect(first).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(second).toBe(first);
    const reads = calls.filter((call) => call.name === name("readNoteImage"));
    expect(reads.length).toBe(1);
    // The pair the server needs: which note is asking, and for which key.
    expect(reads[0]!.args).toMatchObject({ notePath: NOTE, leaf: KEY });
  });

  test("a remote image goes through the proxy, never through the bucket read", async () => {
    const REMOTE = "https://img.example/logo.png";
    actions[name("readRemoteImage")] = async () => ({ bytes: BYTES.buffer, contentType: "image/png" });
    unmount = mount();
    await settle();
    await act(async () => browser.select(NOTE));
    await settle();

    expect(await browser.loadImage(REMOTE)).toBe("data:image/png;base64,iVBORw0KGgo=");
    const proxied = calls.filter((call) => call.name === name("readRemoteImage"));
    expect(proxied.length).toBe(1);
    // The note vouches for the URL, exactly as it does for a stored image.
    expect(proxied[0]!.args).toMatchObject({ notePath: NOTE, url: REMOTE });
    expect(calls.filter((call) => call.name === name("readNoteImage")).length).toBe(0);
    // And a second draw is the session's copy, not a second fetch the host sees.
    await browser.loadImage(REMOTE);
    expect(calls.filter((call) => call.name === name("readRemoteImage")).length).toBe(1);
  });

  test("a store answers with the key, and puts the bytes straight in the cache", async () => {
    unmount = mount();
    await settle();
    await act(async () => browser.select(NOTE));
    await settle();

    const stored = await browser.storeImage({
      bytes: BYTES.buffer,
      contentType: "image/png",
    });
    expect(stored).toEqual({ target: KEY });
    // Read back with no second request: the bytes just written are the bytes.
    expect(await browser.loadImage(KEY)).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(calls.filter((call) => call.name === name("readNoteImage")).length).toBe(0);
  });

  test("a refusal from the server is passed through in its own words", async () => {
    // A ConvexError, because that is what a refusal from the server *is* — a
    // plain throw is a transport failure and deliberately becomes a generic
    // sentence instead of somebody's internal error text.
    actions[name("storeNoteImage")] = async () => {
      throw new ConvexError({
        code: "CONTENT_TOO_LARGE",
        message: "A stored image must be at most 5000000 bytes.",
      });
    };
    unmount = mount();
    await settle();
    await act(async () => browser.select(NOTE));
    await settle();

    const stored = await browser.storeImage({
      bytes: BYTES.buffer,
      contentType: "image/png",
    });
    expect(stored).toHaveProperty("error");
    expect((stored as { error: string }).error).toContain("5000000");
  });

  test("an encrypted note refuses before the bytes leave the device", async () => {
    actions[name("readNote")] = async () => ({
      path: NOTE,
      text: "encrypted",
      etag: "e1",
      readOnly: true,
      encrypted: true,
      visibility: "private",
      inherited: "private",
      exception: false,
    });
    unmount = mount();
    await settle();
    await act(async () => browser.select(NOTE));
    await settle();

    const stored = await browser.storeImage({
      bytes: BYTES.buffer,
      contentType: "image/png",
    });
    expect(stored).toEqual({ error: "An encrypted note can’t hold an image yet." });
    expect(calls.filter((call) => call.name === name("storeNoteImage")).length).toBe(0);
  });
});

describe("a note that closes while the upload is in flight", () => {
  let unmount: (() => void) | null = null;

  beforeEach(() => {
    calls.length = 0;
    actions[name("listFiles")] = async () => ROOT;
    actions[name("readNote")] = async () => ({
      path: NOTE,
      text: "# Note\n",
      etag: "e1",
      readOnly: false,
      encrypted: false,
      visibility: "private",
      inherited: "private",
      exception: false,
    });
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
  });

  /**
   * The insert is refused rather than landing in whatever note is open now.
   *
   * The editor cannot notice this: it is one view with notes swapped through it,
   * and by the time the upload returns its state is the new note's. So the hook
   * refuses, and says where the bytes went — they are in the bucket either way,
   * content-addressed, so the next paste of the same image reuses them.
   */
  test("the embed is refused, and the bytes are still in the bucket", async () => {
    let release: (() => void) | null = null;
    actions[name("storeNoteImage")] = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { leaf: KEY };
    };
    unmount = mount();
    await settle();
    await act(async () => browser.select(NOTE));
    await settle();

    let outcome: { target: string } | { error: string } | null = null;
    await act(async () => {
      void browser
        .storeImage({ bytes: BYTES.buffer, contentType: "image/png" })
        .then((result) => {
          outcome = result;
        });
      await Promise.resolve();
    });

    // The reader moves on while the bytes are still going up.
    await act(async () => browser.select(OTHER));
    await settle();
    await act(async () => {
      release?.();
      await Promise.resolve();
    });
    await settle();

    expect(outcome).toEqual({
      error: "That note closed before the image was stored. It is in your bucket.",
    });
    expect(calls.filter((call) => call.name === name("storeNoteImage")).length).toBe(1);
  });
});
