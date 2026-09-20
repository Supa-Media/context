/**
 * @jest-environment jsdom
 */

/**
 * THE CARD THAT STANDS WHERE AN ABANDONED SETUP FLOW USED TO BE.
 *
 * Somebody who pays for managed storage from `/workspace/new` never comes back
 * to it — Stripe returns to Premium settings, because the flow is component
 * state with no URL to resume — so the layout and vault questions were simply
 * never asked. What they saw instead, on a verified and entirely empty bucket,
 * was a notice saying `privacy.md` could not be read: the truest possible
 * statement of the problem and no way at all to fix it.
 *
 * What these assert, in the order they matter:
 *
 * 1. **Both answers are on screen.** A starting layout *or* the vault they
 *    already have. One without the other is the dead end again, pointed
 *    somewhere else.
 * 2. **The folders are named.** "The standard layout" is not something anybody
 *    can agree to, and the names come from the scaffolder so the card cannot
 *    promise folders the write does not create.
 * 3. **A half-written layout says so, and says finishing is safe.** That is the
 *    sentence that stops somebody deleting objects over S3 by hand (issue #22).
 *
 * Layout is checked in a browser, not here — jsdom lays nothing out.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   the import route dropped from the card                   1
 *   folder names hardcoded rather than imported              1 (structure.test.ts also fails)
 *   the unfinished case drawn with the empty case's words    1
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

/*
  The card's connected half reaches for a Convex client. The boundary is drawn
  at the module, as `onboardingManaged.test.ts` draws it: what is under test is
  what the card says and which affordances it offers, and there is no backend
  behind that question.
*/
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
import { SetupPromptBody } from "../features/console/setup/SetupPrompt";
import { PARA_FOLDERS } from "@context/convex/functions/lib/scaffold";
import type { ContextSetup } from "../features/console/setup";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<() => void> = [];
afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
});

function render(props: {
  setup: ContextSetup;
  applying?: boolean;
  failure?: string;
  onApplyLayout?: () => void;
  onImportVault?: () => void;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(
      createElement(SetupPromptBody, {
        setup: props.setup,
        applying: props.applying ?? false,
        failure: props.failure,
        onApplyLayout: props.onApplyLayout ?? (() => {}),
        onImportVault: props.onImportVault,
      }),
    );
  });
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const find = (testID: string) => container.querySelector(`[data-testid="${testID}"]`);
  return { container, find, text: () => container.textContent ?? "" };
}

describe("an empty context is offered both answers", () => {
  test("a starting layout and the vault they already have", () => {
    const screen = render({ setup: { kind: "empty" }, onImportVault: () => {} });
    expect(screen.find("console-setup-apply")).not.toBeNull();
    expect(screen.find("console-setup-import")).not.toBeNull();
    expect(screen.text()).toMatch(/obsidian/i);
  });

  test("the folders it would write are named, from the scaffolder itself", () => {
    // Imported rather than spelled out here: a card that promises folders the
    // write does not create is worse than one that promises nothing.
    const screen = render({ setup: { kind: "empty" } });
    const folders = screen.find("console-setup-folders");
    expect(folders).not.toBeNull();
    for (const folder of PARA_FOLDERS) {
      expect(folders?.textContent ?? "").toContain(folder);
    }
  });

  test("it says what the folders start as, and that none of it is permanent", () => {
    const text = render({ setup: { kind: "empty" } }).text();
    expect(text).toMatch(/starts private/i);
    expect(text).toMatch(/rename, add, or reorgani/i);
  });

  test("pressing it asks for the layout exactly once", () => {
    let presses = 0;
    const screen = render({ setup: { kind: "empty" }, onApplyLayout: () => (presses += 1) });
    const button = screen.find("console-setup-apply") as HTMLElement | null;
    act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(presses).toBe(1);
  });
});

describe("a half-written layout is a different screen", () => {
  test("it offers to finish rather than to start, and says that is safe", () => {
    const screen = render({ setup: { kind: "unfinished" } });
    expect(screen.text()).toMatch(/not finished/i);
    expect(screen.text()).toMatch(/nothing already in your storage/i);
    expect(screen.find("console-setup-apply")?.textContent ?? "").toMatch(/finish/i);
  });
});

describe("while it runs, and when it will not", () => {
  test("the button becomes the work, so nothing is pressed twice", () => {
    const screen = render({ setup: { kind: "empty" }, applying: true, onImportVault: () => {} });
    expect(screen.find("console-setup-working")).not.toBeNull();
    expect(screen.find("console-setup-apply")).toBeNull();
  });

  test("a refusal is shown in our words", () => {
    const screen = render({
      setup: { kind: "empty" },
      failure: "This context already has a layout — nothing was changed. Reload to see it.",
    });
    expect(screen.text()).toMatch(/already has a layout/i);
  });

  test("nothing is drawn for a context with nothing to offer", () => {
    const screen = render({ setup: { kind: "none" } });
    expect(screen.find("console-setup-prompt")).toBeNull();
    expect(screen.text()).toBe("");
  });
});
