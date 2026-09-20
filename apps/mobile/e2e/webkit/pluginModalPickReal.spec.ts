import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

/**
 * THE REPORT, END TO END, AGAINST THE REAL PLUGIN.
 *
 * "This plugin still does not work — when I click on the verse, nothing
 * happens; it is supposed to insert the text into the page."
 *
 * The flow behind that sentence is Bible Reference's **Verse Lookup**: a
 * command opens a `SuggestModal`, the console draws its rows, and the pick runs
 * the plugin's `onChooseSuggestion`, which ends in
 *
 *     this.app.workspace.getActiveViewOfType(MarkdownView)?.editor
 *       .replaceRange(content, editor.getCursor())
 *
 * `getActiveViewOfType` answered `null`, so the optional chain stopped there:
 * the handler ran, wrote nothing, threw nothing, and the row simply appeared
 * not to work. `pluginActiveView.test.ts` proves the mechanism against a plugin
 * written for the test; this proves it against the released bundle, whose own
 * code is the thing that has to find a view it recognises — including
 * `MarkdownView` being the class it asked for.
 *
 * Kept in the browser suite for `pluginBundles.spec.ts`'s reason: only running
 * the real release has ever caught the failures in this area.
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

test("a real plugin's dialog pick writes the verse into the open note", async ({ page }) => {
  const mainJs = bundle();
  test.skip(mainJs === null, "run `node e2e/webkit/fetch-bundles.mjs` first");

  const uncaught: string[] = [];
  page.on("pageerror", (error) => uncaught.push(String(error)));

  const srcdoc = await sandboxDocument();
  await page.setContent("<main id=host>trusted</main>");
  const outcome = await page.evaluate(
    async ({ srcdoc, mainJs }) => {
      const nonce = "modal-pick-proof-nonce";
      const note = { path: "2-areas/bible-study/2-kings-4.md", text: "# 2 Kings 4\n", etag: "e1" };
      const kinds: string[] = [];
      let rows: { text: string }[] | null = null;
      let picked: { reason: string | null } | null = null;
      let written: string | null = null;

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
          if (message.type === "suggest-modal-results") rows = message.items as { text: string }[];
          if (message.type === "suggest-modal-picked") {
            picked = { reason: (message.reason as string | null) ?? null };
          }
          if (message.type === "rpc") {
            const rpc = message.request as {
              requestId: string;
              operation: { kind: string; text?: string };
            };
            const kind = rpc.operation.kind;
            kinds.push(kind);
            const reply = (result: unknown) =>
              post({ type: "rpc-result", response: { version: 1, requestId: rpc.requestId, ok: true, result } });
            if (kind === "settings.load") reply({ json: "{}", etag: null });
            else if (kind === "settings.save") reply({});
            else if (kind === "vault.read") reply({ text: note.text, etag: note.etag });
            else if (kind === "vault.modify") {
              written = String(rpc.operation.text);
              note.text = written;
              note.etag = "e2";
              reply({ etag: note.etag });
            } else {
              /*
                Everything else is refused, which is the console's *default*
                grant set: read the notes, keep its own settings, no network.
                The plugin falls back to the verses bundled in its own release,
                so this stays offline and still inserts real text.
              */
              post({
                type: "rpc-result",
                response: {
                  version: 1,
                  requestId: rpc.requestId,
                  ok: false,
                  error: { code: "CAPABILITY_DENIED", message: "not granted in this check" },
                },
              });
            }
          }
          if (message.type === "loaded" || message.type === "crashed") resolve();
        });
      });
      document.body.appendChild(frame);
      await Promise.race([loaded, new Promise<void>((r) => setTimeout(r, 20000))]);

      // The console always has a note open when somebody runs this command.
      post({ type: "active-file", path: note.path, etag: note.etag });
      await new Promise((r) => setTimeout(r, 300));

      // The plugin's own command id, read out of its bundle rather than
      // guessed: this is the "Verse Lookup" the ribbon icon opens too.
      post({ type: "command", id: "obr-lookup" });
      await new Promise((r) => setTimeout(r, 500));
      post({ type: "suggest-modal-query", seq: 1, query: "2 Kings 4:1" });
      await new Promise((r) => setTimeout(r, 4000));
      post({ type: "suggest-modal-pick", seq: 2, index: 0 });
      await new Promise((r) => setTimeout(r, 4000));

      return { rows, picked, written, note: note.text, kinds };
    },
    { srcdoc, mainJs: mainJs! },
  );

  expect(uncaught, `uncaught: ${uncaught.join("; ")}`).toEqual([]);
  expect((outcome.rows ?? []).length, "the plugin offered a verse to pick").toBeGreaterThan(0);

  /*
    The assertion the report is about: the pick reaches the note. Before this,
    `kinds` held a `settings.load` and nothing else — no read, no write, and a
    reader looking at an unchanged note.
  */
  expect(outcome.kinds, "the pick read the open note and wrote it back").toEqual(
    expect.arrayContaining(["vault.read", "vault.modify"]),
  );
  expect(outcome.written, "something was written").not.toBeNull();
  expect(outcome.note, "the note kept what was already in it").toContain("# 2 Kings 4");
  expect(outcome.note, "and gained the reference the reader picked").toContain("2 Kings 4:1");
  // Nothing to complain about: the console draws a reason only when the pick
  // could not be applied, and this one was.
  expect(outcome.picked).toEqual({ reason: null });
});

/**
 * And the same pick, with the grant the console hands out by default.
 *
 * `enableCapabilities` gives a plugin read and its own settings, never write —
 * on purpose, so nobody grants a write by pressing one button. That means the
 * *first* thing a reader does with a freshly enabled Bible Reference is a pick
 * that cannot be applied, and the difference between this being a bug report
 * and a one-line instruction is whether the console says which.
 */
test("and a pick with no write grant says so rather than nothing", async ({ page }) => {
  const mainJs = bundle();
  test.skip(mainJs === null, "run `node e2e/webkit/fetch-bundles.mjs` first");

  const srcdoc = await sandboxDocument();
  await page.setContent("<main id=host>trusted</main>");
  const outcome = await page.evaluate(
    async ({ srcdoc, mainJs }) => {
      const nonce = "modal-pick-denied-nonce";
      const note = { path: "2-areas/bible-study/2-kings-4.md", text: "# 2 Kings 4\n", etag: "e1" };
      let picked: { reason: string | null } | null = null;
      let wrote = false;

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
              manifestJson: JSON.stringify({ id: "obsidian-bible-reference", version: "26.08.07" }),
              mainJs,
            });
          }
          if (message.type === "suggest-modal-picked") {
            picked = { reason: (message.reason as string | null) ?? null };
          }
          if (message.type === "rpc") {
            const rpc = message.request as { requestId: string; operation: { kind: string } };
            const kind = rpc.operation.kind;
            if (kind === "vault.modify") wrote = true;
            const ok = kind === "settings.load" || kind === "settings.save" || kind === "vault.read";
            post({
              type: "rpc-result",
              response: ok
                ? {
                    version: 1,
                    requestId: rpc.requestId,
                    ok: true,
                    result: kind === "vault.read"
                      ? { text: note.text, etag: note.etag }
                      : { json: "{}", etag: null },
                  }
                : {
                    version: 1,
                    requestId: rpc.requestId,
                    ok: false,
                    error: { code: "CAPABILITY_DENIED", message: "not granted in this check" },
                  },
            });
          }
          if (message.type === "loaded" || message.type === "crashed") resolve();
        });
      });
      document.body.appendChild(frame);
      await Promise.race([loaded, new Promise<void>((r) => setTimeout(r, 20000))]);
      post({ type: "active-file", path: note.path, etag: note.etag });
      await new Promise((r) => setTimeout(r, 300));
      post({ type: "command", id: "obr-lookup" });
      await new Promise((r) => setTimeout(r, 500));
      post({ type: "suggest-modal-query", seq: 1, query: "2 Kings 4:1" });
      await new Promise((r) => setTimeout(r, 4000));
      post({ type: "suggest-modal-pick", seq: 2, index: 0 });
      await new Promise((r) => setTimeout(r, 4000));
      return { picked, wrote, note: note.text };
    },
    { srcdoc, mainJs: mainJs! },
  );

  expect(outcome.wrote, "the refusal is the broker's, not the guest's").toBe(true);
  expect(outcome.note, "and the note is exactly as it was").toBe("# 2 Kings 4\n");
  /*
    `not-allowed`, which the console turns into "turn on Create and change
    notes" — a sentence somebody can act on, in place of the silence this whole
    change is about.
  */
  expect(outcome.picked).toEqual({ reason: "not-allowed" });
});
