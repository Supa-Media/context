/**
 * @jest-environment jsdom
 */

/**
 * **Closing settings must not close the note behind it.**
 *
 * `/console/@slug/settings` is pushed *over* Browse and leaves it mounted, so
 * what dismissing it returns to is the note somebody had open. The route said
 * that with `router.replace(browseHref(slug))` — `/console/@slug`, no `?note=`
 * — and for as long as such a URL was read as stale, that was harmless: the
 * mirror re-addressed the open note and nobody noticed.
 *
 * A URL that loses its note is an instruction now (`noteAddress.ts`, the phone
 * pill's whole press), which turns that same href into "close the note". So the
 * route has to name where it is going, and this file is what stops it being
 * tidied back to the one-liner it was: a bare href here would shut somebody's
 * note as a side effect of dismissing a settings pane, and — on a phone —
 * file them at the root on the device on the way out.
 *
 * It asserts the **href**, because that is the whole of what the route decides.
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOTE = "1-projects/pilot.md";
const replaced: string[] = [];
let close: (() => void) | null = null;

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: () => {}, replace: (href: string) => replaced.push(href) }),
  useLocalSearchParams: () => ({ slug: "@seyi" }),
}));

jest.mock("../features/console/panes/SettingsPane", () => ({
  SettingsPane: ({ onClose }: { onClose: () => void }) => {
    close = onClose;
    return null;
  },
}));

const { ConsoleDataProvider } =
  require("../features/console/ConsoleDataContext") as typeof import("../features/console/ConsoleDataContext");

const ContextSettingsRoute = (
  require("../app/(app)/console/[slug]/settings") as { default: () => ReactNode }
).default;

function mount(selectedPath: string | null): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  const data = {
    contexts: [{ id: "w1", slug: "seyi", role: "owner", kind: "personal", status: "ok" }],
    selectedContextId: "w1",
    files: { selectedPath },
    loading: false,
  } as never;
  act(() => {
    root.render(
      createElement(ConsoleDataProvider, {
        value: data,
        children: createElement(ContextSettingsRoute),
      }),
    );
  });
}

describe("dismissing a context's settings", () => {
  /**
   * SABOTAGE: `router.replace(browseHref(slug))`, which is what it said before
   * a bare console URL meant anything. Fails here.
   */
  test("returns to the note that is still open behind it", () => {
    replaced.length = 0;
    mount(NOTE);
    act(() => close?.());
    expect(replaced).toEqual([`/console/@seyi?note=${encodeURIComponent(NOTE)}`]);
  });

  test("and to the context's root when nothing is open", () => {
    // The other direction, so the fix cannot be "always name a note" — there is
    // not always one, and `?note=` naming nothing is a fragment of machinery in
    // an address somebody may copy.
    replaced.length = 0;
    mount(null);
    act(() => close?.());
    expect(replaced).toEqual(["/console/@seyi"]);
  });
});
