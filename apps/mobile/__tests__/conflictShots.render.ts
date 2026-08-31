/**
 * @jest-environment jsdom
 *
 * A render harness, not a test. Writes the conflict surface to static HTML so
 * Playwright can photograph it in both palettes. Not matched by
 * `jest.config.js`'s `testMatch` — run it deliberately:
 *
 *   npx jest --testMatch '**\/conflictShots.render.ts'
 *
 * Both schemes, because this screen is the one place in the console where
 * somebody is asked to destroy one of two versions of their own writing, and
 * "does the refusal sentence survive on the light ground" is not a question a
 * dark-only screenshot can answer.
 */

import { describe, test } from "@jest/globals";
import { createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import * as fs from "fs";
import * as path from "path";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
  A pointer-sized window, because the components branch on
  `densityFor(useWindowDimensions().width)`.

  `documentElement.clientWidth` specifically, and not `window.innerWidth`:
  `react-native-web`'s `Dimensions` reads the document element (jsdom has no
  layout, so it reports 0) and caches the result until a `resize` event. Without
  both halves of that, every picture here is of the *phone* layout inside a
  940px frame — a picture of neither surface.
*/
Object.defineProperty(document.documentElement, "clientWidth", {
  value: 1200,
  configurable: true,
});
Object.defineProperty(document.documentElement, "clientHeight", {
  value: 900,
  configurable: true,
});

const { ThemeProvider } =
  require("../features/design/theme") as typeof import("../features/design/theme");
const { darkColors, lightColors } =
  require("../features/design/tokens") as typeof import("../features/design/tokens");
const { ConflictResolver } =
  require("../features/console/files/ConflictResolver") as typeof import("../features/console/files/ConflictResolver");

type ConflictReview = import("../features/console/files/useConflictReview").ConflictReview;
type Scheme = "light" | "dark";

const OUT = path.join(__dirname, "..", "..", "..", "docs", "design", "conflict");

const PATH = "1-projects/pilot.md";
const MINE =
  "# Pilot\n\nWe are running the pilot with four churches, not two.\n\nBudget: unchanged.\n\nNext review: the 14th.\n";
const THEIRS =
  "# Pilot\n\nWe are running the pilot with two churches.\n\nBudget: unchanged.\n\nNext review: moved to the 21st.\n";
const MERGED =
  "# Pilot\n\nWe are running the pilot with four churches, not two.\n\nBudget: unchanged.\n\nNext review: moved to the 21st.\n";

const REVIEW: ConflictReview = {
  path: PATH,
  mine: MINE,
  theirs: THEIRS,
  theirsEtag: "e2",
  reading: false,
  unreadable: null,
  merge: { text: MERGED, conflicts: 0 },
  mergeRefusal: null,
  conditionalWrite: true,
  message: "That file changed somewhere else while you were editing it.",
};

const NO_MERGE: ConflictReview = {
  ...REVIEW,
  merge: null,
  mergeRefusal: {
    reason: "ancestor-evicted",
    sentence:
      "Merging needs the version you started from, and this device no longer has it — the copy it kept has been cleared. You can still keep one side or the other.",
  },
};

const rendered: {
  name: string;
  label: string;
  scheme: Scheme;
  html: string;
  /** Tall enough that nothing important is behind an inner scrollbar. */
  height: number;
  /**
   * `LiveEditor.web`'s own stylesheet, as it stood for *this* render.
   *
   * It is injected into `document.head` under a fixed id and rewritten with
   * the palette in force every time the editor mounts, so the one left behind
   * at the end of the run carries whichever scheme rendered last — which is
   * how the light merge review came out drawn in dark-mode ink. Snapshotted
   * per page instead, and appended after the shared sheet so it wins.
   */
  liveEditorCss: string;
}[] = [];

const LIVE_EDITOR_STYLE_ID = "context-live-preview-styles";

/*
  Styles are collected once at the end, for the reason `shots.render.ts`
  documents: `react-native-web` registers its rules with `insertRule`, so the
  `<style>` element's text is empty and a page written mid-run gets the colours
  without the layout.
*/
function page(one: (typeof rendered)[number], styles: string): string {
  const ground = one.scheme === "dark" ? darkColors.ground : lightColors.ground;
  const ink = one.scheme === "dark" ? darkColors.muted : lightColors.muted;
  return `<!doctype html><meta charset="utf-8"><title>${one.label}</title>
<style>${styles}
${one.liveEditorCss}
  body { margin: 0; background: ${ground};
         font-family: -apple-system, system-ui, sans-serif; }
  .frame { width: 940px; margin: 0 auto; padding: 24px; }
  .label { color: ${ink}; font-size: 12px; letter-spacing: .06em;
           text-transform: uppercase; margin: 0 0 10px; }
  .surface { border-radius: 12px; overflow: hidden;
             display: flex; flex-direction: column; height: ${one.height}px; }
  .surface > div { flex: 1 1 auto; min-height: 0; }
</style>
<div class="frame"><p class="label">${one.label} — ${one.scheme}</p>
<div class="surface">${one.html}</div></div>`;
}

function render(
  name: string,
  label: string,
  scheme: Scheme,
  element: ReactElement,
  height: number,
  /** A control to press before the picture is taken, for a second screen. */
  pressFirst?: string,
): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host, { onUncaughtError: () => {}, onCaughtError: () => {} });
  // `react-native-web` caches the window size and only re-reads it on `resize`,
  // so the size set at the top of this file has to be announced.
  window.dispatchEvent(new Event("resize"));
  act(() => root.render(createElement(ThemeProvider, { scheme, children: element })));
  if (pressFirst !== undefined) {
    const node = host.querySelector<HTMLElement>(`[data-testid="${pressFirst}"]`);
    if (node === null) throw new Error(`no control with testID ${pressFirst}`);
    act(() => {
      for (const type of ["mousedown", "mouseup", "click"]) {
        node.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      }
    });
  }
  rendered.push({
    name,
    label,
    scheme,
    html: host.innerHTML,
    height,
    liveEditorCss: document.getElementById(LIVE_EDITOR_STYLE_ID)?.textContent ?? "",
  });
  act(() => root.unmount());
  host.remove();
}

function resolver(review: ConflictReview): ReactElement {
  return createElement(ConflictResolver, {
    review,
    onKeepTheirs: () => {},
    onResolveWith: () => {},
  });
}

describe("conflict shots", () => {
  test("write them", () => {
    for (const scheme of ["light", "dark"] as const) {
      render(
        `conflict-choices-${scheme}`,
        "Three answers, and nothing written yet",
        scheme,
        resolver(REVIEW),
        780,
      );
      render(
        `conflict-review-${scheme}`,
        "The proposed merge, editable, saved only on its own button",
        scheme,
        resolver(REVIEW),
        620,
        "conflict-merge",
      );
      render(
        `conflict-no-merge-${scheme}`,
        "No ancestor on this device, so no merge is offered",
        scheme,
        resolver(NO_MERGE),
        780,
      );
    }

    const styles = [...document.styleSheets]
      .flatMap((sheet) => {
        try {
          return [...sheet.cssRules].map((rule) => rule.cssText);
        } catch {
          return [];
        }
      })
      .join("\n");

    fs.mkdirSync(OUT, { recursive: true });
    for (const one of rendered) {
      fs.writeFileSync(path.join(OUT, `${one.name}.html`), page(one, styles));
    }
  });
});
