/**
 * Photograph one published website page at phone, tablet and desktop widths,
 * and measure what a picture alone cannot show: horizontal overflow, whether
 * the bottom of the page can be scrolled to, boxes that clip their content,
 * pictures that did not load, and errors the page threw.
 *
 * Kept apart from `./index.ts` so the entry module exports only its handler
 * (workerd refuses an entry module with any other export), and so the tests
 * can drive it with a fake browser: there is no Browser Rendering in node.
 */

/** The three widths an agent asks for, by name, and the viewport each opens with. */
export const SIZES = {
  phone: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1280, height: 800 },
} as const;

export type SizeName = keyof typeof SIZES;

/** The tallest picture taken; a longer page is cut here and says so. */
export const MAX_SHOT_HEIGHT = 5_000;
/** How long one width may take to load before it is reported as failed. */
export const LOAD_TIMEOUT_MS = 25_000;

export interface ShootRequest {
  url: string;
  sizes: SizeName[];
}

export interface Measurements {
  /** How far the widest thing reaches past the right edge, in CSS pixels. */
  overflowX: number;
  /** The elements reaching furthest past it: `tag.class` and by how much. */
  wide: Array<{ element: string; by: number }>;
  /** Can the last pixel of the page be scrolled into view? */
  bottomReachable: boolean;
  scrollHeight: number;
  viewportHeight: number;
  /** Boxes that hide content taller than themselves. */
  clipped: Array<{ element: string; hidden: number }>;
  /** Pictures that did not load, by alt text. */
  brokenImages: string[];
  /** The page's outline: h1–h3 in order. */
  headings: string[];
  /** Characters of visible text, so an empty page is plain. */
  textLength: number;
}

export interface Shot {
  size: SizeName;
  width: number;
  height: number;
  truncated: boolean;
  /** JPEG, base64. */
  jpeg: string;
  measurements: Measurements;
  errors: string[];
}

export interface ShootResult {
  shots: Shot[];
  failures: Array<{ size: SizeName; reason: string }>;
}

/** What `./index.ts` hands us: the parts of puppeteer this file uses. */
export interface PageLike {
  setViewport(viewport: { width: number; height: number; deviceScaleFactor?: number; isMobile?: boolean; hasTouch?: boolean }): Promise<void>;
  goto(url: string, options: { waitUntil: "networkidle0" | "networkidle2" | "load"; timeout: number }): Promise<unknown>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
  evaluate<T>(source: string): Promise<T>;
  screenshot(options: { type: "jpeg"; quality: number; encoding: "base64"; fullPage: boolean }): Promise<string | Uint8Array>;
  on(event: "pageerror" | "console", handler: (value: unknown) => void): unknown;
  close(): Promise<void>;
}

export interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

/**
 * An https address on a public host, normalized, or null. Shared by every
 * route here: no credentials, no port, no bare IP, no local or internal name.
 */
export function publicHttpsUrl(url: unknown): string | null {
  if (typeof url !== "string" || url.length > 2_000) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // A trailing dot is the same name to a resolver — `localhost.` resolves
  // exactly where `localhost` does — so it comes off before the rules below
  // rather than after. Left on, that one character walks a local name past
  // every test here at once: `host === "localhost"` stops matching, `.local`,
  // `.internal` and `.localhost` stop being suffixes, and the dot itself
  // satisfies the `includes(".")` that otherwise refuses a single-label host.
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    !host.includes(".") ||
    /^[\d.]+$/.test(host) ||
    host.startsWith("[") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    return null;
  }
  return parsed.toString();
}

/**
 * The address must be an https page on a public host. The gateway only ever
 * sends the site's own address, built by the control plane, and nothing else
 * can reach this Worker; this is the second lock, so a mistake upstream can
 * never point a browser at a private network.
 */
export function parseShootRequest(body: unknown): ShootRequest | null {
  if (!body || typeof body !== "object") return null;
  const { url, sizes } = body as { url?: unknown; sizes?: unknown };
  const parsed = publicHttpsUrl(url);
  if (parsed === null) return null;
  const wanted = Array.isArray(sizes) ? sizes : Object.keys(SIZES);
  const valid = [...new Set(wanted)].filter((size): size is SizeName => typeof size === "string" && size in SIZES);
  if (valid.length === 0) return null;
  return { url: parsed, sizes: valid };
}

/**
 * Run in the page as a string, never a function: Wrangler's bundler adds
 * `__name()` calls to named functions, and a function serialized into the
 * page would call a helper that only exists in the Worker.
 */
export const MEASURE_SOURCE = `(() => {
  const vw = window.innerWidth;
  const describe = (el) => {
    const cls = typeof el.className === "string" ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2).join(".") : "";
    return el.tagName.toLowerCase() + (cls ? "." + cls : "");
  };
  const root = document.querySelector(".ctx-site") || document.body;
  const scroller = document.querySelector('[data-testid="site-scroll"]') || document.scrollingElement || document.documentElement;
  const scrollHeight = scroller.scrollHeight;
  const viewportHeight = scroller.clientHeight;
  scroller.scrollTop = scrollHeight;
  const bottomReachable = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
  scroller.scrollTop = 0;
  const wide = [];
  let overflowX = Math.max(0, document.documentElement.scrollWidth - vw, root.scrollWidth - root.clientWidth);
  const clipped = [];
  for (const el of root.querySelectorAll("*")) {
    const box = el.getBoundingClientRect();
    if (box.width > 0 && box.right > vw + 1) {
      const by = Math.round(box.right - vw);
      overflowX = Math.max(overflowX, by);
      wide.push({ element: describe(el), by });
    }
    if (el === scroller || el.contains(scroller)) continue;
    const style = getComputedStyle(el);
    if ((style.overflowY === "hidden" || style.overflowY === "clip") && el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 4) {
      clipped.push({ element: describe(el), hidden: el.scrollHeight - el.clientHeight });
    }
  }
  wide.sort((a, b) => b.by - a.by);
  clipped.sort((a, b) => b.hidden - a.hidden);
  const brokenImages = [...root.querySelectorAll("img")]
    .filter((img) => img.complete && img.naturalWidth === 0)
    .map((img) => img.getAttribute("alt") || "(no alt text)");
  const headings = [...root.querySelectorAll("h1, h2, h3")]
    .slice(0, 20)
    .map((h) => h.tagName.toLowerCase() + " " + (h.textContent || "").trim().slice(0, 80));
  return {
    overflowX: Math.round(overflowX),
    wide: wide.slice(0, 5),
    bottomReachable,
    scrollHeight,
    viewportHeight,
    clipped: clipped.slice(0, 5),
    brokenImages: brokenImages.slice(0, 10),
    headings,
    textLength: (root.innerText || "").trim().length,
  };
})()`;

/**
 * How many pixels of the page are still out of sight below the screen: the
 * document's own overflow, or the tallest scroll box that fills most of the
 * screen (a designed site scrolls in its own box; the app's pages scroll in
 * theirs). The full-length picture grows the screen by this much rather than
 * restyling the page: the app lays itself out to the screen's height, so
 * forcing its boxes open collapses it to nothing.
 */
export const HIDDEN_HEIGHT_SOURCE = `(() => {
  const screen = window.innerHeight;
  let hidden = document.documentElement.scrollHeight - screen;
  for (const el of document.querySelectorAll("body *")) {
    if (el.clientHeight < screen / 2) continue;
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY !== "auto" && overflowY !== "scroll") continue;
    hidden = Math.max(hidden, el.scrollHeight - el.clientHeight);
  }
  return Math.max(0, Math.round(hidden));
})()`;

/** Lets the page finish easing in, and lay itself out again after the screen grows. */
const SETTLE_SOURCE = "new Promise((resolve) => setTimeout(resolve, 600))";

function base64(data: string | Uint8Array): string {
  if (typeof data === "string") return data;
  let binary = "";
  for (let offset = 0; offset < data.length; offset += 0x8000) {
    binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function errorText(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.slice(0, 300);
}

async function shootOne(browser: BrowserLike, url: string, size: SizeName): Promise<Shot> {
  const viewport = SIZES[size];
  const page = await browser.newPage();
  const errors: string[] = [];
  try {
    page.on("pageerror", (error) => {
      if (errors.length < 5) errors.push(errorText(error));
    });
    page.on("console", (message) => {
      const entry = message as { type?: () => string; text?: () => string };
      if (entry.type?.() === "error" && errors.length < 5) errors.push(`console: ${errorText(entry.text?.())}`);
    });
    await page.setViewport({ ...viewport, deviceScaleFactor: 1, isMobile: size === "phone", hasTouch: size !== "desktop" });
    await page.goto(url, { waitUntil: "networkidle0", timeout: LOAD_TIMEOUT_MS });
    // A site draws into `.ctx-site`; the default look into the app's own page.
    await page.waitForSelector(".ctx-site, main, h1", { timeout: 8_000 }).catch(() => undefined);
    // Pages ease in (`Reveal`); let them finish before anything is measured.
    await page.evaluate(SETTLE_SOURCE);
    const measurements = await page.evaluate<Measurements>(MEASURE_SOURCE);
    // Grow the screen until nothing is hidden below it, or the cap: a page
    // that lays out to the screen's height may reveal more as it grows.
    let height: number = viewport.height;
    let truncated = false;
    for (let round = 0; round < 3; round += 1) {
      const hidden = await page.evaluate<number>(HIDDEN_HEIGHT_SOURCE);
      if (hidden <= 0) break;
      if (height >= MAX_SHOT_HEIGHT) {
        truncated = true;
        break;
      }
      height = Math.min(height + hidden, MAX_SHOT_HEIGHT);
      await page.setViewport({ width: viewport.width, height, deviceScaleFactor: 1, isMobile: size === "phone", hasTouch: size !== "desktop" });
      await page.evaluate(SETTLE_SOURCE);
    }
    const jpeg = base64(await page.screenshot({ type: "jpeg", quality: 60, encoding: "base64", fullPage: false }));
    return { size, width: viewport.width, height, truncated, jpeg, measurements, errors };
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Every requested width, one page at a time in one browser; a width that fails says why. */
export async function shoot(browser: BrowserLike, request: ShootRequest): Promise<ShootResult> {
  const shots: Shot[] = [];
  const failures: ShootResult["failures"] = [];
  try {
    for (const size of request.sizes) {
      try {
        shots.push(await shootOne(browser, request.url, size));
      } catch (error) {
        failures.push({ size, reason: errorText(error) });
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
  return { shots, failures };
}
