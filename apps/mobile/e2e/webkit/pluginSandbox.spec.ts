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
