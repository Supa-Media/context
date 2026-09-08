/**
 * @jest-environment jsdom
 */

/**
 * `useNoteEncryption` wired against mocked Convex actions.
 *
 * `passphraseOps.test.ts` already proves the passphrase never reaches a
 * request; this file is the one layer above it — the layer that decides
 * *which* Convex action a given operation calls, and that keeps the session
 * in step with what was just written. Two things matter that no test below
 * `useNoteEncryption` can see:
 *
 *  - **`remove` calls a different action from every other operation.**
 *    `removeNoteEncryption`, never `writeNote` — mixing the two up would
 *    either send a plaintext body through the door that refuses it, or send a
 *    passphrase-change through the door meant only for the one legitimate
 *    plaintext-over-encrypted write.
 *  - **The session reacts correctly to each outcome**: locking or unlocking a
 *    note leaves it open, removing its passphrase leaves it closed, and a
 *    wrong passphrase changes nothing about the session at all.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * jsdom's own `crypto` has no `subtle` — every browser and every runtime this
 * app actually ships to does, which is `kdfSupport`'s whole basis for refusing
 * a phone rather than a browser. Node's real Web Crypto stands in for it here,
 * the same as it does implicitly for `passphraseOps.test.ts`, which runs under
 * Jest's default `node` environment rather than jsdom.
 */
if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    value: require("node:crypto").webcrypto,
    configurable: true,
  });
}

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  return {
    useAction: (ref: never) => {
      const name = getFunctionName(ref);
      bound[name] ??= (args: never) => actions[name]!(args);
      return bound[name];
    },
  };
});

// Imported after the mock, which `jest.mock` hoists above it anyway.
import type { KdfDescriptor } from "../features/console/encryption/kdf";
import { useNoteEncryption, type NoteEncryptionController } from "../features/console/encryption/useNoteEncryption";

function name(fn: string): string {
  return `functions/files:${fn}`;
}

/**
 * A trivial, fast stand-in for Argon2id — a different passphrase makes a
 * different key, which is all this suite needs, and none of the real
 * function's cost.
 */
function fakeDerive(passphrase: string, _kdf: KdfDescriptor): Uint8Array {
  const key = new Uint8Array(32);
  for (let i = 0; i < passphrase.length; i += 1) {
    key[i % 32] = (key[i % 32]! + passphrase.charCodeAt(i) * (i + 1)) % 256;
  }
  return key;
}

let controller: NoteEncryptionController;

function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  function Probe() {
    controller = useNoteEncryption("w1", fakeDerive);
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

const PATH = "1-projects/locked.md";

describe("useNoteEncryption", () => {
  let unmount: () => void;
  let writeCalls: Array<{ path: string; text: string; expectedEtag?: string }>;
  let removeCalls: Array<{ path: string; text: string; expectedEtag?: string }>;

  beforeEach(() => {
    writeCalls = [];
    removeCalls = [];
    actions[name("writeNote")] = (async (args: {
      workspaceId: string;
      path: string;
      text: string;
      expectedEtag?: string;
    }) => {
      writeCalls.push({ path: args.path, text: args.text, expectedEtag: args.expectedEtag });
      return { etag: `etag-${writeCalls.length}`, conflictCheck: "conditional" };
    }) as (args: never) => Promise<unknown>;
    actions[name("removeNoteEncryption")] = (async (args: {
      workspaceId: string;
      path: string;
      text: string;
      expectedEtag?: string;
    }) => {
      removeCalls.push({ path: args.path, text: args.text, expectedEtag: args.expectedEtag });
      return { etag: `removed-${removeCalls.length}`, conflictCheck: "conditional" };
    }) as (args: never) => Promise<unknown>;

    unmount = mount();
  });

  afterEach(() => {
    unmount();
  });

  test("protect calls writeNote, produces an envelope, and leaves the note unlocked", async () => {
    expect(controller.isUnlocked(PATH)).toBe(false);

    await act(async () => {
      await controller.protect({
        path: PATH,
        plaintext: "# secret\n\nfor my eyes only\n",
        etag: null,
        passphrase: "a very good passphrase",
      });
    });

    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]!.path).toBe(PATH);
    expect(writeCalls[0]!.expectedEtag).toBeUndefined();
    expect(writeCalls[0]!.text).toContain("context_encryption: v1");
    expect(writeCalls[0]!.text).not.toContain("for my eyes only");
    expect(controller.isUnlocked(PATH)).toBe(true);
  });

  test("unlock makes no request at all", async () => {
    let stored = "";
    await act(async () => {
      await controller.protect({
        path: PATH,
        plaintext: "# secret\n",
        etag: null,
        passphrase: "a very good passphrase",
      });
    });
    stored = writeCalls[0]!.text;
    act(() => controller.lock());
    expect(controller.isUnlocked(PATH)).toBe(false);
    writeCalls.length = 0;

    let opened: { plaintext: string } | undefined;
    await act(async () => {
      opened = await controller.unlock({ path: PATH, stored, passphrase: "a very good passphrase" });
    });

    expect(opened?.plaintext).toBe("# secret\n");
    expect(writeCalls).toHaveLength(0);
    expect(removeCalls).toHaveLength(0);
    expect(controller.isUnlocked(PATH)).toBe(true);
  });

  test("a wrong passphrase throws, calls nothing, and leaves the session untouched", async () => {
    let stored = "";
    await act(async () => {
      await controller.protect({
        path: PATH,
        plaintext: "# secret\n",
        etag: null,
        passphrase: "a very good passphrase",
      });
    });
    stored = writeCalls[0]!.text;
    act(() => controller.lock());
    writeCalls.length = 0;

    /*
     * Caught **inside** the `act()` callback rather than let the callback
     * itself reject. `act(async () => { ...await a rejecting call... })`
     * rejecting is fine for React in isolation, but it leaves `act()`'s own
     * internal bookkeeping in a state that corrupts every `act()` call for
     * the rest of this file: a dispatch two tests later stops producing a
     * re-render at all, with no warning pointing at the real cause — only
     * "You seem to have overlapping act() calls" logged against an unrelated
     * line. Measured by reverting this and the same guard in the test below:
     * `lock() closes a note this session opened`, run after both, starts
     * failing even though nothing about it changed.
     */
    let error: unknown;
    await act(async () => {
      try {
        await controller.unlock({ path: PATH, stored, passphrase: "the wrong one entirely" });
      } catch (caught) {
        error = caught;
      }
    });

    expect(error).toBeInstanceOf(Error);
    expect(controller.isUnlocked(PATH)).toBe(false);
    expect(writeCalls).toHaveLength(0);
  });

  test("save while locked refuses without calling writeNote", async () => {
    // See the comment on the wrong-passphrase test above: the throw is caught
    // inside the `act()` callback so `act()` itself never rejects.
    let error: unknown;
    await act(async () => {
      try {
        await controller.save({ path: PATH, plaintext: "x", etag: "e1", stored: "not checked" });
      } catch (caught) {
        error = caught;
      }
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/locked/);
    expect(writeCalls).toHaveLength(0);
  });

  test("remove calls removeNoteEncryption, never writeNote, and closes the session", async () => {
    let stored = "";
    await act(async () => {
      await controller.protect({
        path: PATH,
        plaintext: "# secret\n",
        etag: null,
        passphrase: "a very good passphrase",
      });
    });
    stored = writeCalls[0]!.text;
    writeCalls.length = 0;

    await act(async () => {
      await controller.remove({
        path: PATH,
        stored,
        etag: "etag-1",
        passphrase: "a very good passphrase",
      });
    });

    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]!.text).toBe("# secret\n");
    expect(writeCalls).toHaveLength(0);
    expect(controller.isUnlocked(PATH)).toBe(false);
  });

  test("lock() closes a note this session opened", async () => {
    await act(async () => {
      await controller.protect({
        path: PATH,
        plaintext: "# a\n",
        etag: null,
        passphrase: "a very good passphrase",
      });
    });
    expect(controller.isUnlocked(PATH)).toBe(true);

    act(() => controller.lock());

    expect(controller.isUnlocked(PATH)).toBe(false);
  });
});
