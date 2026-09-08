/**
 * Window titles, and the URL of the frontmost tab in a browser.
 *
 * This is the most invasive thing the app does, and it is worth being blunt
 * about why it exists: half of all meetings are a browser tab, and a tab is
 * indistinguishable from any other tab without its URL. `detect()` needs
 * `meet.google.com/abc-defg-hij` to say "this is a meeting" rather than "a
 * browser is open".
 *
 * Three things follow, and they are implemented rather than promised:
 *
 *  1. **Only browsers are asked for URLs**, from a fixed list. There is no
 *     generic "read every app's document" pass.
 *  2. **A URL is reduced to origin and path before it leaves this file.**
 *     Query strings and fragments carry session tokens, invite codes, document
 *     ids and search terms; a conference URL needs neither. This is the one
 *     place in the app where a URL is normalised, so the redaction cannot be
 *     forgotten downstream.
 *  3. **Blocked apps never get here at all** — `redactBlocked` runs on the
 *     result before `detect()` sees it, in `core/detection/loop.ts`.
 *
 * The AppleScript needs macOS Accessibility (window titles) and Automation
 * (tab URLs). Both are asked for by the system the first time this runs, and
 * both can be refused without breaking the app: the collector throws, the loop
 * marks it degraded, and `detect()` works from processes and the calendar.
 *
 * **That last sentence used to be an intention rather than a fact, the same
 * gap `calendar.ts` had.** `proc.windows.name()` sits behind its own
 * `try { ... } catch (e) {}`, per process, exactly like the calendar's
 * per-calendar swallow — so if Accessibility is refused, every process's
 * title read fails the same way, `titles` stays `[]` for all of them, and the
 * poll ends with nothing to show for it, indistinguishable from a moment with
 * no windows open anywhere. The script now counts how many of those reads
 * were attempted and how many refused, and `parseWindows` throws when the
 * poll produced nothing *and* every title read that was attempted refused —
 * the shape a systemwide Accessibility denial produces, since a process that
 * legitimately has no windows returns `[]` without throwing at all. The
 * per-browser tab-URL swallow (`catch (e) {}` around `browser.windows()`) is
 * left alone on purpose: it is gated per browser rather than systemwide, so
 * one browser's Automation refusal does not mean the same as Accessibility
 * being off, and the window titles for that same browser were already
 * collected by the read above — throwing the whole collector away over a
 * missing tab URL would discard evidence the poll already has for the sake of
 * evidence it does not.
 *
 * **That swallow used to be silent, and now it counts.** Discarding the tab
 * URL rather than the whole poll is the right call about the *evidence* — a
 * blocked-but-not-refused browser's window titles are still worth having —
 * but it made a refused browser indistinguishable from one with no windows
 * open at all: both produced nothing, in the same list, for a different
 * reason. The script now counts how many browsers it found among the running
 * processes and how many of those refused to hand back a URL, and
 * `collectWindows` reports the count alongside the windows it did collect —
 * never by throwing, since nothing here was lost that the throw-on-total-
 * refusal check above already exists to catch. `degradedNotice` turns a
 * nonzero count into one honest sentence, without naming which browser.
 */

import type { WindowSignal } from "../../core/contract.ts";
import type { CollectedWindows } from "../../core/detection/collectors.ts";
import { osascript } from "../exec.ts";

/** Browsers we ask for a tab URL, by the name `System Events` reports. */
export const BROWSERS: readonly string[] = Object.freeze([
  "Safari",
  "Google Chrome",
  "Google Chrome Canary",
  "Microsoft Edge",
  "Brave Browser",
  "Arc",
  "Vivaldi",
  "Orion",
]);

/**
 * Origin plus path, nothing else. `https://meet.example.test/abc-defg?token=…`
 * becomes `https://meet.example.test/abc-defg`.
 */
export function redactUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

/**
 * The script. JXA rather than AppleScript so the output is JSON and the parse
 * is not a guess — a window title can contain any character, tabs and newlines
 * included, and a TSV parser meets one of those on the day it matters.
 */
export const WINDOW_SCRIPT = `
  const se = Application("System Events");
  const browsers = ${JSON.stringify(BROWSERS)};
  const out = [];
  const procs = se.processes.whose({ backgroundOnly: false })();
  let titleAttempts = 0;
  let titleRefusals = 0;
  let tabUrlAttempts = 0;
  let tabUrlRefusals = 0;
  for (const proc of procs) {
    let app;
    try { app = proc.name(); } catch (e) { continue; }
    let frontmost = false;
    try { frontmost = proc.frontmost(); } catch (e) {}
    let titles = [];
    titleAttempts += 1;
    try { titles = proc.windows.name(); } catch (e) { titleRefusals += 1; }
    for (const title of titles) {
      if (title === null || title === undefined) continue;
      out.push({ app, title: String(title), focused: frontmost });
    }
    if (browsers.indexOf(app) !== -1) {
      tabUrlAttempts += 1;
      try {
        const browser = Application(app);
        const windows = browser.windows();
        for (const w of windows) {
          let url = null, name = null;
          try { url = w.activeTab ? w.activeTab.url() : w.currentTab.url(); } catch (e) {
            try { url = w.currentTab.url(); } catch (e2) {}
          }
          try { name = w.name(); } catch (e) {}
          if (url) out.push({ app, title: String(name || ""), url: String(url), focused: frontmost });
        }
      } catch (e) { tabUrlRefusals += 1; }
    }
  }
  JSON.stringify({ windows: out, titleAttempts, titleRefusals, tabUrlAttempts, tabUrlRefusals });
`;

/**
 * Parse and redact the script's output. Exported so the suite runs it on
 * fixtures.
 *
 * **Throws when the poll found nothing and every title read that was
 * attempted refused.** `titleAttempts` and `titleRefusals` come from the
 * script's own per-process count, not from this function guessing at JXA's
 * failure shape: a systemwide Accessibility denial fails every process's
 * title read identically, while a process that legitimately has no windows
 * returns `[]` without throwing. An empty `windows` list with at least one
 * successful title read, or with nothing attempted at all, is left alone —
 * both are "no evidence", not "evidence of a refusal".
 */
export function parseWindows(stdout: string): WindowSignal[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error("window collector returned something that is not JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("window collector returned the wrong shape");
  }
  const payload = raw as Record<string, unknown>;
  const items = payload["windows"];
  if (!Array.isArray(items)) throw new Error("window collector returned the wrong shape");

  const titleAttempts = typeof payload["titleAttempts"] === "number" ? payload["titleAttempts"] : 0;
  const titleRefusals = typeof payload["titleRefusals"] === "number" ? payload["titleRefusals"] : 0;
  if (items.length === 0 && titleAttempts > 0 && titleRefusals === titleAttempts) {
    throw new Error("window collector refused: accessibility access denied for every process");
  }

  const windows: WindowSignal[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const app = typeof record["app"] === "string" ? record["app"] : "";
    if (app === "") continue;
    const title = typeof record["title"] === "string" ? record["title"] : "";
    const url = typeof record["url"] === "string" ? redactUrl(record["url"]) : undefined;
    const signal: WindowSignal = { app, title };
    if (url !== undefined) signal.url = url;
    if (record["focused"] === true) signal.focused = true;
    windows.push(signal);
  }
  return windows;
}

/**
 * How many browsers this poll's tab-URL read refused, out of the script's own
 * `tabUrlRefusals` count. Read separately from `parseWindows` rather than
 * folded into its return value, so that a poll's window titles keep their
 * well-tested, unchanged shape — `WindowSignal[]` — and this stays what it is:
 * a count, not evidence. Deliberately lenient: anything that is not the shape
 * the script produces reads as zero refusals rather than a second thing that
 * can throw, since `parseWindows` above is already what decides whether this
 * poll's output is usable at all.
 */
export function parseTabUrlRefusals(stdout: string): number {
  try {
    const raw: unknown = JSON.parse(stdout);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return 0;
    const value = (raw as Record<string, unknown>)["tabUrlRefusals"];
    return typeof value === "number" && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

export async function collectWindows(): Promise<CollectedWindows> {
  // Longer than the other collectors: System Events enumerating every process
  // on a busy machine is genuinely slow, and this is still well inside the
  // contract's five-second poll.
  const stdout = await osascript(WINDOW_SCRIPT, { timeoutMs: 4_000 });
  return { windows: parseWindows(stdout), tabUrlRefusals: parseTabUrlRefusals(stdout) };
}
