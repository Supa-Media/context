import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

/**
 * A PLUGIN'S OWN `fetch`, ROUTED THROUGH THE GRANT.
 *
 * The sandbox CSP is `connect-src 'none'`, so nothing in the frame reaches the
 * network on its own — that is the boundary and it stays. What was missing is
 * that only `requestUrl` was brokered: Obsidian offers both, plugins use both,
 * and a plugin calling plain `fetch` got a `TypeError` with no explanation.
 *
 * Measured on the real Bible Reference release, which fetches its verses that
 * way. Its call was refused by the CSP, its own handler swallowed the failure,
 * and it served bundled fallback text **labelled with the translation the
 * reader had asked for and had not got** — a grant the owner had approved, a
 * capability the card claimed, and a wrong verse on the page.
 *
 * So this asserts three things that could not all be true before: the request
 * reaches the host as `network.request`, nothing is refused by the CSP, and the
 * text the plugin produces is the one the *broker* returned rather than
 * whatever it had lying around.
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

/** Wording that exists in no bundled fallback, so its presence proves the path. */
const BROKERED = "the substance of things hoped for, the evidence of things not seen";

test("a real plugin's fetch reaches the broker, and its answer is what the plugin uses", async ({
  page,
}) => {
  const mainJs = bundle();
  test.skip(mainJs === null, "run `node e2e/webkit/fetch-bundles.mjs` first");

  const blocked: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security Policy/.test(message.text())) {
      blocked.push(message.text());
    }
  });

  const srcdoc = await sandboxDocument();
  await page.setContent("<main id=host>trusted</main>");
  const outcome = await page.evaluate(
    async ({ srcdoc, mainJs, brokered }) => {
      const nonce = "network-proof-nonce";
      const asked: string[] = [];
      let items: { text: string }[] = [];
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
          if (message.type === "suggest-results") items = message.items as { text: string }[];
          if (message.type === "rpc") {
            const rpc = message.request as {
              requestId: string;
              operation: { kind: string; url?: string };
            };
            asked.push(rpc.operation.kind + (rpc.operation.url ? " " + rpc.operation.url : ""));
            if (rpc.operation.kind === "network.request") {
              /*
                The host's side of the broker, in the shape it really answers:
                a status, headers, and a base64 body. The verse returned here
                is deliberately the wording no fallback carries.
              */
              const body = JSON.stringify({
                reference: "Hebrews 11:1",
                translation_name: "King James Version",
                verses: [{ book_name: "Hebrews", chapter: 11, verse: 1, text: "Now faith is " + brokered + "." }],
                text: "Now faith is " + brokered + ".",
              });
              post({
                type: "rpc-result",
                response: {
                  version: 1,
                  requestId: rpc.requestId,
                  ok: true,
                  result: {
                    status: 200,
                    headers: [{ name: "content-type", value: "application/json" }],
                    bodyBase64: btoa(body),
                  },
                },
              });
              return;
            }
            post({
              type: "rpc-result",
              response:
                rpc.operation.kind === "settings.load" || rpc.operation.kind === "settings.save"
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

      const line = "--Heb 11:1";
      post({ type: "active-file", path: "1-projects/study.md", etag: "e1" });
      post({ type: "suggest-query", seq: 1, line, ch: line.length });
      await new Promise((r) => setTimeout(r, 6000));
      return { asked, items };
    },
    { srcdoc, mainJs: mainJs!, brokered: BROKERED },
  );

  expect(
    outcome.asked.join(" "),
    "the plugin's fetch was brokered rather than attempted directly",
  ).toContain("network.request");
  expect(blocked, "nothing was refused by the sandbox CSP").toEqual([]);
  expect(outcome.items.length, "the plugin offered a suggestion").toBeGreaterThan(0);
  /*
    The assertion that separates a working grant from a plugin quietly serving
    something else: the verse on offer is the one the broker returned.
  */
  expect(
    outcome.items.map((one) => one.text).join(" "),
    "the suggestion carries the broker's answer, not a bundled fallback",
  ).toContain(BROKERED);
});

/*
  THE SEMANTICS A REAL PLUGIN'S CODE DEPENDS ON.

  The release above proves the path; these prove the shape. A brokered `fetch`
  that does not behave like `fetch` is worse than none — a plugin branches on
  `res.ok`, reads `res.status`, calls `res.json()`, and catches a `TypeError`
  when the network is gone. Each of those is somebody's existing code.
*/
test("the brokered fetch behaves like fetch", async ({ page }) => {
  const srcdoc = await sandboxDocument();
  await page.setContent("<main id=host>trusted</main>");
  const results = await page.evaluate(
    async ({ srcdoc }) => {
      const nonce = "fetch-shape-nonce";
      const asked: Array<Record<string, unknown>> = [];
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.srcdoc = srcdoc;
      const post = (message: Record<string, unknown>) =>
        frame.contentWindow?.postMessage({ source: "context-plugin-host", version: 1, ...message }, "*");

      const PLUGIN = `
        const { Plugin } = require('obsidian');
        module.exports = class extends Plugin {
          async onload() {
            const out = {};
            // Ordinary success, with headers given as a plain object.
            const ok = await fetch('https://example.invalid/ok', {
              method: 'POST',
              headers: { 'X-Probe': 'one' },
              body: 'sent',
            });
            out.ok = { ok: ok.ok, status: ok.status, json: await ok.json() };
            // A server error is a RESOLVED fetch, not a rejection — the single
            // thing plugin code most often gets wrong if a shim throws here.
            const bad = await fetch('https://example.invalid/missing');
            out.missing = { ok: bad.ok, status: bad.status, text: await bad.text() };
            // A refusal from the host is a TypeError, like a dead network.
            try {
              await fetch('https://example.invalid/refused');
              out.refused = 'resolved, which is wrong';
            } catch (error) {
              out.refused = error instanceof TypeError ? 'TypeError: ' + error.message : 'wrong type';
            }
            /*
              One fact per status bar item. A single JSON blob is bounded at 120
              characters per item and was silently truncated, so the parse in the
              test threw — the cap is real and this is what it is for.
            */
            this.addStatusBarItem().setText('ok=' + out.ok.ok + '/' + out.ok.status + '/' + out.ok.json.hello);
            this.addStatusBarItem().setText('missing=' + out.missing.ok + '/' + out.missing.status + '/' + out.missing.text);
            this.addStatusBarItem().setText('refused=' + out.refused);
          }
        };
      `;

      /*
        The plugin's own results come back through the status bar, because the
        frame is cross-origin and nothing in it can be read directly. Writing
        them there is what makes `res.ok`, `res.status`, `res.json()` and the
        refusal's error TYPE assertable at all — the first version of this test
        returned `null` for all four and passed anyway.
      */
      let reported: string | null = null;
      const done = new Promise<void>((resolve) => {
        window.addEventListener("message", (event) => {
          if (event.source !== frame.contentWindow) return;
          const message = event.data as Record<string, unknown>;
          if (message.type === "ready") {
            post({ nonce, type: "load", manifestJson: '{"id":"fetch-shape"}', mainJs: PLUGIN });
          }
          if (message.type === "status-bar") {
            const rows = message.items as { text: string }[];
            // Wait for all three: the bar is re-sent as each item is added, so
            // an early frame carries only the first fact.
            if (rows.length >= 3) { reported = rows.map((row) => row.text).join(" | "); resolve(); }
          }
          if (message.type === "rpc") {
            const rpc = message.request as {
              requestId: string;
              operation: Record<string, unknown> & { kind: string; url?: string };
            };
            if (rpc.operation.kind !== "network.request") {
              post({
                type: "rpc-result",
                response: { version: 1, requestId: rpc.requestId, ok: true, result: { json: "{}", etag: null } },
              });
              return;
            }
            asked.push(rpc.operation);
            const url = String(rpc.operation.url);
            if (url.endsWith("/refused")) {
              post({
                type: "rpc-result",
                response: {
                  version: 1,
                  requestId: rpc.requestId,
                  ok: false,
                  error: { code: "NOT_GRANTED", message: "that host is not in this plugin's grant" },
                },
              });
              return;
            }
            const status = url.endsWith("/missing") ? 404 : 200;
            post({
              type: "rpc-result",
              response: {
                version: 1,
                requestId: rpc.requestId,
                ok: true,
                result: {
                  status,
                  headers: [{ name: "content-type", value: "application/json" }],
                  bodyBase64: btoa(status === 200 ? '{"hello":"world"}' : "gone"),
                },
              },
            });
          }
          if (message.type === "crashed") resolve();
        });
      });
      document.body.appendChild(frame);
      await Promise.race([done, new Promise<void>((r) => setTimeout(r, 15000))]);
      await new Promise((r) => setTimeout(r, 300));
      /*
        Widened on the way out: `reported` is only ever assigned inside a
        listener, so TypeScript's flow analysis still believes it is `null` here
        and narrows every assertion on it to `never`.
      */
      return { asked, reported: reported as string | null };
    },
    { srcdoc },
  );

  // What the host was asked for: the method, the body and the header the plugin
  // set all survive the crossing, in the shape `brokerNetworkRequest` reads.
  const first = results.asked[0] as
    | { kind: string; url: string; method: string; body?: string; headers: { name: string; value: string }[] }
    | undefined;
  expect(first?.method).toBe("POST");
  expect(first?.body).toBe("sent");
  expect(first?.headers.some((h) => h.name === "X-Probe" && h.value === "one")).toBe(true);
  // Three calls were made, including the one the host refused.
  expect(results.asked.map((one) => String(one.url))).toEqual([
    "https://example.invalid/ok",
    "https://example.invalid/missing",
    "https://example.invalid/refused",
  ]);

  // And what the plugin actually got back, which is the half its code branches on.
  expect(results.reported, "the plugin reported its results").not.toBeNull();
  const out = results.reported!;
  // `res.ok`, `res.status` and `res.json()` all behave.
  expect(out).toContain("ok=true/200/world");
  /*
    A 404 RESOLVES. Plugin code reads `res.ok` and handles the error itself; a
    shim that threw here would send every such plugin down its catch path with
    the wrong reason.
  */
  expect(out).toContain("missing=false/404/gone");
  // A refusal is a TypeError, like a dead network — and it carries the host's
  // own sentence, so a plugin that logs it gives the reader something to act on.
  expect(out).toContain("refused=TypeError");
  expect(out).toContain("not in this plugin's grant");
});
