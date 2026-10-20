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
 *   in a reading.
 *
 * A reading numbers the things on the page a person could press or type into
 * (`data-tex-ref`), and never includes what is typed in a field: only whether
 * it has something in it. That is what keeps a filled password out of the
 * model's context.
 *
 * Kept apart from `./index.ts` for the reason `./shoot.ts` gives.
 */

import { publicHttpsUrl } from "./shoot";

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
/** The most text and elements one reading hands back. */
export const MAX_BROWSE_TEXT = 12_000;
export const MAX_ELEMENTS = 80;
/** How many of the page's elements a reading looks at for something to number; past it a page is read as far as here. */
export const MAX_SCANNED = 5_000;
const MAX_TYPED = 500;

export type Step =
  | { do: "goto"; url: string }
  | { do: "click"; ref: number }
  | { do: "click"; text: string }
  | { do: "click"; x: number; y: number }
  | { do: "look" }
  | { do: "type"; ref: number; text: string; enter: boolean; onlyOn: string[] | null }
  | { do: "fill"; ref: number; value: string; origin: string; field: "username" | "password" }
  | { do: "select"; ref: number; option: string }
  | { do: "press"; key: Key }
  | { do: "back" }
  | { do: "scroll"; direction: "down" | "up" }
  | { do: "read" }
  | { do: "upload"; ref: number | null; file: UploadFile; onlyOn: string[] | null };

/**
 * A file the gateway read from the person's own notes or mail (`apps/mcp/src/agent/uploads.js`),
 * put into the page's upload box the way a person picking it would.
 */
export interface UploadFile {
  name: string;
  type: string;
  /** base64 */
  data: string;
}

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
export interface BrowsePage {
  goto(url: string, options: { waitUntil: "networkidle2" | "load" | "domcontentloaded"; timeout: number }): Promise<unknown>;
  evaluate<T>(source: string): Promise<T>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  select(selector: string, ...values: string[]): Promise<string[]>;
  goBack(options: { timeout: number }): Promise<unknown>;
  keyboard: { press(key: string): Promise<void> };
  mouse: { click(x: number, y: number): Promise<void> };
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
      if (s.field !== "username" && s.field !== "password") return null;
      return origin === null ? null : { do: "fill", ref, value: s.value, origin: new URL(origin).origin, field: s.field };
    }
    case "select":
      return ref === null || typeof s.option !== "string" || s.option.length > 200 ? null : { do: "select", ref, option: s.option };
    case "press":
      return typeof s.key === "string" && KEY_SET.has(s.key) ? { do: "press", key: s.key as Key } : null;
    case "back":
      return { do: "back" };
    case "scroll":
      return s.direction === "up" || s.direction === "down" ? { do: "scroll", direction: s.direction } : null;
    case "read":
      return { do: "read" };
    case "look":
      return { do: "look" };
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

/**
 * Number what can be pressed or typed into, in page order, and read the page.
 * Run as a string, for the reason `MEASURE_SOURCE` gives. A field's value is
 * never read out: only whether it has one.
 */
export const SNAPSHOT_SOURCE = `(() => {
  for (const el of document.querySelectorAll("[data-tex-ref]")) el.removeAttribute("data-tex-ref");
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim().slice(0, 100);
  const labelOf = (el) => {
    const byId = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
    return clean(el.getAttribute("aria-label")) || clean(byId && byId.innerText) || clean(el.closest("label") && el.closest("label").innerText) ||
      clean(el.innerText) || clean(el.getAttribute("placeholder")) || clean(el.getAttribute("title")) || clean(el.getAttribute("alt")) ||
      clean(el.getAttribute("name")) || clean(el.value && el.type === "submit" ? el.value : "");
  };
  const elements = [];
  const query = "a[href], button, input:not([type=hidden]), textarea, select, summary, [onclick], [tabindex]:not([tabindex='-1']), " +
    "[role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=tab], [role=menuitem], [role=menuitemradio], " +
    "[role=menuitemcheckbox], [role=option], [role=combobox], [role=treeitem], [contenteditable=true]";
  const pointer = (el) => !!el && getComputedStyle(el).cursor === "pointer";
  /*
    What a page made clickable without saying so: a box with only a click
    handler, styled with the hand cursor (a custom picker's options). Numbered
    once, at the outermost box the hand starts on, and never when it wraps
    something already numbered by what it is.
  */
  const clickable = (el) => pointer(el) && !pointer(el.parentElement) && !el.querySelector(query);
  const all = document.body ? document.body.querySelectorAll("*") : [];
  for (let i = 0; i < all.length && i < ${MAX_SCANNED}; i++) {
    const el = all[i];
    if (elements.length >= ${MAX_ELEMENTS}) break;
    const named = el.matches(query);
    if (!named && !clickable(el)) continue;
    if (!visible(el) || el.disabled) continue;
    const ref = elements.length + 1;
    el.setAttribute("data-tex-ref", String(ref));
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const kind = tag === "input" ? "input " + (type || "text") : tag === "a" ? "link" : el.getAttribute("role") || (named ? tag : "clickable");
    const item = { ref, kind, label: labelOf(el) };
    if (tag === "a") item.href = el.href;
    if (tag === "input" && (type === "checkbox" || type === "radio")) item.checked = el.checked;
    else if (tag === "input" || tag === "textarea") item.filled = (el.value || "").length > 0;
    else if (el.isContentEditable) item.filled = (el.innerText || "").trim().length > 0;
    if (tag === "select") item.label = item.label + " (now: " + clean(el.selectedOptions[0] && el.selectedOptions[0].innerText) + ")";
    elements.push(item);
  }
  const text = (document.body ? document.body.innerText : "") || "";
  const uploads = document.querySelectorAll("input[type=file]").length;
  return { url: location.href, title: document.title || "", text, elements, uploads };
})()`;

const selector = (ref: number) => `[data-tex-ref="${ref}"]`;
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

/**
 * Put a file into the page as a person choosing it would: into the file box
 * the step names, the one inside or beside it, or the page's only one, with
 * the events a page listens for; or, where there is no box, dropped onto the
 * element named, as dragging it there would. Answers "input", "drop" or "none".
 */
export function uploadSource(ref: number | null, file: UploadFile): string {
  return `(() => {
  const named = ${ref === null ? "null" : `document.querySelector('${selector(ref)}')`};
  const binary = atob(${JSON.stringify(file.data)});
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], ${JSON.stringify(file.name)}, { type: ${JSON.stringify(file.type)} }));
  const isBox = (el) => !!el && el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "file";
  const boxes = [...document.querySelectorAll("input[type=file]")];
  let box = isBox(named) ? named : null;
  if (!box && named) box = named.querySelector("input[type=file]") || (named.closest("form, label, [role=dialog]") || document.body).querySelector("input[type=file]");
  if (!box && !named && boxes.length > 0) box = boxes[0];
  if (box) {
    box.files = transfer.files;
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.dispatchEvent(new Event("change", { bubbles: true }));
    return "input";
  }
  if (!named) return "none";
  for (const kind of ["dragenter", "dragover", "drop"]) {
    named.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }
  return "drop";
})()`;
}

async function settle(page: BrowsePage): Promise<void> {
  await page.waitForNetworkIdle({ idleTime: 400, timeout: SETTLE_MS }).catch(() => undefined);
}

async function exists(page: BrowsePage, ref: number): Promise<boolean> {
  return await page.evaluate<boolean>(`!!document.querySelector('${selector(ref)}')`);
}

/**
 * Is the element a box for this part of a login? A password only goes where
 * the page shows dots, so a search box that prints what is typed into it,
 * where a reading would show it, never receives one.
 */
async function fieldIs(page: BrowsePage, ref: number, field: "username" | "password"): Promise<boolean> {
  return await page.evaluate<boolean>(`(() => {
    const el = document.querySelector('${selector(ref)}');
    if (!el || el.tagName !== "INPUT") return false;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return ${field === "password" ? `type === "password"` : `["text", "email", "tel"].includes(type)`};
  })()`);
}

/** Empty a field the way a person selecting all and deleting would. */
async function clear(page: BrowsePage, ref: number): Promise<void> {
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

/** Read the page as it is now. */
export async function snapshot(page: BrowsePage): Promise<Reading> {
  const raw = await page.evaluate<{ url?: unknown; title?: unknown; text?: unknown; elements?: unknown; uploads?: unknown }>(SNAPSHOT_SOURCE);
  const text = typeof raw?.text === "string" ? raw.text.replace(/\n{3,}/g, "\n\n").trim() : "";
  const elements: Element[] = [];
  for (const item of Array.isArray(raw?.elements) ? raw.elements : []) {
    const e = item as Record<string, unknown>;
    if (!Number.isInteger(e.ref) || typeof e.kind !== "string") continue;
    const element: Element = { ref: e.ref as number, kind: e.kind.slice(0, 40), label: typeof e.label === "string" ? e.label.slice(0, 160) : "" };
    if (typeof e.href === "string") {
      // A link the gateway may later open has to be one it could open at all.
      const href = publicHttpsUrl(e.href);
      if (href !== null) element.href = href;
    }
    if (typeof e.filled === "boolean") element.filled = e.filled;
    if (typeof e.checked === "boolean") element.checked = e.checked;
    elements.push(element);
  }
  return {
    url: typeof raw?.url === "string" ? raw.url.slice(0, 2_000) : "",
    title: typeof raw?.title === "string" ? raw.title.slice(0, 300) : "",
    text: text.slice(0, MAX_BROWSE_TEXT),
    truncated: text.length > MAX_BROWSE_TEXT,
    elements,
    ...(Number.isInteger(raw?.uploads) && (raw!.uploads as number) > 0 ? { uploads: Math.min(raw!.uploads as number, 100) } : {}),
  };
}

async function where(page: BrowsePage): Promise<{ href: string; host: string; origin: string }> {
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
  { budgetMs = BROWSE_BUDGET_MS, now = Date.now }: { budgetMs?: number; now?: () => number } = {},
): Promise<{ ran: StepResult[]; page: Reading }> {
  const started = now();
  const ran: StepResult[] = [];
  for (const step of steps) {
    if (now() - started > budgetMs) {
      ran.push({ do: step.do, ok: false, reason: "out of time; run it again" });
      break;
    }
    const before = (await where(page).catch(() => null))?.href ?? null;
    const result =
      step.do === "goto" && offLimits(step.url)
        ? ({ do: "goto", ok: false, reason: "that page is off limits" } as StepResult)
        : await runStep(page, step).catch(() => ({ do: step.do, ok: false, reason: "that did not work on this page" }) as StepResult);
    // However it got there (a click, a redirect), it does not stay.
    const landed = (await where(page).catch(() => null))?.href ?? null;
    if (landed !== null && offLimits(landed)) {
      await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: BROWSE_GOTO_TIMEOUT_MS }).catch(() => undefined);
      ran.push({ do: step.do, ok: false, reason: "that page is off limits" });
      break;
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
  return { ran, page: reading };
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

async function runStep(page: BrowsePage, step: Step): Promise<StepResult> {
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
    case "back":
      await page.goBack({ timeout: BROWSE_GOTO_TIMEOUT_MS });
      await settle(page);
      return ok;
    case "scroll":
      await page.evaluate(`window.scrollBy(0, ${step.direction === "down" ? 1 : -1} * Math.round(window.innerHeight * 0.8))`);
      return ok;
    case "press":
      await page.keyboard.press(step.key);
      await settle(page);
      return ok;
    case "click":
      if ("x" in step) {
        // A point on the last look's picture: what a person would tap, whatever the page says it is.
        const { ratio } = await pixelRatio(page);
        await page.mouse.click(step.x / ratio, step.y / ratio);
        await settle(page);
        return ok;
      }
      if ("text" in step) {
        if (!(await page.evaluate<boolean>(wordsSource(step.text)))) {
          return { do: "click", ok: false, reason: "nothing on the page shows those words; read the page again" };
        }
        await page.click(BY_WORDS);
        await settle(page);
        return ok;
      }
      if (!(await exists(page, step.ref))) return missing;
      await page.click(selector(step.ref));
      await settle(page);
      return ok;
    case "select":
      if (!(await exists(page, step.ref))) return missing;
      // By the option's words, as the person reads them, else by its value.
      await page.evaluate(`(() => {
        const el = document.querySelector('${selector(step.ref)}');
        const want = ${JSON.stringify(step.option.toLowerCase())};
        const option = el && [...el.options].find((o) => o.innerText.trim().toLowerCase() === want || o.value.toLowerCase() === want);
        if (option) { el.value = option.value; el.dispatchEvent(new Event("change", { bubbles: true })); }
      })()`);
      await settle(page);
      return ok;
    case "type": {
      if (!(await exists(page, step.ref))) return missing;
      // The second lock: the host is checked now, not when the gateway agreed.
      if (step.onlyOn !== null && !onSite((await where(page)).host, step.onlyOn)) {
        return { do: "type", ok: false, reason: "this page is not on a site the person named" };
      }
      await clear(page, step.ref);
      await page.type(selector(step.ref), step.text);
      if (step.enter) {
        await page.keyboard.press("Enter");
        await settle(page);
      }
      return ok;
    }
    case "upload": {
      if (step.ref !== null && !(await exists(page, step.ref))) return missing;
      // The same second lock as typing: the person's file goes only where they said, checked now.
      if (step.onlyOn !== null && !onSite((await where(page)).host, step.onlyOn)) {
        return { do: "upload", ok: false, reason: "this page is not on a site the person named" };
      }
      const put = await page.evaluate<string>(uploadSource(step.ref, step.file));
      if (put === "none") return { do: "upload", ok: false, reason: "this page has no box that takes a file" };
      await settle(page);
      return ok;
    }
    case "fill": {
      if (!(await exists(page, step.ref))) return missing;
      if ((await where(page)).origin !== step.origin) return { do: "fill", ok: false, reason: "origin mismatch" };
      if (!(await fieldIs(page, step.ref, step.field))) return { do: "fill", ok: false, reason: `that is not a ${step.field} box` };
      await clear(page, step.ref);
      await page.type(selector(step.ref), step.value);
      return ok;
    }
  }
}
