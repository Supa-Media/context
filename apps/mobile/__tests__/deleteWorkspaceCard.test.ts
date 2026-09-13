/**
 * @jest-environment jsdom
 */

/**
 * GIVING A WORKSPACE'S NAME BACK.
 *
 * Creating a workspace claims its handle out of the global namespace at step
 * 1 and counts it against the ten an account may own, and nothing short of
 * deleting the account released either. This card is the release path, and
 * what these assert is the part that is easy to get wrong in a panel rather
 * than in the mutation:
 *
 * 1. **Absent where the server would refuse it.** A non-owner is offered
 *    nothing — the rule `StorageActions` states, and the same one `keyExport`
 *    beside it follows.
 * 2. **The name, typed, before anything can happen.** Two presses guard the
 *    account card; a workspace is addressed by name, so the name is the
 *    confirmation. The server checks it too — this is the half that stops
 *    somebody deleting the wrong one of several open workspaces.
 * 3. **It says what survives.** A bucket the customer owns is not ours to
 *    delete and is not touched, and saying so on the screen that deletes is
 *    the difference between a control people can use and one they daren't.
 * 4. **A refusal is explained before the field, not after the press.** On
 *    storage we run, the notes are in a bucket the customer has no key to and
 *    hand-off is not built, so the card says so instead of offering a button
 *    whose only outcome is an error.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   the typed-name gate removed from the button                        2
 *   the card drawn for a blocked workspace                             1
 *   the "your files stay" sentence dropped                             1
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("convex/react", () => ({
  useAction: () => async () => undefined,
  useMutation: () => async () => undefined,
  useQuery: () => undefined,
  useQueries: () => ({}),
  useConvex: () => undefined,
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
}));
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { DeleteWorkspaceCard } from "../features/console/settings/DeleteWorkspaceCard";
import {
  deletionBlockedReason,
  deletionConfirmed,
  type WorkspaceDeletion,
} from "../features/console/advanced/advanced";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(deletion: WorkspaceDeletion): HTMLElement {
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
    root.render(createElement(DeleteWorkspaceCard, { deletion }));
  });
  return container;
}

function type(container: HTMLElement, value: string): void {
  const field = container.querySelector(
    '[data-testid="delete-workspace-confirm"]',
  ) as HTMLInputElement;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const deletable: WorkspaceDeletion = {
  slug: "acme-eng",
  blocked: null,
  delete: async () => {},
};

describe("what the card says before anything is typed", () => {
  test("the name comes back, the people lose access, the files do not move", () => {
    const words = mount(deletable).textContent ?? "";
    expect(words).toContain("@acme-eng");
    // The fear this control has to answer first, and the promise behind it.
    expect(words.toLowerCase()).toContain("stay");
    expect(words).toContain("not ours to delete");
    expect(words.toLowerCase()).toContain("cannot be undone");
  });

  test("and nothing is deletable until the name is typed", () => {
    const container = mount(deletable);
    const button = container.querySelector('[data-testid="delete-workspace"]');
    expect(button?.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("the typed name", () => {
  test("arms the button only when it matches", () => {
    const container = mount(deletable);
    type(container, "acme");
    expect(
      container.querySelector('[data-testid="delete-workspace"]')?.getAttribute("aria-disabled"),
    ).toBe("true");
    type(container, "acme-eng");
    // Enabled is the absence of the attribute, not `"false"` — RNW drops it.
    expect(
      container.querySelector('[data-testid="delete-workspace"]')?.getAttribute("aria-disabled"),
    ).toBeNull();
  });

  test("and pressing it hands the typed name to the server, which checks it too", () => {
    const seen: string[] = [];
    const container = mount({
      ...deletable,
      delete: async (confirmSlug: string) => {
        seen.push(confirmSlug);
      },
    });
    type(container, "@Acme-Eng");
    const button = container.querySelector('[data-testid="delete-workspace"]') as HTMLElement;
    act(() => button.click());
    expect(seen).toEqual(["@Acme-Eng"]);
  });
});

describe("a workspace this screen must not offer to delete", () => {
  test("says why, and offers no field and no button", () => {
    const container = mount({
      ...deletable,
      blocked: "This workspace's notes are in storage we run.",
    });
    expect(container.textContent ?? "").toContain("storage we run");
    expect(container.querySelector('[data-testid="delete-workspace"]')).toBeNull();
    expect(container.querySelector('[data-testid="delete-workspace-confirm"]')).toBeNull();
  });
});

describe("who is blocked, decided in one place", () => {
  test("a workspace goes with the account, never from a settings panel", () => {
    const reason = deletionBlockedReason({ kind: "personal", storageIsManaged: false });
    expect(reason).not.toBeNull();
    expect(reason ?? "").toContain("account");
  });

  test("storage we run blocks it until hand-off exists", () => {
    const reason = deletionBlockedReason({ kind: "shared", storageIsManaged: true });
    expect(reason ?? "").toContain("storage we run");
  });

  test("a workspace on a bucket the customer owns is deletable", () => {
    expect(deletionBlockedReason({ kind: "shared", storageIsManaged: false })).toBeNull();
  });

  /**
   * Absence is not permission. `storageIsManaged` arrives a beat after the
   * first paint, and a card that offered deletion during that beat would be
   * offering it for exactly the workspace it must refuse.
   */
  test("and an unanswered question blocks rather than allows", () => {
    expect(deletionBlockedReason({ kind: "shared", storageIsManaged: undefined })).not.toBeNull();
    expect(deletionBlockedReason({ kind: undefined, storageIsManaged: false })).not.toBeNull();
  });
});

describe("the typed-name comparison", () => {
  test("accepts what a person actually types", () => {
    for (const typed of ["acme-eng", "  acme-eng ", "@acme-eng", "Acme-Eng"]) {
      expect(deletionConfirmed(typed, "acme-eng")).toBe(true);
    }
  });

  test("and refuses a near miss", () => {
    for (const typed of ["", "acme", "acme-engineering", "acme eng"]) {
      expect(deletionConfirmed(typed, "acme-eng")).toBe(false);
    }
  });
});
