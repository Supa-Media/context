/**
 * Drive one browser for the texting assistant: open a page, click, type, pick
 * an option, go back, scroll, and read what is there now, across several
 * calls in one question.
 *
 * The gateway (`apps/mcp/src/agent/browse.js`) decides what may be opened and
 * what may be typed where; this file carries out a list of steps on one page
 * and is the second lock on two of those decisions, because only the browser
 * knows where the page is at the moment it types:
 *
 * - A `type` step may carry `onlyOn`, the sites the person named. The page's
 *   host is checked against it right before the keys go in, in the same
 *   connection, so a page that redirected in between gets nothing.
 * - A `fill` step (the vault's, never the model's) carries one exact origin,
 *   a value and the kind of field it is for. A password goes only into a
 *   password box, which no page echoes back as text, and a username only into
 *   a text, email or phone box. Its value is never returned, logged or shown
 *   in a reading. A card's part may also go into the checkout's payment
 *   frame, under the rules in `./paymentFrames.ts`.
 *
 * A reading numbers the things on the page a person could press or type into
 * (`data-tex-ref`), and never includes what is typed in a field: only whether
 * it has something in it. That is what keeps a filled password out of the
 * model's context.
 *
 * Kept apart from `./index.ts` for the reason `./shoot.ts` gives.
 */

import { publicHttpsUrl } from "./shoot";
import { dropSource, fillMarkedSource, markedSelector, markedSizeSource, pickerHookSource, pickerResult, refSelector as selector, uploadSource, sizeOf, type UploadFile, type Uploads } from "./picker";
import { DOWNLOAD_WAIT_MS, runDownload, type DownloadedFile, type Downloads } from "./download";
import { FRAME_REF_BASE, docMarking, docWith, framesOf, type Doc, type FrameDoc } from "./frames";
import { MAX_SCANNED, snapshot } from "./reading";
import { isCheckoutPaymentFrame } from "./paymentFrames";
import { COVERED_PRESS, SET_DIRECTLY, closePopup, coveredSource, domClickSource, typedOrSet } from "./popups";
export { dropSource, pickerHookSource, pickerResult, uploadSource, sizeOf, type UploadFile, type Uploads } from "./picker";

/*
  The gateway gives one tool call 20 seconds (`TOOL_TIMEOUT_MS`), and a call
  that outlives it loses the browser's session id with its answer. So a step
  starts only in the first 5 seconds, and the slowest step (open, then settle)
  ends within 12 more, leaving room to connect.
*/
/** How long a page may take to open. */
export const BROWSE_GOTO_TIMEOUT_MS = 9_000;
/** How long one call's steps may start before the rest are left for the next call. */
export const BROWSE_BUDGET_MS = 5_000;
/** How long to let a page settle after it opens, or after a click or a key. */
export const SETTLE_MS = 3_000;
/** Steps in one call. */
export const MAX_STEPS = 10;
export { MAX_BROWSE_TEXT, MAX_ELEMENTS, MAX_SCANNED, SNAPSHOT_SOURCE, snapshot, snapshotSource } from "./reading";
const MAX_TYPED = 500;

export type Step =
  | { do: "goto"; url: string }
  | { do: "click"; ref: number }
  | { do: "click"; text: string }
  | { do: "click"; x: number; y: number }
  | { do: "look" }
  /** Close what is drawn over the page: its close or skip, else hide it (./popups.ts). */
  | { do: "close_popup" }
  | { do: "type"; ref: number; text: string; enter: boolean; onlyOn: string[] | null }
  | { do: "fill"; ref: number; value: string; origin: string; field: FillField }
  | { do: "select"; ref: number; option: string }
  | { do: "press"; key: Key }
  | { do: "back" }
  /** At a look's point (a frame's list), else the middle of the screen. */
  | { do: "scroll"; direction: "down" | "up"; x: number | null; y: number | null }
  | { do: "read" }
  | { do: "upload"; ref: number | null; file: UploadFile; onlyOn: string[] | null }
  /** Press the element (by number or words) that saves a file, or with neither take the file the page is (./download.ts). */
  | { do: "download"; ref: number | null; text: string | null };

/** The most a file put into a page may be, as base64: the 10 MB a file is read at. */
export const MAX_UPLOAD_CHARS = Math.ceil((10 * 1024 * 1024 * 4) / 3) + 4;
const UPLOAD_NAME = /^[^\u0000-\u001f/\\]{1,200}$/;
const UPLOAD_TYPE = /^[a-z]+\/[a-z0-9.+-]{1,100}$/;

export interface Element {
  ref: number;
  kind: string;
  label: string;
  href?: string;
  filled?: boolean;
  checked?: boolean;
}

export interface Reading {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  elements: Element[];
  /** How many boxes on the page take a file, hidden ones included: an upload step fills one. */
  uploads?: number;
  /** Something like a popup covers the page (./popups.ts). */
  popup?: boolean;
  /** After a `look`: what the page shows, a JPEG, and its size in its own pixels, the space a click's x and y are in. */
  shot?: { data: string; width: number; height: number };
}

export interface StepResult {
  do: Step["do"];
  ok: boolean;
  /** Why it did not run: short, fixed words, never the page's own. */
  reason?: string;
}

/** The parts of a puppeteer page this file uses. */
/**
 * The kinds of box the vault fills: a login's two (`apps/mcp/src/agent/fillLogin.js`)
 * and a card's parts (`apps/mcp/src/agent/fillCard.js`).
 */
export const CARD_FIELDS = ["cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-cvc", "cc-name", "cc-postal-code"] as const;
export type FillField = "username" | "password" | (typeof CARD_FIELDS)[number];
const FILL_FIELDS = new Set<string>(["username", "password", ...CARD_FIELDS]);
const isCardField = (field: FillField) => field.startsWith("cc-");

export interface BrowsePage {
  goto(url: string, options: { waitUntil: "networkidle2" | "load" | "domcontentloaded"; timeout: number }): Promise<unknown>;
  evaluate<T>(source: string): Promise<T>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  select(selector: string, ...values: string[]): Promise<string[]>;
  goBack(options: { timeout: number }): Promise<unknown>;
  keyboard: { press(key: string): Promise<void> };
  /** `wheel` turns whatever is under the point; a browser without it scrolls the top page. */
  mouse: { click(x: number, y: number): Promise<void>; wheel?(x: number, y: number, deltaY: number): Promise<void> };
  /** The page's embedded frames, where the browser can reach them (./frames.ts). */
  frames?(): Promise<FrameDoc[]>;
  setFiles?(selector: string, paths: string[]): Promise<boolean>;
  screenshot(options: { type: "jpeg"; quality: number; encoding: "base64"; fullPage: false }): Promise<string | Uint8Array>;
  waitForNetworkIdle(options: { idleTime: number; timeout: number }): Promise<void>;
}

const SESSION_ID = /^[A-Za-z0-9-]{8,80}$/;
/**
 * The keys a step may press. The arrows and Space work a menu or a list the
 * page built itself, the way a person moves through one without a mouse.
 */
export const KEYS = ["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Space"] as const;
export type Key = (typeof KEYS)[number];
const KEY_SET = new Set<string>(KEYS);
/** The most words a click-by-words step may name: a button's or an option's, not a paragraph. */
const MAX_CLICK_TEXT = 200;
/** A point on a look's picture, in its pixels. */
const MAX_POINT = 10_000;
/** How a look's picture is taken: enough to read a form's words, small enough for a model's turn. */
export const LOOK_QUALITY = 60;

/**
 * `{ session?, steps }`, or null. Anything malformed refuses the whole call: a
 * step this file cannot read is not skipped, because the steps after it were
 * written assuming it ran.
 */
export function parseBrowseRequest(body: unknown): { session: string | null; steps: Step[] } | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as { session?: unknown; steps?: unknown };
  let session: string | null = null;
  if (raw.session !== undefined && raw.session !== null) {
    if (typeof raw.session !== "string" || !SESSION_ID.test(raw.session)) return null;
    session = raw.session;
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0 || raw.steps.length > MAX_STEPS) return null;
  const steps: Step[] = [];
  for (const item of raw.steps) {
    const step = parseStep(item);
    if (step === null) return null;
    steps.push(step);
  }
  return { session, steps };
}

function parseStep(item: unknown): Step | null {
  if (!item || typeof item !== "object") return null;
  const s = item as Record<string, unknown>;
  const ref = Number.isInteger(s.ref) && (s.ref as number) > 0 && (s.ref as number) <= 10_000 ? (s.ref as number) : null;
  switch (s.do) {
    case "goto": {
      const url = publicHttpsUrl(s.url);
      return url === null ? null : { do: "goto", url };
    }
    case "click":
      if (ref !== null) return { do: "click", ref };
      if (s.x !== undefined || s.y !== undefined) {
        const point = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_POINT;
        return point(s.x) && point(s.y) ? { do: "click", x: s.x as number, y: s.y as number } : null;
      }
      return typeof s.text === "string" && s.text.trim().length > 0 && s.text.length <= MAX_CLICK_TEXT ? { do: "click", text: s.text.trim() } : null;
    case "type": {
      if (ref === null || typeof s.text !== "string" || s.text.length > MAX_TYPED) return null;
      let onlyOn: string[] | null = null;
      if (s.onlyOn !== undefined && s.onlyOn !== null) {
        onlyOn = sitesOf(s.onlyOn);
        if (onlyOn === null) return null;
      }
      return { do: "type", ref, text: s.text, enter: s.enter === true, onlyOn };
    }
    case "fill": {
      if (ref === null || typeof s.value !== "string" || s.value.length === 0 || s.value.length > 2_000) return null;
      const origin = publicHttpsUrl(s.origin);
      if (typeof s.field !== "string" || !FILL_FIELDS.has(s.field)) return null;
      return origin === null ? null : { do: "fill", ref, value: s.value, origin: new URL(origin).origin, field: s.field as FillField };
    }
    case "select":
      return ref === null || typeof s.option !== "string" || s.option.length > 200 ? null : { do: "select", ref, option: s.option };
    case "press":
      return typeof s.key === "string" && KEY_SET.has(s.key) ? { do: "press", key: s.key as Key } : null;
    case "back":
      return { do: "back" };
    case "scroll": {
      if (s.direction !== "up" && s.direction !== "down") return null;
      if (s.x === undefined && s.y === undefined) return { do: "scroll", direction: s.direction, x: null, y: null };
      const point = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_POINT;
      return point(s.x) && point(s.y) ? { do: "scroll", direction: s.direction, x: s.x as number, y: s.y as number } : null;
    }
    case "read":
      return { do: "read" };
    case "look":
      return { do: "look" };
    case "close_popup":
      return { do: "close_popup" };
    case "upload": {
      const file = s.file as Record<string, unknown> | undefined;
      if (!file || typeof file !== "object") return null;
      const { name, type, data } = file;
      if (typeof name !== "string" || !UPLOAD_NAME.test(name)) return null;
      if (typeof type !== "string" || !UPLOAD_TYPE.test(type)) return null;
      if (typeof data !== "string" || data.length === 0 || data.length > MAX_UPLOAD_CHARS || !/^[A-Za-z0-9+/]+=*$/.test(data)) return null;
      const onlyOn = s.onlyOn === undefined || s.onlyOn === null ? null : sitesOf(s.onlyOn);
      if (s.onlyOn !== undefined && s.onlyOn !== null && onlyOn === null) return null;
      return { do: "upload", ref, file: { name, type, data }, onlyOn };
    }
    case "download": {
      if (ref !== null) return { do: "download", ref, text: null };
      if (s.text === undefined || s.text === null) return { do: "download", ref: null, text: null };
      return typeof s.text === "string" && s.text.trim().length > 0 && s.text.length <= MAX_CLICK_TEXT ? { do: "download", ref: null, text: s.text.trim() } : null;
    }
    default:
      return null;
  }
}

/**
 * Pages no agent's browser may be on: Context's own vault screens, where a
 * person adds or shares a saved login and presses the confirm themselves. A
 * browser the agent drives never stays there, however it arrived.
 */
export function offLimits(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  const host = siteOf(url.hostname);
  return (host === "context.lc" || host.endsWith(".context.lc")) && /^\/vault(\/|$)/i.test(url.pathname);
}

/** A host without a leading `www.`, lower case. */
export function siteOf(host: string): string {
  return host.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
}

/** Is `host` one of `sites`, or under one of them? */
/** The sites a step may act on, as the gateway named them, or null when they are malformed. */
function sitesOf(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every((h) => typeof h === "string" && h.includes("."))) return null;
  return (value as string[]).map(siteOf);
}

export function onSite(host: string, sites: string[]): boolean {
  const here = siteOf(host);
  return sites.some((site) => here === site || here.endsWith(`.${site}`));
}


const BY_WORDS = `[data-tex-words]`;

/**
 * Mark the element that shows `words`, for a click: the smallest visible one
 * whose own text is exactly those words (any case and spacing), else the
 * smallest that starts with them. A picker's option or a box with only a
 * click handler has no number in a reading, and the words on it are what a
 * person would point at.
 */
export function wordsSource(words: string): string {
  return `(() => {
  for (const el of document.querySelectorAll("${BY_WORDS}")) el.removeAttribute("data-tex-words");
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
  const want = norm(${JSON.stringify(words)});
  if (!want) return false;
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  let exact = null, starts = null;
  const all = document.body ? document.body.querySelectorAll("*") : [];
  for (let i = 0; i < all.length && i < ${MAX_SCANNED}; i++) {
    const el = all[i];
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "HTML" || tag === "BODY") continue;
    const text = norm(el.innerText || el.getAttribute("aria-label") || el.value);
    if (!text || text.length > ${MAX_CLICK_TEXT * 2}) continue;
    const size = el.querySelectorAll("*").length;
    if (text === want && (!exact || size <= exact.size) && visible(el)) exact = { el, size };
    else if (!exact && text.startsWith(want) && (!starts || text.length < starts.length) && visible(el)) starts = { el, length: text.length };
  }
  const found = exact ? exact.el : starts ? starts.el : null;
  if (!found) return false;
  found.setAttribute("data-tex-words", "1");
  return true;
})()`;
}

/** Press with the stand-in picker in place, and answer what the page asked of it. */
async function pressWithPicker(page: BrowsePage, press: () => Promise<void>, file: UploadFile | { mark: string } | null, doc: Doc = page): Promise<string> {
  const waitMs = file === null ? 0 : 2_000;
  await doc.evaluate(pickerHookSource(file));
  let pressed = false;
  let got: unknown = "none";
  try {
    await press();
    pressed = true;
    await settle(page);
  } finally {
    // Read even when the press threw, so the real picker is put back; a page that left takes the stand-in with it.
    got = await doc.evaluate<unknown>(pickerResult(waitMs)).catch(() => "none");
  }
  return pressed && typeof got === "string" ? got : "none";
}

/** The words a click gives back when what it pressed asks for a file. */
const ASKS_FOR_FILE = "that asks for a file: an upload step naming the same element attaches one of the person's";

async function settle(page: BrowsePage): Promise<void> {
  await page.waitForNetworkIdle({ idleTime: 400, timeout: SETTLE_MS }).catch(() => undefined);
}

/** The page or frame holding element `ref`, or null when none does. */
async function docOf(page: BrowsePage, ref: number): Promise<Doc | null> {
  // The page's own numbers are below a frame's first; only a frame's number sends the search into the frames.
  if (ref < FRAME_REF_BASE) return (await page.evaluate<boolean>(`!!document.querySelector('${selector(ref)}')`)) ? page : null;
  return await docWith(page, selector(ref));
}

/**
 * Is the element a box for this part of a login? A password only goes where
 * the page shows dots, so a search box that prints what is typed into it,
 * where a reading would show it, never receives one.
 */
async function fieldIs(page: Doc, ref: number, field: FillField): Promise<"input" | "select" | null> {
  // A card's expiry month or year may be a menu; every other part is a box a person types into.
  const menu = field === "cc-exp-month" || field === "cc-exp-year";
  const types = field === "password" ? ["password"] : field === "username" ? ["text", "email", "tel"] : ["text", "tel", "number", "password"];
  return await page.evaluate<"input" | "select" | null>(`(() => {
    const el = document.querySelector('${selector(ref)}');
    if (!el) return null;
    if (el.tagName === "SELECT") return ${menu ? `"select"` : "null"};
    if (el.tagName !== "INPUT") return null;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return ${JSON.stringify(types)}.includes(type) ? "input" : null;
  })()`);
}

/**
 * Pick a card's expiry month or year in a menu: the option whose value or
 * words are that number ("08", "8", "08 - August", "2029", "29").
 */
function pickExpirySource(ref: number, value: string): string {
  return `(() => {
    const el = document.querySelector('${selector(ref)}');
    const want = ${JSON.stringify(value)};
    const n = String(Number(want));
    const short = want.length === 4 ? want.slice(2) : null;
    const lead = (s) => (String(s).trim().match(/^\d+/) || [""])[0];
    const hit = (s) => { const d = lead(s); return d !== "" && (d === want || String(Number(d)) === n || (short !== null && d === short)); };
    const option = el && [...el.options].find((o) => hit(o.value) || hit(o.innerText));
    if (!option) return false;
    el.value = option.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`;
}

/**
 * A look is a picture the model sees, so a card's boxes are blanked in it once
 * filled: the page shows dots where a person would see the number
 * (`fillCard.js`: the model never sees a digit of the card).
 */
const HIDE_CARDS_SOURCE = `(() => {
  if (document.getElementById("context-hide-cards")) return;
  const style = document.createElement("style");
  style.id = "context-hide-cards";
  style.textContent = "[data-context-card]{color:transparent!important;text-shadow:none!important;-webkit-text-security:disc!important;caret-color:transparent!important}";
  document.documentElement.appendChild(style);
})()`;

/** Empty a field the way a person selecting all and deleting would. */
async function clear(page: Doc, ref: number): Promise<void> {
  await page.evaluate(`(() => {
    const el = document.querySelector('${selector(ref)}');
    if (!el) return;
    if (el.isContentEditable) { el.innerText = ""; return; }
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value");
    if (set && set.set) set.set.call(el, ""); else el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
}

async function where(page: Pick<Doc, "evaluate">): Promise<{ href: string; host: string; origin: string }> {
  return await page.evaluate(`({ href: location.href, host: location.hostname, origin: location.origin })`);
}

/**
 * Carry out `steps` in order on `page`, then read it. Stops at the first step
 * that fails, at the first one that lands on a new address (the numbers the
 * later steps name belonged to the page before), and when the budget runs out;
 * the reading says where it got to either way.
 */
export async function runSteps(
  page: BrowsePage,
  steps: Step[],
  { budgetMs = BROWSE_BUDGET_MS, now = Date.now, downloads = null, uploads = null }: { budgetMs?: number; now?: () => number; downloads?: Downloads | null; uploads?: Uploads | null } = {},
): Promise<{ ran: StepResult[]; page: Reading; file?: DownloadedFile }> {
  const started = now();
  const ran: StepResult[] = [];
  let file: DownloadedFile | undefined;
  for (const step of steps) {
    if (now() - started > budgetMs) {
      ran.push({ do: step.do, ok: false, reason: "out of time; run it again" });
      break;
    }
    const before = (await where(page).catch(() => null))?.href ?? null;
    const begun = downloads?.began?.() ?? 0;
    const pressedAt = Date.now();
    const result =
      step.do === "goto" && offLimits(step.url)
        ? ({ do: "goto", ok: false, reason: "that page is off limits" } as StepResult)
        : await runStep(page, step, downloads, uploads).catch(() => ({ do: step.do, ok: false, reason: "that did not work on this page" }) as StepResult);
    // However it got there (a click, a redirect), it does not stay.
    const landed = (await where(page).catch(() => null))?.href ?? null;
    if (landed !== null && offLimits(landed)) {
      await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: BROWSE_GOTO_TIMEOUT_MS }).catch(() => undefined);
      ran.push({ do: step.do, ok: false, reason: "that page is off limits" });
      break;
    }
    // One file a call: the steps after a download are left for the next.
    if (step.do === "download") {
      const { file: got, ...said } = result as StepResult & { file?: DownloadedFile };
      ran.push(said);
      file = got;
      break;
    }
    // A click or a key that started a download (an invoice's menu, wherever it is) hands the file back too.
    if (result.ok && (step.do === "click" || step.do === "press") && downloads?.began !== undefined && downloads.began() > begun) {
      const got = await downloads.take(pressedAt, DOWNLOAD_WAIT_MS).catch(() => null);
      if (got !== null && "refused" in got) {
        ran.push({ ...result, reason: `that started a download, but ${got.refused}` });
        break;
      }
      if (got !== null) {
        ran.push({ ...result, reason: "that saved a file, handed back with this reading" });
        file = got;
        break;
      }
    }
    ran.push(result);
    if (!result.ok) break;
    if (step.do === "goto" || step.do === "back") continue;
    const after = (await where(page).catch(() => null))?.href ?? null;
    if (before !== null && after !== null && after !== before && steps.indexOf(step) < steps.length - 1) {
      ran.push({ do: "read", ok: true, reason: "the page changed, so the steps after this one were not run" });
      break;
    }
  }
  const reading = await snapshot(page);
  if (ran.some((r) => r.do === "look" && r.ok)) {
    const shot = await look(page).catch(() => null);
    if (shot !== null) reading.shot = shot;
  }
  return { ran, page: reading, ...(file ? { file } : {}) };
}

/** How many of the page's own pixels make one CSS pixel: a look's picture is in the former, the mouse in the latter. */
async function pixelRatio(page: BrowsePage): Promise<{ ratio: number; width: number; height: number }> {
  const view = await page.evaluate<{ ratio?: unknown; width?: unknown; height?: unknown }>(
    "({ ratio: window.devicePixelRatio, width: window.innerWidth, height: window.innerHeight })",
  );
  const ratio = typeof view?.ratio === "number" && view.ratio > 0 && view.ratio <= 4 ? view.ratio : 1;
  const size = (v: unknown) => (typeof v === "number" && v > 0 ? Math.round(v * ratio) : 0);
  return { ratio, width: size(view?.width), height: size(view?.height) };
}

/** The page as a person sees it now, the part on screen. */
async function look(page: BrowsePage): Promise<{ data: string; width: number; height: number }> {
  await page.evaluate(HIDE_CARDS_SOURCE);
  // A card's boxes are often another site's frame (a payment form): blanked there too.
  for (const frame of await framesOf(page)) await frame.evaluate(HIDE_CARDS_SOURCE);
  const { width, height } = await pixelRatio(page);
  const raw = await page.screenshot({ type: "jpeg", quality: LOOK_QUALITY, encoding: "base64", fullPage: false });
  let data = typeof raw === "string" ? raw : "";
  if (typeof raw !== "string") {
    let binary = "";
    for (let i = 0; i < raw.length; i += 0x8000) binary += String.fromCharCode(...raw.subarray(i, i + 0x8000));
    data = btoa(binary);
  }
  return { data, width, height };
}

async function runStep(page: BrowsePage, step: Step, downloads: Downloads | null, uploads: Uploads | null): Promise<StepResult> {
  const ok = { do: step.do, ok: true } as StepResult;
  const missing = { do: step.do, ok: false, reason: "no such element; read the page again" } as StepResult;
  switch (step.do) {
    case "goto":
      await page.goto(step.url, { waitUntil: "domcontentloaded", timeout: BROWSE_GOTO_TIMEOUT_MS });
      await settle(page);
      return ok;
    case "read":
    case "look":
      return ok;
    case "close_popup":
      return await closePopup(page, () => settle(page));
    case "back":
      await page.goBack({ timeout: BROWSE_GOTO_TIMEOUT_MS });
      await settle(page);
      return ok;
    case "scroll": {
      const sign = step.direction === "down" ? 1 : -1;
      if (typeof page.mouse.wheel === "function") {
        // A wheel at a point (the middle of the screen, or a look's point) scrolls what is under it, a frame's list included.
        const view = await pixelRatio(page);
        const x = step.x !== null ? step.x / view.ratio : view.width / view.ratio / 2;
        const y = step.y !== null ? step.y / view.ratio : view.height / view.ratio / 2;
        await page.mouse.wheel(x, y, sign * Math.round((view.height / view.ratio) * 0.8));
        await settle(page);
        return ok;
      }
      await page.evaluate(`window.scrollBy(0, ${sign} * Math.round(window.innerHeight * 0.8))`);
      return ok;
    }
    case "press":
      await page.keyboard.press(step.key);
      await settle(page);
      return ok;
    case "click": {
      let press: () => Promise<void>;
      let doc: Doc = page;
      let covered = false;
      if ("x" in step) {
        // A point on the last look's picture: what a person would tap, whatever the page says it is.
        const { ratio } = await pixelRatio(page);
        press = () => page.mouse.click(step.x / ratio, step.y / ratio);
      } else {
        let target: string;
        if ("text" in step) {
          const marked = await docMarking(page, wordsSource(step.text));
          if (marked === null) return { do: "click", ok: false, reason: "nothing on the page shows those words; read the page again" };
          doc = marked;
          target = BY_WORDS;
        } else {
          const found = await docOf(page, step.ref);
          if (found === null) return missing;
          doc = found;
          target = selector(step.ref);
        }
        const on = doc;
        // A popup's cover over it would take a press at its point, so it is pressed from inside the page instead (./popups.ts).
        covered = (await on.evaluate<boolean>(coveredSource(target)).catch(() => false)) === true;
        press = covered ? async () => void (await on.evaluate(domClickSource(target))) : () => on.click(target);
      }
      const got = await pressWithPicker(page, press, null, doc);
      if (got === "asked") return { do: "click", ok: true, reason: ASKS_FOR_FILE };
      return covered ? { do: "click", ok: true, reason: COVERED_PRESS } : ok;
    }
    case "select": {
      const doc = await docOf(page, step.ref);
      if (doc === null) return missing;
      // By the option's words, as the person reads them, else by its value.
      await doc.evaluate(`(() => {
        const el = document.querySelector('${selector(step.ref)}');
        const want = ${JSON.stringify(step.option.toLowerCase())};
        const option = el && [...el.options].find((o) => o.innerText.trim().toLowerCase() === want || o.value.toLowerCase() === want);
        if (option) { el.value = option.value; el.dispatchEvent(new Event("change", { bubbles: true })); }
      })()`);
      await settle(page);
      return ok;
    }
    case "type": {
      const doc = await docOf(page, step.ref);
      if (doc === null) return missing;
      // The second lock: the host is checked now, not when the gateway agreed, and it is the host of the frame the box is in.
      if (step.onlyOn !== null && !onSite((await where(doc)).host, step.onlyOn)) {
        return { do: "type", ok: false, reason: "this page is not on a site the person named" };
      }
      await clear(doc, step.ref);
      await doc.type(selector(step.ref), step.text);
      // Words put in directly are checked against the named sites again: the page may have moved while the keys went in.
      const direct = (step.onlyOn === null || onSite((await where(doc)).host, step.onlyOn)) && (await typedOrSet(doc, selector(step.ref), step.text));
      if (step.enter) {
        await page.keyboard.press("Enter");
        await settle(page);
      }
      return direct ? { do: "type", ok: true, reason: SET_DIRECTLY } : ok;
    }
    case "upload": {
      const doc = step.ref === null ? page : await docOf(page, step.ref);
      if (doc === null) return missing;
      // The same second lock as typing: the person's file goes only where they said, checked now.
      const named = async () => step.onlyOn === null || onSite((await where(doc)).host, step.onlyOn);
      const elsewhere = { do: "upload", ok: false, reason: "this page is not on a site the person named" } as StepResult;
      if (!(await named())) return elsewhere;
      // A browser that takes a real file (./upload.ts) sets it on a box marked for this step alone; else the page is given it.
      const mark = uploads !== null && doc.setFiles ? crypto.randomUUID().replace(/-/g, "") : null;
      const into = mark !== null ? { mark } : step.file;
      const put = await doc.evaluate<string>(uploadSource(step.ref, into));
      if (put === "none") return { do: "upload", ok: false, reason: "this page has no box that takes a file; name the button that asks for one" };
      if (put === "button" && step.ref !== null) {
        // No box yet: press the element, and the box it opens gets the file instead of the device's picker.
        const ref = step.ref;
        const got = await pressWithPicker(page, () => doc.click(selector(ref)), into, doc);
        if (got !== "attached") {
          if (!(await doc.evaluate<boolean>(dropSource(ref, step.file)))) return missing;
          await settle(page);
          return { do: "upload", ok: true, reason: "pressing it opened no file box, so the file was dropped onto it; look to check the page took it" };
        }
      }
      if (mark !== null) {
        const path = await uploads!.stage(step.file).catch(() => null);
        // Again: staging the file takes a moment, and the page may have moved on.
        if (!(await named())) return elsewhere;
        const box = markedSelector(mark);
        // A size that does not match means the browser did not find its copy; the page's file then replaces it.
        const set = path !== null && (await doc.setFiles!(box, [path]).catch(() => false)) &&
          (await doc.evaluate<number>(markedSizeSource(mark)).catch(() => -1)) === sizeOf(step.file);
        uploads!.said(set ? "browser" : "page");
        if (!set && !(await doc.evaluate<boolean>(fillMarkedSource(mark, step.file)))) return missing;
      }
      await settle(page);
      return ok;
    }
    case "download": {
      let target: string | null = null;
      let doc: Doc = page;
      if (step.ref !== null) {
        const found = await docOf(page, step.ref);
        if (found === null) return missing;
        doc = found;
        target = selector(step.ref);
      } else if (step.text !== null) {
        const marked = await docMarking(page, wordsSource(step.text));
        if (marked === null) return { do: "download", ok: false, reason: "nothing on the page shows those words; read the page again" };
        doc = marked;
        target = BY_WORDS;
      }
      const pressed = target;
      const on = doc;
      return await runDownload(on, target, pressed === null ? null : async () => {
        await on.click(pressed);
        await settle(page);
      }, downloads);
    }
    case "fill": {
      const doc = await docOf(page, step.ref);
      if (doc === null) return missing;
      // The origin of the frame the box is in: a login for one site never goes into another site's frame.
      // A card's part may also go into the checkout's own payment frame (./paymentFrames.ts).
      if ((await where(doc)).origin !== step.origin && !(isCardField(step.field) && (await isCheckoutPaymentFrame(page, doc, step.origin)))) {
        return { do: "fill", ok: false, reason: "origin mismatch" };
      }
      const box = await fieldIs(doc, step.ref, step.field);
      if (box === null) return { do: "fill", ok: false, reason: `that is not a ${step.field} box` };
      if (isCardField(step.field)) await doc.evaluate(`document.querySelector('${selector(step.ref)}').setAttribute("data-context-card", "")`);
      if (box === "select") {
        if (!(await doc.evaluate<boolean>(pickExpirySource(step.ref, step.value)))) return { do: "fill", ok: false, reason: "that menu has no option for the card's expiry" };
        return ok;
      }
      const at = (await where(doc)).origin;
      await clear(doc, step.ref);
      await doc.type(selector(step.ref), step.value);
      // A secret is put in directly only where it was just checked to belong: a page that moved meanwhile gets nothing more.
      if ((await where(doc).catch(() => null))?.origin === at) await typedOrSet(doc, selector(step.ref), step.value);
      return ok;
    }
  }
}
