/**
 * @jest-environment jsdom
 *
 * A render harness, not a test. Writes the offline UI to static HTML files so
 * Playwright can screenshot them. Not matched by `jest.config.js`'s `testMatch`
 * — run it deliberately:
 *
 *   npx jest --testMatch '**\/shots.render.ts'
 */

import { describe, test } from "@jest/globals";
import { createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import * as fs from "fs";
import * as path from "path";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ThemeProvider } =
  require("../features/design/theme") as typeof import("../features/design/theme");
const { StatusBar } =
  require("../features/design/components/StatusBar") as typeof import("../features/design/components/StatusBar");
const { NoteEditor } =
  require("../features/console/files/NoteEditor") as typeof import("../features/console/files/NoteEditor");
const { statusSegments } =
  require("../features/console/files/status") as typeof import("../features/console/files/status");
const { editorReducer, emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");

type EditorState = import("../features/console/files/editor").EditorState;
type SyncFacts = import("../features/offline/copy").SyncFacts;

const OUT = path.join(__dirname, "..", "..", "..", "docs", "shots");

const NOTE = {
  path: "1-projects/pilot.md",
  text: "# Pilot\n\nNotes from the train. The tunnel took the signal at Reading.\n",
  etag: "e1",
  visibility: "private" as const,
  inherited: "private" as const,
  exception: false,
  readOnly: false,
};

const ZERO = { pending: 0, conflicted: 0, rejected: 0 };

function page(label: string, body: string, styles: string, tall: boolean): string {
  return `<!doctype html><meta charset="utf-8"><title>${label}</title>
<style>${styles}
  body { margin: 0; background: #0d0d0f; font-family: -apple-system, system-ui, sans-serif; }
  .frame { width: 900px; margin: 0 auto; padding: 24px; }
  .label { color: #8a8a92; font-size: 12px; letter-spacing: .06em;
           text-transform: uppercase; margin: 0 0 10px; }
  .surface { border: 1px solid #24242a; border-radius: 12px; overflow: hidden;
             display: flex; flex-direction: column; ${tall ? "height: 420px;" : ""} }
  .surface > div { flex: 1 1 auto; min-height: 0; }
</style>
<div class="frame"><p class="label">${label}</p><div class="surface">${body}</div></div>`;
}

/*
  Markup is collected during the run and written at the end, because
  `react-native-web` injects its stylesheet into the document lazily — the first
  page written mid-run got a nearly empty sheet and laid its status bar out
  vertically. Writing everything against the final, accumulated sheet is the fix.
*/
const rendered: { name: string; label: string; html: string; tall: boolean }[] = [];

function render(name: string, label: string, element: ReactElement, tall = false): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  // Pinned dark: jsdom reports no system appearance, and the page's own ground
  // below is the app's dark one. Both palettes are already asserted for
  // contrast in `theme.test.ts`; this is a picture, not a check.
  act(() => root.render(createElement(ThemeProvider, { scheme: "dark", children: element })));
  rendered.push({ name, label, html: host.innerHTML, tall });
  act(() => root.unmount());
  host.remove();
}

function writeAll(): void {
  /*
    Read out of the CSSOM, not out of `style.textContent`.

    `react-native-web` registers most of its rules with `insertRule`, which
    leaves the `<style>` element's text empty — so a harness that serialised the
    tag got a sheet with the colours in it and none of the layout, and every
    status bar came out stacked vertically instead of in a row.
  */
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
    fs.writeFileSync(
      path.join(OUT, `${one.name}.html`),
      page(one.label, one.html, styles, one.tall),
    );
  }
}

function strip(editor: EditorState, sync?: SyncFacts): ReactElement {
  return createElement(StatusBar, {
    segments: statusSegments({ editor, storageLabel: "R2 · brain", now: Date.now(), sync }),
  });
}

describe("offline shots", () => {
  test("write them", () => {
    /* ---------- offline, with three writes waiting ---------- */
    const queued = editorReducer(
      editorReducer(editorReducer(emptyEditor, { type: "opened", note: NOTE }), {
        type: "edited",
        text: `${NOTE.text}\nThe tunnel took the signal at Reading.\n`,
      }),
      {
        type: "saveQueued",
        message:
          "No connection, so this is written down on this device and will be sent when you are back.",
      },
    );
    render(
      "offline-queued",
      "Offline, with three writes waiting",
      strip(queued, {
        reachability: "offline",
        counts: { ...ZERO, pending: 3 },
        durable: true,
        conditionalWrite: true,
      }),
    );

    /* ---------- a conflict waiting for a person ---------- */
    const conflicted = editorReducer(
      editorReducer(editorReducer(emptyEditor, { type: "opened", note: NOTE }), {
        type: "edited",
        text: `${NOTE.text}\nMine, typed offline.\n`,
      }),
      {
        type: "saveFailed",
        error: {
          code: "CONFLICT",
          message: "That file changed somewhere else while you were editing it.",
          currentEtag: "e2",
        },
      },
    );
    render(
      "offline-conflict",
      "A conflict, parked and waiting for a person",
      createElement(
        "div",
        null,
        createElement(NoteEditor, {
          state: conflicted,
          canEdit: true,
          onChange: () => {},
          onSave: () => {},
          onDiscard: () => {},
          onUseTheirs: () => {},
          onKeepMine: () => {},
        }),
      ),
      true,
    );
    render(
      "offline-conflict-strip",
      "Two notes need a person, and it names them",
      strip(conflicted, {
        reachability: "online",
        counts: { ...ZERO, conflicted: 2 },
        durable: true,
        conditionalWrite: false,
        stuckPaths: ["1-projects/pilot.md", "2-areas/reading.md"],
      }),
    );

    /* ---------- a note read off the device ---------- */
    const cached = editorReducer(emptyEditor, {
      type: "opened",
      note: NOTE,
      fromCache: true,
      notice: "Showing the copy on this device, read 2 hours ago.",
    });
    render(
      "offline-cached",
      "A note read off the device, never drawn as current",
      strip(cached, {
        reachability: "offline",
        counts: ZERO,
        durable: false,
        conditionalWrite: true,
      }),
    );

    writeAll();
  });
});
