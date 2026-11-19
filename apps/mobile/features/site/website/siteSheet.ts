/**
 * A designed site's stylesheet as a constructed sheet the document adopts.
 *
 * A `<style>` element whose text script writes is inline style to a Content
 * Security Policy: under a `style-src` with no `'unsafe-inline'` (or with a
 * nonce or hash, which makes a browser ignore it) every designed site would
 * draw unstyled. The browser suite proves it (`e2e/webkit/websiteDesign.spec.ts`
 * under `E2E_CSP_CANDIDATE=full`). A constructed sheet is CSSOM, which a policy
 * does not govern, the way the note editor applies its own rules
 * (`features/console/files/liveEditorWeb/stylesheet.ts`, #2434).
 *
 * Where the browser has no constructable sheets (Safari before 16.4, jsdom),
 * or claims the API and then refuses the sheet, the caller keeps its `<style>`
 * element, which is what every browser drew before.
 */

type Adopting = Document & { adoptedStyleSheets?: CSSStyleSheet[] };

/** Whether this document can adopt a constructed sheet at all. */
export function canAdoptSheets(doc: Document | undefined = typeof document === "undefined" ? undefined : document): boolean {
  if (doc === undefined || typeof CSSStyleSheet === "undefined") return false;
  if (!Array.isArray((doc as Adopting).adoptedStyleSheets)) return false;
  try {
    const probe = new CSSStyleSheet();
    return typeof probe.replaceSync === "function";
  } catch {
    return false;
  }
}

/**
 * Adopt `css`, and the function that takes it back off the document; `null`
 * when the sheet could not be adopted, so the caller draws a `<style>` instead.
 */
export function adoptSiteSheet(css: string, doc: Document = document): (() => void) | null {
  const adopting = doc as Adopting;
  if (!canAdoptSheets(doc)) return null;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    adopting.adoptedStyleSheets = [...adopting.adoptedStyleSheets!, sheet];
    // A setter that ignored the sheet has adopted nothing.
    if (!adopting.adoptedStyleSheets!.includes(sheet)) return null;
    return () => {
      adopting.adoptedStyleSheets = adopting.adoptedStyleSheets!.filter((held) => held !== sheet);
    };
  } catch {
    return null;
  }
}
