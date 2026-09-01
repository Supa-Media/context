/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { copyDeferred, writeClipboard } from "../features/design/clipboard";

/**
 * **Copy link did nothing, and said nothing.**
 *
 * Reported on iOS Safari: pressing it left the clipboard empty and the button
 * unchanged. The cause is a rule about *when*, not about what — Safari grants
 * the clipboard to a call made inside the user activation a press starts, and
 * the dialog awaited a round trip (minting the share row) before writing. That
 * spends the activation, the write is refused, the caller correctly declines to
 * claim a copy it did not make, and the button silently stays "Copy link".
 *
 * `copyDeferred` is the fix and it is the *order* that matters: the clipboard
 * is asked for first, with a Promise for the text, and the round trip settles
 * inside it. Everything here asserts on order and on call counts, because the
 * observable outcome — text on a clipboard — is identical either way in a
 * browser that does not enforce the window. **A test that only checked the
 * clipboard's contents would have passed against the broken version.**
 */

const realClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const realItem = (globalThis as { ClipboardItem?: unknown }).ClipboardItem;

afterEach(() => {
  document.body.innerHTML = "";
  if (realClipboard === undefined) delete (navigator as { clipboard?: unknown }).clipboard;
  else Object.defineProperty(navigator, "clipboard", realClipboard);
  (globalThis as { ClipboardItem?: unknown }).ClipboardItem = realItem;
});

/** A clipboard that records the order it was called in. */
function stubClipboard(options: { supportsItems: boolean; refuse?: boolean }) {
  const order: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      write: async () => {
        order.push("write");
        if (options.refuse === true) throw new Error("NotAllowedError");
      },
      writeText: async (text: string) => {
        order.push(`writeText:${text}`);
        if (options.refuse === true) throw new Error("NotAllowedError");
      },
    },
  });
  (globalThis as { ClipboardItem?: unknown }).ClipboardItem = options.supportsItems
    ? class {
        constructor(readonly parts: Record<string, unknown>) {}
      }
    : undefined;
  return order;
}

describe("copying something the press has not fetched yet", () => {
  test("the clipboard is asked for without waiting for the round trip", async () => {
    const order = stubClipboard({ supportsItems: true });
    let minted = 0;
    let release: ((url: string) => void) | null = null;
    const produce = () => {
      minted += 1;
      return new Promise<string | null>((resolve) => {
        release = resolve;
      });
    };

    const done = copyDeferred(produce);
    // Let every already-scheduled microtask run. The round trip has NOT
    // resolved — nothing has called `release` — so anything that happens by
    // now happened without waiting for it.
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    /*
      **This is the whole test.** The write is issued while the mint is still
      in flight, which is what keeps Safari's activation window. The broken
      version awaited the mint first and reached the clipboard too late — and
      it put the same text on the same clipboard in every browser that does not
      enforce the window, so only the order tells them apart.
    */
    expect(order).toEqual(["write"]);
    expect(minted).toBe(1);

    release!("https://context.lc/s/abc");
    expect(await done).toEqual({ ok: true, text: "https://context.lc/s/abc" });
    // One row per press. Calling `produce` on both paths would be a second
    // round trip and a second audit entry for one button.
    expect(minted).toBe(1);
  });

  test("a browser with no ClipboardItem still copies, the ordinary way", async () => {
    const order = stubClipboard({ supportsItems: false });

    const result = await copyDeferred(async () => "https://context.lc/s/abc");

    expect(order).toEqual(["writeText:https://context.lc/s/abc"]);
    expect(result.ok).toBe(true);
  });

  test("a refused write falls back, and does not mint twice", async () => {
    const order = stubClipboard({ supportsItems: true, refuse: true });
    let minted = 0;
    const result = await copyDeferred(async () => {
      minted += 1;
      return "https://context.lc/s/abc";
    });

    // Both paths refused here, so the honest answer is `false` — and the text
    // still comes back, because a caller that could not copy has something
    // worth showing.
    expect(result.ok).toBe(false);
    expect(result.text).toBe("https://context.lc/s/abc");
    expect(minted).toBe(1);
    expect(order.filter((step) => step === "write")).toHaveLength(1);
  });

  test("nothing to copy is not a failed copy", async () => {
    stubClipboard({ supportsItems: true });
    // `produce` answering `null` means the link could not be made — the server
    // refused, and it has already said why. The caller must be able to tell
    // that from "the clipboard would not take it", or it replaces a real
    // refusal with a symptom of one.
    expect(await copyDeferred(async () => null)).toEqual({ ok: false, text: null });
  });
});

describe("the plain write, on the browsers that need the old path", () => {
  test("a field iOS will actually select", async () => {
    // The `readonly` + `select()` recipe every snippet shows is the one iOS
    // ignores: it refuses to select a read-only field, so `execCommand` copies
    // whatever was selected before — usually nothing. This asserts the shape
    // that works, because the behaviour it fixes cannot be reproduced in jsdom.
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    let seen: { readOnly: boolean; selection: [number, number] } | null = null;
    const exec = jest.fn(() => {
      const area = document.querySelector("textarea");
      if (area !== null) {
        seen = {
          readOnly: area.hasAttribute("readonly"),
          selection: [area.selectionStart ?? -1, area.selectionEnd ?? -1],
        };
      }
      return true;
    });
    (document as unknown as { execCommand: unknown }).execCommand = exec;

    expect(await writeClipboard("hello")).toBe(true);
    expect(seen).toEqual({ readOnly: false, selection: [0, 5] });
    // And it cleans up after itself: a stray textarea in the body is a focus
    // trap on the next tab press.
    expect(document.querySelector("textarea")).toBeNull();
  });
});
