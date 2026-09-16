import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

/**
 * A REAL COMMUNITY PLUGIN, IN THE REAL SANDBOX, IN A REAL BROWSER.
 *
 * ## Why jsdom could not have caught what this caught
 *
 * Every other check on this shim asks whether a member exists and behaves. This
 * one asks the only question a reader has: does the plugin they installed run.
 *
 * Twice now the answer was no while every unit test was green, and both times
 * for the same shape — `class X extends <ns>.Something` evaluated at module
 * scope, on a name the shim did not export. That is not a missing feature, it
 * is `extends undefined` thrown before `onload`, and it takes the whole bundle
 * with it. The first was `SuggestModal`. Fixing it uncovered `Events`, which
 * nothing had ever listed, and `Modal` behind that.
 *
 * The scanner's list of absent members could not have found them because it was
 * a hand-written list of names somebody had thought of. This finds them by
 * running the thing.
 *
 * ## And the error the shipped path cannot report
 *
 * The shim evaluates a bundle in a `<script>` element. A `<script>` that throws
 * reports to `window.onerror`, not to the `try` around `appendChild` — so every
 * genuine load failure arrives at the console as the same sentence, "Plugin
 * bundle did not export a plugin class", whatever actually went wrong. The
 * frame is cross-origin, so the page cannot read those errors either.
 *
 * Playwright can, for every frame. `pageerror` is asserted empty here because
 * it is the only place the real cause is visible, and a run that only checked
 * the crash message would have reported "no export" three times for three
 * different bugs.
 */

async function sandboxDocument(): Promise<string> {
  // The variable preserves a native dynamic import under Playwright's CJS loader.
  const moduleName = "@context/obsidian-runtime";
  const runtime = (await import(moduleName)) as { pluginSandboxDocument: () => string };
  return runtime.pluginSandboxDocument();
}

/*
  The release is fetched by `e2e/webkit/fetch-bundles.mjs` rather than committed:
  it is four megabytes of somebody else's minified code, and the repository is
  not where that belongs. A missing file skips rather than fails, so the suite
  still runs offline — and the skip says which command fetches it.
*/
// Relative to `apps/mobile`, which is where the Playwright config runs from.
// `import.meta.url` is not available under its CommonJS loader.
const BUNDLE_PATH = "e2e/webkit/bundles/obsidian-bible-reference.js";

function bundle(): string | null {
  try {
    return readFileSync(BUNDLE_PATH, "utf8");
  } catch {
    return null;
  }
}

test("a real community plugin loads, and reaches the vault only through RPC", async ({ page }) => {
  const mainJs = bundle();
  test.skip(
    mainJs === null,
    "run `node e2e/webkit/fetch-bundles.mjs` to fetch the release this checks",
  );

  const uncaught: string[] = [];
  page.on("pageerror", (error) => uncaught.push(String(error)));

  const srcdoc = await sandboxDocument();
  await page.setContent("<main id=host>trusted</main>");
  const outcome = await page.evaluate(
    async ({ srcdoc, mainJs }) => {
      const nonce = "bundle-proof-nonce";
      const kinds: string[] = [];
      const asked: string[] = [];
      let crash: unknown = null;
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.srcdoc = srcdoc;
      const post = (message: Record<string, unknown>) =>
        frame.contentWindow?.postMessage({ source: "context-plugin-host", version: 1, ...message }, "*");

      const settled = new Promise<void>((resolve) => {
        window.addEventListener("message", (event) => {
          if (event.source !== frame.contentWindow) return;
          const message = event.data as Record<string, unknown>;
          kinds.push(String(message.type));
          if (message.type === "ready") {
            post({
              nonce,
              type: "load",
              manifestJson: JSON.stringify({
                id: "obsidian-bible-reference",
                name: "Bible Reference",
                version: "26.08.07",
              }),
              mainJs,
            });
          }
          if (message.type === "rpc") {
            /*
              The trusted host's job, reduced to the one operation a load needs.
              Answering it is what lets `onload` finish — without a reply the
              plugin waits forever and "loaded" never arrives, which looks
              identical to a crash from out here.
            */
            const rpc = message.request as { requestId: string; operation: { kind: string } };
            asked.push(rpc.operation.kind);
            post({
              type: "rpc-result",
              response:
                rpc.operation.kind === "settings.load"
                  ? { version: 1, requestId: rpc.requestId, ok: true, result: { json: "{}", etag: null } }
                  : {
                      version: 1,
                      requestId: rpc.requestId,
                      ok: false,
                      error: { code: "NOT_GRANTED", message: "not granted in this check" },
                    },
            });
          }
          if (message.type === "crashed" || message.type === "error") crash = message;
          if (message.type === "loaded" || message.type === "crashed") resolve();
        });
      });
      document.body.appendChild(frame);
      await Promise.race([settled, new Promise<void>((r) => setTimeout(r, 20000))]);
      // A beat for anything `onload` scheduled to finish crashing, if it will.
      await new Promise((r) => setTimeout(r, 300));
      return { kinds, asked, crash };
    },
    { srcdoc, mainJs: mainJs! },
  );

  expect(
    outcome.crash,
    `the plugin crashed: ${JSON.stringify(outcome.crash)} (uncaught: ${uncaught.join("; ")})`,
  ).toBeNull();
  expect(
    uncaught,
    "an uncaught error in the plugin frame — the shipped path reports these as \"did not export a plugin class\"",
  ).toEqual([]);
  expect(outcome.kinds).toContain("loaded");
  // It reached storage, and only the way everything reaches storage.
  expect(outcome.asked).toContain("settings.load");
});
