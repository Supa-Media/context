import { expect, test, type Page } from "@playwright/test";

/**
 * Does `'self'` let an opaque-origin frame run its own script?
 *
 * The diagram renderer (`/drawing-assets/diagram/`) is framed with
 * `sandbox="allow-scripts"` and no `allow-same-origin`, so its document has
 * an opaque origin, and it loads `frame.js` from its own path. Its meta
 * policy says `script-src 'self'`; the router's report-only policy for that
 * path says `script-src 'self' …` too. Under the enforcing candidate the
 * WebKit run blocked `frame.js` while Chromium ran it, so the question is
 * what each engine matches `'self'` against in such a document: the URL's
 * origin, or the document's opaque one. This answers it without the app, in
 * frames served by `page.route`, one variable at a time:
 *
 *  - the same `'self'` delivered by a header, and by a meta tag;
 *  - the header with the frame's origin named explicitly beside `'self'`;
 *  - and, for contrast, a frame without the sandbox.
 *
 * Every case is recorded as an annotation, so a run says what the engine did
 * even where the expectation below is what fails.
 */

const ORIGIN = "https://context.test";
const RAN = "<script src=\"/frame.js\"></script>";

type Variant = { name: string; sandbox: boolean; header?: string; meta?: string };

const VARIANTS: Variant[] = [
  { name: "header-self", sandbox: true, header: "script-src 'self'" },
  { name: "meta-self", sandbox: true, meta: "script-src 'self'" },
  { name: "header-self-and-origin", sandbox: true, header: `script-src 'self' ${ORIGIN}` },
  { name: "header-self-unsandboxed", sandbox: false, header: "script-src 'self'" },
];

async function serve(page: Page): Promise<void> {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    if (url.pathname === "/host") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>host</title>" });
    if (url.pathname === "/frame.js") {
      return route.fulfill({ contentType: "text/javascript", body: "parent.postMessage({ ran: location.pathname }, '*');" });
    }
    const variant = VARIANTS.find((v) => url.pathname === `/${v.name}.html`);
    if (variant === undefined) return route.abort();
    const meta = variant.meta ? `<meta http-equiv="Content-Security-Policy" content="${variant.meta}">` : "";
    return route.fulfill({
      contentType: "text/html",
      headers: variant.header ? { "Content-Security-Policy": variant.header } : {},
      body: `<!doctype html><html><head>${meta}</head><body>${RAN}</body></html>`,
    });
  });
}

/** Which variants' script ran, by name. */
async function ranIn(page: Page): Promise<Record<string, boolean>> {
  await page.goto(`${ORIGIN}/host`);
  const ran = await page.evaluate(async (variants: Variant[]) => {
    const seen = new Set<string>();
    addEventListener("message", (event) => {
      const data = event.data as { ran?: unknown } | null;
      if (data && typeof data.ran === "string") seen.add(data.ran.replace(/^\/|\.html$/g, ""));
    });
    for (const variant of variants) {
      const frame = document.createElement("iframe");
      if (variant.sandbox) frame.setAttribute("sandbox", "allow-scripts");
      frame.src = `/${variant.name}.html`;
      document.body.append(frame);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return Object.fromEntries(variants.map((variant) => [variant.name, seen.has(variant.name)]));
  }, VARIANTS);
  return ran;
}

test("what 'self' matches in an opaque-origin frame, by delivery", async ({ page, browserName }) => {
  await serve(page);
  const ran = await ranIn(page);
  for (const [name, value] of Object.entries(ran)) {
    test.info().annotations.push({ type: `${browserName}:${name}`, description: value ? "ran" : "blocked" });
  }
  console.log(`[${browserName}] ${JSON.stringify(ran)}`);
  // The controls: naming the origin always works, and so does 'self' outside a sandbox.
  expect(ran["header-self-and-origin"], "the frame's own origin, named, lets its script run").toBe(true);
  expect(ran["header-self-unsandboxed"], "'self' in a same-origin frame lets its script run").toBe(true);
  // The meta tag is what the diagram page ships today, and it runs in every engine.
  expect(ran["meta-self"], "the diagram page's own meta 'self' lets its script run").toBe(true);
  // The case under test: the router's header 'self' in a sandboxed frame.
  expect(ran["header-self"], "a header 'self' lets an opaque-origin frame run its own script").toBe(true);
});
