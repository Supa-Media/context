/**
 * @jest-environment jsdom
 *
 * A render harness, not a test — see `shots.render.ts`'s own header for the
 * pattern this copies. Writes a static HTML page showing a resolved `[[link]]`
 * as it is actually drawn, so a real browser (Playwright, not jsdom) can
 * screenshot it at a phone's width. Not matched by `jest.config.js`'s
 * `testMatch`; run it deliberately:
 *
 *   npx jest --testMatch '**\/linkAffordanceShot.render.ts'
 *
 * L3 (`docs/decisions/app-and-console.md`): the tooltip that tells a pointer
 * user "⌘-click to open" tells a phone nothing, so the affordance that has to
 * reach a touch screen is the underline itself — density-independent, per
 * `noteLinks.ts`'s `linkTheme`. This is the picture that proves it at the
 * width it matters on.
 */

import { describe, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import * as fs from "fs";
import * as path from "path";
import { noteLinks, type NoteLinkRef } from "../features/console/files/noteLinks";

const OUT = path.join(__dirname, "..", "..", "..", "docs", "design", "editor-polish", "shots");

describe("link affordance shot", () => {
  test("write it", () => {
    const ref: NoteLinkRef = {
      current: {
        path: "1-projects/persistence/overview.md",
        paths: ["1-projects/persistence/overview.md", "2-products/context-lc/overview.md"],
        onOpen: () => {},
        onPress: () => {},
      },
    };

    const parent = document.createElement("div");
    document.body.appendChild(parent);
    new EditorView({
      state: EditorState.create({
        doc:
          "Follow-up notes from the sync\n\n" +
          "See [[../../2-products/context-lc/overview]] for the current shape, " +
          "and file anything new under 1-projects.\n",
        extensions: [noteLinks(ref)],
      }),
      parent,
    });

    const styles = [...document.styleSheets]
      .flatMap((sheet) => {
        try {
          return [...sheet.cssRules].map((rule) => rule.cssText);
        } catch {
          return [];
        }
      })
      .join("\n");

    const html = `<!doctype html><meta charset="utf-8"><title>L3 — link affordance at compact density</title>
<style>
  ${styles}
  :root { --lp-link: #7aa2ff; --lp-bg: #0d0d0f; --lp-content: #e7e7ea; --lp-muted: #8a8a92; --lp-code-bg: #1c1c20; }
  html, body { margin: 0; height: 100%; background: var(--lp-bg); }
  body { font-family: -apple-system, system-ui, sans-serif; color: var(--lp-content); }
  .phone { width: 390px; min-height: 844px; box-sizing: border-box; padding: 24px 20px; }
  .cm-editor { font-size: 16px; line-height: 1.5; }
  .cm-content { padding: 0; }
  .cm-line { padding: 0; }
</style>
<div class="phone">${parent.innerHTML}</div>`;

    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, "l3-link-affordance.html"), html);
  });
});
