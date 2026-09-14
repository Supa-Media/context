import { expect, test } from "@playwright/test";

import { DRAWING_CHANNEL, DRAWING_EDITOR_PATH } from "../../features/console/files/drawingBridge";

/**
 * THE DRAWING EDITOR ASKS NOBODY BUT US FOR ANYTHING.
 *
 * Excalidraw registers every font as a `FontFace` whose `src` list ends, always
 * and unconditionally, with a URL on **esm.sh**. The browser walks that list in
 * order, so the third party is not reached only for as long as the URL in front
 * of it works. When it stops working the fetch goes out — at the moment
 * somebody opens their own private drawing, from a page whose URL says which
 * product they are using and whose timing says when they opened it.
 * `share/markdown.ts` already refuses the same thing in different clothes ("a
 * remote image in a shared note is a tracking pixel that reports every read to
 * whoever wrote it"); a font is that request with a different extension.
 *
 * `drawing-editor/assetPath.js` is the URL in front of it, and until this file
 * existed **the only thing standing behind that was a person loading the page
 * by hand and reading the network panel** — which `assetPath.js` said in as
 * many words. That is a guard nobody has checked between upgrades, which
 * `docs/decisions/testing.md` says is not a guard.
 *
 * It was also already wrong. `"./"` reads as "beside this page" and the package
 * normalizes it against the **origin**, so every scene font resolved to
 * `/fonts/<Family>/…`, 404'd, and fell through to esm.sh — while the canvas
 * drew happily in a fallback serif. Silent in both directions, and shipped.
 * This test is what found it.
 *
 * ## Why it lives in the WebKit suite
 *
 * The property is about what a *browser* fetches while rendering, so nothing
 * short of a real engine can observe it. jsdom loads no fonts at all, and a
 * unit test asserting the constant would have asserted `"./"` — the bug —
 * and passed.
 *
 * ## The vacuity trap this is built around
 *
 * "No external requests" is trivially true of a page that never loaded, and
 * nearly true of one that loaded and never drew. A broken bundle, a 404, a
 * renamed output file — each makes a naive version of this pass while proving
 * nothing, and that is the most likely way for it to rot.
 *
 * It is subtler than it looks, too: the editor's *interface* font comes from
 * `editor.css`, whose `url()` is resolved against the stylesheet and is
 * therefore same-origin no matter what `EXCALIDRAW_ASSET_PATH` says. An earlier
 * draft of this test counted those and passed against a build with the asset
 * path deleted outright. So the assertion is about the font of the **drawing**,
 * named and required, and about the browser reporting that face `loaded` rather
 * than `error` — the state the shipped bug actually produced.
 */

/** Requests to these are the whole point; anything here is a failure. */
const KNOWN_CDNS = ["esm.sh", "unpkg.com", "cdn.jsdelivr.net", "cdnjs.cloudflare.com", "fonts.gstatic.com"];

/**
 * The family the scene below is drawn in, and the number that selects it.
 *
 * Pinned together on purpose. If a future version renumbers its families this
 * test fails rather than quietly drawing in something else — which is the
 * correct behaviour for a guard whose subject is *which* file got fetched.
 */
const SCENE_FONT_FAMILY = "Excalifont";
const SCENE_FONT_FAMILY_ID = 5;

/** Where a font of ours has to come from: beside the page, never the origin root. */
const OUR_FONT_DIRECTORY = `/drawing-assets/editor/fonts/${SCENE_FONT_FAMILY}/`;

test.describe("the drawing editor is served entirely from our own origin", () => {
  /*
    Longer than the suite's 30s default, and not because anything here is slow
    to decide: this is 8MB of script compiled and executed from cold, and the
    test waits on several things happening in order rather than one. A CI runner
    that needs 40s for that is not the failure this file is looking for.
  */
  test.setTimeout(90_000);

  test("draws its scene in a font from us, and asks no third party for anything", async ({ page, baseURL }) => {
    const ourOrigin = new URL(baseURL ?? "http://127.0.0.1").origin;

    /*
      Every request the page makes, recorded rather than blocked. Blocking would
      turn a leak into a *passing* test with a quietly broken page — exactly the
      vacuity above. Recording lets the page behave as it would for a customer
      and then reports what it did.

      `data:` and `blob:` are the page talking to itself and carry no request.
      Anything whose URL will not parse counts as off-origin rather than being
      skipped: a URL we cannot read is not evidence that it was ours.
    */
    const offOrigin: string[] = [];
    const fromUs: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.startsWith("data:") || url.startsWith("blob:")) return;
      let origin: string | null = null;
      try {
        origin = new URL(url).origin;
      } catch {
        origin = null;
      }
      if (origin === ourOrigin) fromUs.push(url);
      else offOrigin.push(url);
    });

    /*
      The page announces itself with `ready` before it will accept anything, and
      posts that to `window.parent` — which, loaded directly rather than in an
      iframe, is this same window. Listening from an init script puts the
      listener in place before the bundle runs, so the announcement cannot be
      missed in the gap between `load` firing and React's effects running.
    */
    await page.addInitScript((channel) => {
      (window as unknown as { __editorReady?: boolean }).__editorReady = false;
      window.addEventListener("message", (event: MessageEvent) => {
        const data = event.data as { channel?: string; type?: string } | null;
        if (data && data.channel === channel && data.type === "ready") {
          (window as unknown as { __editorReady?: boolean }).__editorReady = true;
        }
      });
    }, DRAWING_CHANNEL);

    await page.goto(DRAWING_EDITOR_PATH);
    await page.waitForFunction(() => (window as unknown as { __editorReady?: boolean }).__editorReady === true);

    /*
      Hand it a drawing, because an idle editor renders nothing: `entry.jsx`
      returns null until a `load` arrives, and no scene font is fetched for a
      canvas that was never drawn. This is the message the console sends, on the
      channel `drawingBridge.ts` defines.
    */
    await page.evaluate(
      ({ channel, fontFamily }) => {
        window.postMessage(
          {
            channel,
            type: "load",
            editable: true,
            theme: "light",
            appState: {},
            elements: [
              {
                id: "a",
                type: "text",
                x: 0,
                y: 0,
                width: 200,
                height: 30,
                text: "Cassowary",
                fontSize: 20,
                fontFamily,
                strokeColor: "#1e1e1e",
                backgroundColor: "transparent",
                opacity: 100,
                angle: 0,
                groupIds: [],
                seed: 1,
                version: 1,
                versionNonce: 1,
                isDeleted: false,
              },
            ],
          },
          "*"
        );
      },
      { channel: DRAWING_CHANNEL, fontFamily: SCENE_FONT_FAMILY_ID }
    );

    // (1) It actually drew. Without this the rest passes on a blank page.
    await expect(page.locator("canvas").first()).toBeVisible({ timeout: 30_000 });

    // (2) It actually fetched the *drawing's* font, from beside the page. Not
    //     "a font" — the interface font would satisfy that from the stylesheet
    //     with the asset path deleted entirely.
    await expect
      .poll(() => fromUs.filter((url) => url.includes(OUR_FONT_DIRECTORY)).length, {
        timeout: 30_000,
        message: `no ${SCENE_FONT_FAMILY} was requested from ${ourOrigin}${OUR_FONT_DIRECTORY}`,
      })
      .toBeGreaterThan(0);

    /*
      (3) And the browser accepted it. This is the half that caught the shipped
          bug: the request went out, 404'd into the SPA's `index.html`, and the
          face went to `error` — at which point the browser moved down the `src`
          list to esm.sh. A face that never reaches `loaded` is a leak waiting
          for a slow network to expose it, even on a run where nothing left.
    */
    await expect
      .poll(
        () =>
          page.evaluate(
            (family) =>
              Array.from(document.fonts).some((face) => face.family === family && face.status === "loaded"),
            SCENE_FONT_FAMILY
          ),
        { timeout: 30_000, message: `${SCENE_FONT_FAMILY} never reached status "loaded"` }
      )
      .toBe(true);

    // (4) And only then: nothing went anywhere else.
    expect(
      offOrigin,
      `the editor requested ${offOrigin.length} off-origin URL(s):\n${offOrigin.join("\n")}`
    ).toEqual([]);

    /*
      Named as well as counted. The assertion above already fails on any of
      these, but a reader should be able to see what this guards against without
      reconstructing it, and a failure here says *which* CDN rather than only
      that there was one.
    */
    for (const host of KNOWN_CDNS) {
      expect(offOrigin.join("\n"), `the editor requested something from ${host}`).not.toContain(host);
    }
  });
});
