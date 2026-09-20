/**
 * @jest-environment jsdom
 */

/**
 * CLAIMING A SHORT LINK, ON THE SCREEN WHERE IT IS CLAIMED.
 *
 * A short link is the one thing in this dialog that hands out a *guessable*
 * address. Everything else here is a token nobody can type; `intake` is a word
 * anybody can, and on a link anyone can open, being able to type the word is
 * the access.
 *
 * So the checks are about what the screen says and what the press asks for:
 *
 *  1. The block is absent where there is no link to attach a name to — the
 *     console's standing rule, the same one that took "Create link" out of the
 *     row beside it.
 *  2. The warning is drawn on an unlisted link and **not** on a workspace
 *     link, where a guessed name opens nothing because the reader is still
 *     authorised by membership. A dialog that warned on both would be crying
 *     wolf, which is the habit that costs somebody the warning that mattered.
 *  3. A claim asks for the name that was typed, lowercased, against the right
 *     share — and a claimed name is shown as the URL it became, with a way to
 *     give it back.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ShareDialog } from "../features/console/files/ShareDialog";
import type { NoteShare } from "../features/console/files/shares";

const NOTE = "1-projects/plan.md";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
});

function mount(element: ReturnType<typeof createElement>): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, {
    onUncaughtError: () => {},
    onCaughtError: () => {},
  });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(element);
  });
}

const openShare: NoteShare = {
  shareId: "s-open",
  token: "b".repeat(64),
  recipient: "Anyone with the link",
  audience: "anyone",
  entryPath: NOTE,
  titleInPreview: true,
  previewTitle: "Plan",
  createdAt: 1,
};

const teamShare: NoteShare = {
  ...openShare,
  shareId: "s-team",
  token: "c".repeat(64),
  recipient: "Everyone in this context",
  audience: "members",
};

function dialog(
  shares: readonly NoteShare[],
  onSetSlug?: (shareId: string, slug: string | null) => Promise<boolean>,
): void {
  mount(
    createElement(ShareDialog, {
      path: NOTE,
      shares,
      origin: "https://context.lc",
      onShare: () => {},
      onCopyLink: async () => ({ ok: true, message: null }),
      onRevoke: () => {},
      onSetPreviewTitle: () => {},
      onClose: () => {},
      context: { slug: "seyi", kind: "personal", viewerIsOwner: true },
      ...(onSetSlug === undefined ? {} : { onSetSlug }),
    } as never),
  );
}

function node(testID: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
}

function press(testID: string): void {
  const found = node(testID);
  if (found === null) throw new Error(`no element with testID ${testID}`);
  act(() => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      found.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
  });
}

function typeInto(testID: string, value: string): void {
  const input = node(testID) as HTMLInputElement | null;
  if (input === null) throw new Error(`no input with testID ${testID}`);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the short link's block", () => {
  test("is absent when there is no link to give a name to", () => {
    dialog([], async () => true);
    expect(node("share-short-link")).toBeNull();
  });

  test("is absent when nothing is wired to claim with", () => {
    // The landing demo renders this dialog with no server behind it. A field
    // that cannot work is what this dialog already refuses to draw for a
    // folder, applied to a second control.
    dialog([openShare]);
    expect(node("share-short-link")).toBeNull();
  });

  test("offers the name under the owner's own handle", () => {
    dialog([openShare], async () => true);
    expect(node("share-short-link")).not.toBeNull();
    expect(document.body.textContent).toContain("context.lc/@seyi/");
  });
});

describe("what the warning is drawn on", () => {
  test("an unlisted link says that memorable means guessable", () => {
    dialog([openShare], async () => true);
    expect(node("share-short-link-warning")?.textContent).toContain("guessable");
  });

  test("a workspace link does not, because a guessed name opens nothing", () => {
    dialog([teamShare], async () => true);
    // The block is there — a team handbook is a good reason to want a short
    // link — and the sentence is not.
    expect(node("share-short-link")).not.toBeNull();
    expect(node("share-short-link-warning")).toBeNull();
  });
});

describe("claiming and releasing", () => {
  test("the press asks for the typed name, lowercased, on the right share", async () => {
    const asked: [string, string | null][] = [];
    dialog([openShare], async (shareId, slug) => {
      asked.push([shareId, slug]);
      return true;
    });

    typeInto("share-short-link-name", "Intake");
    await act(async () => {
      press("share-short-link-claim");
    });

    expect(asked).toEqual([["s-open", "intake"]]);
  });

  test("a name that could never be claimed does not become a request", () => {
    // The obvious typo is refused without a round trip. Everything the shape
    // cannot decide — reserved, taken, a name this product writes — comes back
    // from the server with its own sentence.
    const asked: unknown[] = [];
    dialog([openShare], async (shareId, slug) => {
      asked.push([shareId, slug]);
      return true;
    });

    typeInto("share-short-link-name", "not a name");
    expect(
      (node("share-short-link-claim") as HTMLButtonElement | null)?.getAttribute(
        "aria-disabled",
      ),
    ).toBe("true");
    expect(asked).toEqual([]);
  });

  test("a claimed name is shown as the URL it became, with a way to give it back", async () => {
    const asked: [string, string | null][] = [];
    dialog([{ ...openShare, slug: "intake" }], async (shareId, slug) => {
      asked.push([shareId, slug]);
      return true;
    });

    expect(document.body.textContent).toContain("context.lc/@seyi/intake");
    // No field while one is claimed: two of them would be two answers to
    // "what is this link called".
    expect(node("share-short-link-name")).toBeNull();

    await act(async () => {
      press("share-short-link-release");
    });
    expect(asked).toEqual([["s-open", null]]);
  });

  test("the unlisted link wins the name when both kinds exist", () => {
    // That is the one people paste where a memorable URL matters.
    const asked: [string, string | null][] = [];
    dialog([teamShare, openShare], async (shareId, slug) => {
      asked.push([shareId, slug]);
      return true;
    });
    typeInto("share-short-link-name", "intake");
    act(() => {
      press("share-short-link-claim");
    });
    expect(asked).toEqual([["s-open", "intake"]]);
  });
});
