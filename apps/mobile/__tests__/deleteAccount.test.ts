/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DeleteAccountCard } from "../features/console/panes/ConnectionsPane";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The way all the way out, and the two facts about it worth pinning:
 *
 *  1. **One press deletes nothing.** Deletion is unrecoverable, so the first
 *     press only arms the button — the same shape as the rail's Leave. A
 *     refactor that collapses it to one press passes every other test and
 *     deletes an account on a slipped click.
 *  2. **The copy leads with what does NOT go.** Notes live in the person's
 *     own storage and are not ours to delete; the sentence saying so is the
 *     difference between "reset my account" and "did I just lose my notes".
 */

function mount(deleteAccount: () => Promise<void>): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(DeleteAccountCard as never, { deleteAccount } as never));
  });
  return { host, root };
}

function click(node: Element) {
  act(() => {
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("deleting an account", () => {
  test("takes two presses, and the first deletes nothing", async () => {
    let calls = 0;
    const { host, root } = mount(async () => {
      calls += 1;
    });
    try {
      const button = host.querySelector('[data-testid="delete-account"]')!;
      expect(button.textContent).toContain("Delete account");

      click(button);
      expect(calls).toBe(0);
      expect(button.textContent).toContain("Press again");

      click(button);
      expect(calls).toBe(1);
      expect(host.querySelector('[data-testid="delete-account"]')!.textContent).toContain(
        "Deleting",
      );
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test("says the person's notes stay where they are", () => {
    const { host, root } = mount(async () => {});
    try {
      expect(host.textContent).toContain("stay exactly where they are");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
