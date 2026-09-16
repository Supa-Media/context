import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

/**
 * TAKING a real plugin's suggestion, not just being offered one.
 *
 * `pluginSuggestEditor.test.ts` proves the editor half thoroughly, and every
 * one of its picks calls the completion's `apply` against a stubbed `pick`. So
 * the half nobody had ever run was the one that matters to a reader: the real
 * plugin's own `selectSuggestion`, against the real shim, producing the line
 * that replaces theirs.
 *
 * Reported from the shipped app as "this pops up but I can't even click it" —
 * which is what a pick that resolves to the unchanged line looks like from the
 * outside. Nothing errors; nothing happens.
 */

async function sandboxDocument(): Promise<string> {
  const moduleName = "@context/obsidian-runtime";
  const runtime = (await import(moduleName)) as { pluginSandboxDocument: () => string };
  return runtime.pluginSandboxDocument();
}

const BUNDLE_PATH = "e2e/webkit/bundles/obsidian-bible-reference.js";

function bundle(): string | null {
  try {
    return readFileSync(BUNDLE_PATH, "utf8");
  } catch {
    return null;
  }
}

test("a real plugin's suggestion can be taken, and rewrites the line", async ({ page }) => {
  const mainJs = bundle();
  test.skip(mainJs === null, "run `node e2e/webkit/fetch-bundles.mjs` first");

  const uncaught: string[] = [];
  page.on("pageerror", (error) => uncaught.push(String(error)));

  const srcdoc = await sandboxDocument();
  await page.setContent("<main id=host>trusted</main>");
  const outcome = await page.evaluate(
    async ({ srcdoc, mainJs }) => {
      const nonce = "suggest-proof-nonce";
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.srcdoc = srcdoc;
      const post = (message: Record<string, unknown>) =>
        frame.contentWindow?.postMessage({ source: "context-plugin-host", version: 1, ...message }, "*");

      let results: { text: string }[] | null = null;
      let applied: string | null = null;
      const loaded = new Promise<void>((resolve) => {
        window.addEventListener("message", (event) => {
          if (event.source !== frame.contentWindow) return;
          const message = event.data as Record<string, unknown>;
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
          if (message.type === "suggest-results") results = message.items as { text: string }[];
          if (message.type === "suggest-applied") applied = String(message.line);
          if (message.type === "rpc") {
            const rpc = message.request as { requestId: string; operation: { kind: string } };
            post({
              type: "rpc-result",
              response: rpc.operation.kind === "settings.load" || rpc.operation.kind === "settings.save"
                ? { version: 1, requestId: rpc.requestId, ok: true, result: { json: "{}", etag: null } }
                : {
                    version: 1,
                    requestId: rpc.requestId,
                    ok: false,
                    error: { code: "NOT_GRANTED", message: "not granted in this check" },
                  },
            });
          }
          if (message.type === "loaded" || message.type === "crashed") resolve();
        });
      });
      document.body.appendChild(frame);
      await Promise.race([loaded, new Promise<void>((r) => setTimeout(r, 20000))]);

      // The report's own line is "> Heb 11:1"; a few shapes are tried so a
      // zero here means the plugin offers nothing, not that we typed the
      // wrong marker.
      // The real console always has a note open when a suggester runs, and
      // onTrigger is handed that file. Without it a suggester that checks its
      // file offers nothing, which is the harness lying rather than the plugin.
      post({ type: "active-file", path: "1-projects/study.md", etag: "e1" });
      await new Promise((r) => setTimeout(r, 300));
      /*
        The plugin's own trigger, read out of its bundle rather than guessed:
        the first two characters of the line must match /--|(\+\+)/ and the
        rest must be at least five characters. "--- Heb" fails on the second
        rule, which is how three wrong guesses looked exactly like a plugin
        offering nothing.
      */
      const tries = ["--Heb 11:1", "-- Heb 11:1", "++Heb 11:1", "--John 3:16"];
      let line = tries[0];
      for (const candidate of tries) {
        results = null;
        post({ type: "suggest-query", seq: 1, line: candidate, ch: candidate.length });
        await new Promise((r) => setTimeout(r, 3000));
        if (results && (results as { text: string }[]).length > 0) { line = candidate; break; }
      }
      post({ type: "suggest-apply", seq: 2, index: 0 });
      await new Promise((r) => setTimeout(r, 4000));
      return { results, applied, line };
    },
    { srcdoc, mainJs: mainJs! },
  );

  expect(uncaught, `uncaught: ${uncaught.join("; ")}`).toEqual([]);
  expect(outcome.results, "the plugin offered a suggestion").not.toBeNull();
  expect((outcome.results ?? []).length, "at least one row to press").toBeGreaterThan(0);

  /*
    The assertion the report is about. A pick that resolves to the line
    unchanged is indistinguishable, from the reader's side, from a row that
    cannot be pressed at all.
  */
  expect(outcome.applied, "the pick produced a line").not.toBeNull();
  expect(
    outcome.applied,
    `taking the suggestion left the line as it was: ${JSON.stringify(outcome.applied)}`,
  ).not.toBe(outcome.line);
});
