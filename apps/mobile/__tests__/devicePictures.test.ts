/**
 * @jest-environment jsdom
 */

/**
 * PICTURES KEPT ON THIS DEVICE.
 *
 * Owner, 2026-11-09, approving the offline-first boards: "pictures kept on the
 * phone". A picture a note here has shown is kept and shown again offline; a
 * picture pasted offline is named as the server will name it, embedded at
 * once, and sent when the connection is back. And the one thing never done:
 * online, a picture the server refuses is not answered from the device.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   the device's name for a paste differs from the server's (no shared rule)   2
 *   loadImage reads the device copy online too                                 1
 *   overBudget evicts a picture waiting to be sent                             1
 *   devicePicture reads a wider clearance than the session's                   1
 */

import { describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { pasteImageLeaf } from "../../convex/functions/lib/fileOps/images";
import {
  PICTURE_BUDGET,
  devicePicture,
  keepPicture,
  overBudget,
  pendingPictureCount,
  pictureLeaf,
  pictureSrc,
  sendPendingPictures,
} from "../features/offline/devicePictures";
import { memoryMirrorStore } from "../features/offline/mirrorStoreCore";
import { currentEpoch } from "../features/offline/epoch";
import { useDevicePictures } from "../features/console/files/fileBrowser/useDevicePictures";
import { sha256Hex } from "../features/offline/pictureHash";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no Web Crypto; every engine this app's web half runs in does.
if (globalThis.crypto?.subtle === undefined) {
  Object.defineProperty(globalThis, "crypto", { value: require("node:crypto").webcrypto, configurable: true });
}

const W = "ws_pictures";
const png = (seed: number) => new Uint8Array([137, 80, 78, 71, seed, seed + 1, seed + 2]).buffer;

describe("named as the server names it", () => {
  test("the device's name for a paste is the control plane's, from the same bytes", async () => {
    const bytes = png(1);
    const mine = await pictureLeaf(bytes, "image/png");
    expect(mine).toBe(pasteImageLeaf({ hash: await sha256Hex(bytes), contentType: "image/png" }));
    expect(mine).toMatch(/^paste-[a-f0-9]{16}\.png$/);
    expect(await pictureLeaf(bytes, "text/plain")).toBeNull();
  });
});

describe("kept, read back, and sent", () => {
  test("a kept picture is read back at its clearance, and not from a wider one", async () => {
    const store = memoryMirrorStore();
    const leaf = (await pictureLeaf(png(2), "image/png"))!;
    const src = pictureSrc(png(2), "image/png");
    expect(await keepPicture(store, currentEpoch(), "private", W, { leaf, src }, 1)).toBe(true);
    expect(await devicePicture(store, "private", W, leaf)).toBe(src);
    // Kept by a private session: a team session on this device does not read it.
    expect(await devicePicture(store, "team", W, leaf)).toBeNull();
  });

  test("not a picture, or not a name the server gives, is not kept", async () => {
    const store = memoryMirrorStore();
    expect(await keepPicture(store, currentEpoch(), "private", W, { leaf: "../notes/x.md", src: "data:image/png;base64,AA" }, 1)).toBe(false);
    expect(await keepPicture(store, currentEpoch(), "private", W, { leaf: "paste-0123456789abcdef.png", src: "<script>" }, 1)).toBe(false);
  });

  test("a paste waiting to be sent goes up once, oldest first, and stops at the first failure", async () => {
    const store = memoryMirrorStore();
    const leaves: string[] = [];
    for (const seed of [3, 4, 5]) {
      const leaf = (await pictureLeaf(png(seed), "image/png"))!;
      leaves.push(leaf);
      await keepPicture(store, currentEpoch(), "private", W, { leaf, src: pictureSrc(png(seed), "image/png"), pending: { contentType: "image/png" } }, seed);
    }
    expect(await pendingPictureCount(store, "private", W)).toBe(3);

    const sent: string[] = [];
    let fail = 2;
    const send = async ({ bytes, contentType }: { bytes: ArrayBuffer; contentType: string }) => {
      if (sent.length === fail) throw new Error("offline again");
      const leaf = pasteImageLeaf({ hash: await sha256Hex(bytes), contentType });
      sent.push(leaf);
      return leaf;
    };
    expect(await sendPendingPictures(store, currentEpoch(), "private", W, send, () => true)).toEqual({ sent: 2, failed: true });
    expect(sent).toEqual(leaves.slice(0, 2));
    expect(await pendingPictureCount(store, "private", W)).toBe(1);

    fail = 99;
    expect(await sendPendingPictures(store, currentEpoch(), "private", W, send, () => true)).toEqual({ sent: 1, failed: false });
    expect(sent).toEqual(leaves);
    expect(await pendingPictureCount(store, "private", W)).toBe(0);
    // Still on the device, as a shown picture.
    expect(await devicePicture(store, "private", W, leaves[2]!)).not.toBeNull();
  });

  test("past the budget the least recently shown go, and never one waiting to be sent", () => {
    const big = PICTURE_BUDGET / 2;
    const gone = overBudget({
      "paste-aaaaaaaaaaaaaaaa.png": { size: big, usedAt: 1, pending: { contentType: "image/png", queuedAt: 1 } },
      "paste-bbbbbbbbbbbbbbbb.png": { size: big, usedAt: 2 },
      "paste-cccccccccccccccc.png": { size: big, usedAt: 3 },
    });
    expect(gone).toEqual(["paste-bbbbbbbbbbbbbbbb.png"]);
  });
});

describe("through the console", () => {
  type Device = {
    reachability: "online" | "offline";
    deviceFirst: boolean;
    kept: Map<string, string>;
    queued: string[];
  };

  function mount(device: Device, server: { read: (target: string) => string | null; store: (bytes: ArrayBuffer, contentType: string) => Promise<string> }) {
    let api: ReturnType<typeof useDevicePictures> | null = null;
    const offline = {
      get reachability() {
        return device.reachability;
      },
      get deviceFirst() {
        return device.deviceFirst;
      },
      keepPicture: (leaf: string, src: string) => void device.kept.set(leaf, src),
      devicePicture: async (leaf: string) => device.kept.get(leaf) ?? null,
      queuePicture: async ({ leaf, src }: { leaf: string; src: string }) => {
        device.kept.set(leaf, src);
        device.queued.push(leaf);
        return true;
      },
      sendPictures: async () => ({ sent: 0, failed: false }),
    };
    function Probe() {
      api = useDevicePictures({
        workspaceId: W as never,
        imageCache: { current: new Map() },
        editorRef: { current: { encrypted: false } } as never,
        loadImage: async (target) => server.read(target),
        storeImage: async (image) => ({ target: await server.store(image.bytes, image.contentType) }),
        storeNoteImageAction: (async () => ({ leaf: "" })) as never,
        offline: offline as never,
        offlineRef: { current: offline } as never,
      });
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(createElement(Probe)));
    return { get api() { return api!; }, unmount: () => act(() => root.unmount()) };
  }

  test("shown online, kept, and shown again offline", async () => {
    const device: Device = { reachability: "online", deviceFirst: true, kept: new Map(), queued: [] };
    const view = mount(device, { read: () => "data:image/png;base64,AAAA", store: async () => "x" });
    expect(await view.api.loadImage("paste-0123456789abcdef.png")).toBe("data:image/png;base64,AAAA");
    expect(device.kept.get("paste-0123456789abcdef.png")).toBe("data:image/png;base64,AAAA");
    view.unmount();

    device.reachability = "offline";
    const again = mount(device, { read: () => null, store: async () => "x" });
    expect(await again.api.loadImage("paste-0123456789abcdef.png")).toBe("data:image/png;base64,AAAA");
    again.unmount();
  });

  test("online, a picture the server refuses is not answered from the device", async () => {
    const device: Device = {
      reachability: "online",
      deviceFirst: true,
      kept: new Map([["paste-0123456789abcdef.png", "data:image/png;base64,AAAA"]]),
      queued: [],
    };
    const view = mount(device, { read: () => null, store: async () => "x" });
    expect(await view.api.loadImage("paste-0123456789abcdef.png")).toBeNull();
    view.unmount();
  });

  test("pasted offline: named as the server will, kept, and queued; a tab without a copy goes to the server", async () => {
    const device: Device = { reachability: "offline", deviceFirst: true, kept: new Map(), queued: [] };
    let stored = 0;
    const view = mount(device, { read: () => null, store: async () => `server-${(stored += 1)}` });
    const bytes = png(9);
    const result = await view.api.storeImage({ bytes, contentType: "image/png" });
    expect(result).toEqual({ target: await pictureLeaf(bytes, "image/png") });
    expect(device.queued).toEqual([(result as { target: string }).target]);
    expect(stored).toBe(0);
    view.unmount();

    device.deviceFirst = false;
    const tab = mount(device, { read: () => null, store: async () => `server-${(stored += 1)}` });
    expect(await tab.api.storeImage({ bytes, contentType: "image/png" })).toEqual({ target: "server-1" });
    tab.unmount();
  });
});
