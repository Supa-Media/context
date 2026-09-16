import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

/**
 * A REAL PLUGIN'S SETTINGS PANE, DESCRIBED FROM THE REAL SANDBOX.
 *
 * `display()` is the most hostile thing a plugin runs on Context's behalf: the
 * pane this checks opens with a **sponsor iframe** and a **tracking image**,
 * both set through `innerHTML`, before it gets to a single control. So the
 * proof that matters is not that the controls arrive — it is that nothing else
 * does.
 *
 * Kept in the browser suite rather than jsdom for the reason
 * `pluginBundles.spec.ts` records: three separate load failures reached the
 * console as one misleading sentence, and running the real release is the only
 * check that has ever caught them.
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

test("a real plugin's settings pane describes its controls, and nothing else", async ({ page }) => {
  const mainJs = bundle();
  test.skip(
    mainJs === null,
    "run `node e2e/webkit/fetch-bundles.mjs` to fetch the release this checks",
  );

  const uncaught: string[] = [];
  page.on("pageerror", (error) => uncaught.push(String(error)));

  const srcdoc = await sandboxDocument();
  await page.setContent("<main id=host>trusted</main>");
  const panes = await page.evaluate(
    async ({ srcdoc, mainJs }) => {
      const nonce = "settings-proof-nonce";
      const seen: Record<string, unknown>[] = [];
      let hasTab = false;
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.srcdoc = srcdoc;
      const post = (message: Record<string, unknown>) =>
        frame.contentWindow?.postMessage({ source: "context-plugin-host", version: 1, ...message }, "*");

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
          if (message.type === "settings-tab") hasTab = true;
          if (message.type === "settings-pane") seen.push(message);
          if (message.type === "rpc") {
            const rpc = message.request as { requestId: string; operation: { kind: string } };
            post({
              type: "rpc-result",
              response: rpc.operation.kind === "settings.load"
                ? { version: 1, requestId: rpc.requestId, ok: true, result: { json: "{}", etag: null } }
                : rpc.operation.kind === "settings.save"
                  ? { version: 1, requestId: rpc.requestId, ok: true, result: {} }
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
      post({ type: "settings-pane-open" });
      // The pane's own display() awaits; a beat lets it settle and push again.
      await new Promise((r) => setTimeout(r, 1500));
      return { seen, hasTab };
    },
    { srcdoc, mainJs: mainJs! },
  );

  expect(uncaught, `uncaught in the plugin frame: ${uncaught.join("; ")}`).toEqual([]);
  expect(panes.hasTab, "the plugin registered a settings tab").toBe(true);

  const last = panes.seen[panes.seen.length - 1] as
    | { rows: Array<Record<string, unknown>>; error: string | null }
    | undefined;
  expect(last, "the pane described itself").toBeTruthy();
  const rows = last!.rows;

  // Real controls, with their real names.
  const named = rows.map((row) => String(row.name ?? row.text ?? ""));
  expect(named.join(" | ")).toContain("Verse Reference Position");
  /*
    The pane runs to the end rather than stopping part-way. It used to stop at
    the fourth row: `display()` called `settingEl.hide()`, which the shim did
    not have, and the throw was swallowed — so the reader got a pane silently
    missing seventeen of its twenty-one rows and no sign that anything was
    wrong. Both halves are fixed, and both are checked: the later headings are
    here, and `error` is null.
  */
  expect(named.join(" | ")).toContain("Others");
  expect(last!.error ?? null, "display() ran to the end").toBeNull();
  /*
    And the one setting the plugin HIDES is not offered. Bible Reference builds
    `Book Name Language` and hides it unless the version needs it; drawing it
    anyway would offer a setting the plugin itself refuses to show.
  */
  expect(named.join(" | ")).not.toContain("Book Name Language");
  expect(rows.some((row) => row.kind === "dropdown")).toBe(true);
  expect(rows.some((row) => row.kind === "toggle")).toBe(true);
  // A dropdown carries the options the plugin put in it.
  const dropdown = rows.find((row) => row.kind === "dropdown") as
    | { options: Array<{ value: string; label: string }> }
    | undefined;
  expect((dropdown?.options.length ?? 0) > 1).toBe(true);

  /*
    AND NOTHING THE PLUGIN BUILT OUT OF MARKUP.

    The sponsor iframe, the tracking image and every link in the footer. This
    is the assertion the whole inversion exists for — a settings pane is the
    one place a plugin writes raw `innerHTML` and expects it rendered.
  */
  const wire = JSON.stringify(rows);
  for (const forbidden of ["<iframe", "<img", "<a ", "href", "src=", "github.com/sponsors", "antioch.tech"]) {
    expect(wire, `the pane leaked ${forbidden}`).not.toContain(forbidden);
  }

  // Every control is addressed by its position, densely, from zero — the
  // property a change depends on to land on the row somebody pressed.
  const indices = rows.filter((row) => typeof row.index === "number").map((row) => row.index);
  expect(indices).toEqual(indices.map((_, at) => at));
});
