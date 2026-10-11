/**
 * Font loading — web.
 *
 * `public/index.html` already puts both font `<link>`s in the served
 * document, which is what avoids a flash of fallback type on a cold load. This
 * module is the belt to that brace: the shell is the *export's* document, and a
 * host that serves its own (or a future embed) would otherwise get system type.
 * Injecting from app code is idempotent and costs one DOM query.
 *
 * It is only ever the belt. This runs after the bundle has been fetched,
 * parsed and executed, which is the whole of the delay the head link exists to
 * cover — `__tests__/htmlShell.test.ts` pins the two hrefs together so a change
 * of family cannot land on one of them alone.
 */
export const FONT_STYLESHEET_ID = "context-fonts";

export const FONT_STYLESHEET_HREF =
  "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap";

/**
 * Libron, the reading face, is not on Google Fonts: its official web files are
 * served from our own origin, unmodified, with the OFL beside them
 * (`public/libron.css`, `public/Libron-OFL.txt`). Root-level paths on purpose:
 * a customer's domain serves only one-segment static files (`infra/router`'s
 * `site.ts`), and a published page is drawn in this face too.
 */
export const LIBRON_STYLESHEET_ID = "context-libron";

export const LIBRON_STYLESHEET_HREF = "/libron.css";

export function ensureFontsLoaded(): void {
  if (typeof document === "undefined") return;
  link(FONT_STYLESHEET_ID, FONT_STYLESHEET_HREF);
  link(LIBRON_STYLESHEET_ID, LIBRON_STYLESHEET_HREF);
}

function link(id: string, href: string): void {
  if (document.getElementById(id)) return;
  const node = document.createElement("link");
  node.id = id;
  node.rel = "stylesheet";
  node.href = href;
  document.head.appendChild(node);
}
