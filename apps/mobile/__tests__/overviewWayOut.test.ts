/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { OverviewPanel } from "../features/console/settings/panels/OverviewPanel";
import type { ConsoleData, ConsoleStorage } from "../features/console/types";
import type { SettingsSectionKey } from "../features/console/settings/sections";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The way out of a workspace, on the page somebody decides they want one.
 *
 * ## The bug this pins
 *
 * Deleting a workspace has worked end to end for a while — `DeleteWorkspaceCard`
 * with its typed-name confirmation, on top of the owner-only
 * `account.deleteWorkspace` — and it sits at the bottom of **Advanced**, below
 * the audit trail and the key export. Nothing anywhere pointed at it. Somebody
 * looking at a workspace they were finished with, on the page that describes
 * that workspace, had no way to discover the control existed at all, and the
 * settings search box answered "delete workspace" with nothing (that half is
 * `settingsSections.test.ts`).
 *
 * So this row is a **signpost**: it navigates to Advanced and does nothing
 * else. Which makes its absences the load-bearing part, because each of them
 * is a case where following the signpost would lead somewhere blank or wrong:
 *
 *  - a **brain**, whose slug is the person's username — Advanced refuses it and
 *    says deletion is the account's business;
 *  - a workspace somebody **does not own** — `useAdvanced` withholds the whole
 *    `deletion` object from a non-owner, so there would be no card to reach;
 *  - the **demo**, where `AdvancedPanel` draws no card either;
 *  - the **read-only renders** with no `onSelect` (the landing page console,
 *    the `/settings` fallback), where a row that cannot navigate is a
 *    destructive-looking control that silently does nothing.
 *
 * A row drawn in any of those is worse than no row, which is why they are
 * asserted one at a time rather than as one "renders for an owner" happy path.
 */

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

/** A connected bucket, for the half of the copy that depends on there being one. */
const BOUND: ConsoleStorage = {
  provider: "r2",
  bucket: "notes",
  connected: true,
  status: "connected",
  conditionalWrite: true,
  updatedAt: 1_700_000_000_000,
  lastVerifiedAt: 1_700_000_000_000,
};

/** The least `ConsoleData` `OverviewPanel` reads: identity, health, three previews. */
function consoleData(
  context: {
    kind: "personal" | "shared";
    role: "owner" | "editor" | "member";
  },
  overrides: Partial<ConsoleData> = {},
): ConsoleData {
  return {
    demo: false,
    selectedContextId: "ctx-1",
    contexts: [
      { id: "ctx-1", slug: "acme-eng", displayName: "acme-eng", status: "ok", ...context },
    ],
    storage: null,
    members: { members: [], loading: true, failure: null },
    files: { listings: {} },
    ...overrides,
  } as unknown as ConsoleData;
}

function mount(
  data: ConsoleData,
  onSelect?: (key: SettingsSectionKey) => void,
): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(createElement(OverviewPanel, { data, onSelect }));
  });
  return container;
}

function wayOut(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="overview-delete-workspace"]');
}

describe("the way out is offered", () => {
  test("an owner of a shared workspace gets it, and it leads to Advanced", () => {
    const onSelect = jest.fn<(key: SettingsSectionKey) => void>();
    const row = wayOut(mount(consoleData({ kind: "shared", role: "owner" }), onSelect));
    expect(row).not.toBeNull();

    act(() => {
      row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // Advanced, not a second delete control drawn here. One confirmation, one
    // set of refusals, one place they live.
    expect(onSelect).toHaveBeenCalledWith("advanced");
  });

  test("it says what survives before it says what goes", () => {
    // The notes lead, the way `DeleteWorkspaceCard` leads with them: a bucket
    // the customer owns is not ours to delete, and a destructive signpost that
    // does not say so is one nobody follows even when they should.
    const text = wayOut(
      mount(
        consoleData({ kind: "shared", role: "owner" }, { storage: BOUND }),
        jest.fn(),
      ),
    )!.textContent!;
    expect(text).toContain("Notes in its bucket stay where they are");
    expect(text.indexOf("stay where they are")).toBeLessThan(text.indexOf("released"));
    // And it names the workspace it would release, rather than "this one".
    expect(text).toContain("@acme-eng");
  });

  /*
    The workspace this row was written for is the one with no bucket: named at
    step 1 of the creation flow, which claims the slug and spends one of the ten
    an account may own, then abandoned before storage. Reassuring somebody about
    notes it does not have — directly under a health strip reading "No bucket
    connected" — is a contradiction on a single screen, and `undefined` is a
    binding that has not answered rather than one that is absent, so it must not
    be talked into either sentence.
  */
  test.each([
    ["no bucket was ever connected", null],
    ["the binding has not answered yet", undefined],
  ])("it claims nothing about notes when %s", (_why, storage) => {
    const text = wayOut(
      mount(consoleData({ kind: "shared", role: "owner" }, { storage }), jest.fn()),
    )!.textContent!;
    expect(text).not.toContain("bucket");
    // Still the whole reason to press it, which does not depend on a binding.
    expect(text).toContain("@acme-eng is released");
  });
});

describe("the way out is absent", () => {
  const ABSENT: Array<[string, "personal" | "shared", "owner" | "editor" | "member"]> = [
    ["a brain, which goes with its account instead", "personal", "owner"],
    ["a workspace an editor cannot delete", "shared", "editor"],
    ["a workspace a member cannot delete", "shared", "member"],
  ];

  test.each(ABSENT)("%s", (_why, kind, role) => {
    expect(wayOut(mount(consoleData({ kind, role }), jest.fn()))).toBeNull();
  });

  test("the demo, where Advanced draws no deletion card", () => {
    const data = consoleData({ kind: "shared", role: "owner" }, { demo: true });
    expect(wayOut(mount(data, jest.fn()))).toBeNull();
  });

  test("a render that cannot navigate", () => {
    // The landing page's console and the `/settings` fallback pass no
    // `onSelect`. A destructive-looking row that silently does nothing when
    // pressed is worse than no row at all.
    expect(wayOut(mount(consoleData({ kind: "shared", role: "owner" })))).toBeNull();
  });

  test("and the facts above it are unaffected in every one of those cases", () => {
    // The guard is on one row, not on the panel: a mistake in the condition
    // that blanked the page would otherwise pass every assertion above.
    const container = mount(consoleData({ kind: "shared", role: "member" }), jest.fn());
    expect(container.querySelector('[data-testid="overview-fact-storage"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="overview-identity"]')).not.toBeNull();
  });
});
