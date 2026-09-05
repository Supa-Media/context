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
 */

import type { WindowSignal } from "../../core/contract.ts";
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
  for (const proc of procs) {
    let app;
    try { app = proc.name(); } catch (e) { continue; }
    let frontmost = false;
    try { frontmost = proc.frontmost(); } catch (e) {}
    let titles = [];
    try { titles = proc.windows.name(); } catch (e) {}
    for (const title of titles) {
      if (title === null || title === undefined) continue;
      out.push({ app, title: String(title), focused: frontmost });
    }
    if (browsers.indexOf(app) !== -1) {
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
      } catch (e) {}
    }
  }
  JSON.stringify(out);
`;

/** Parse and redact the script's output. Exported so the suite runs it on fixtures. */
export function parseWindows(stdout: string): WindowSignal[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error("window collector returned something that is not JSON");
  }
  if (!Array.isArray(raw)) throw new Error("window collector returned the wrong shape");

  const windows: WindowSignal[] = [];
  for (const item of raw) {
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

export async function collectWindows(): Promise<WindowSignal[]> {
  // Longer than the other collectors: System Events enumerating every process
  // on a busy machine is genuinely slow, and this is still well inside the
  // contract's five-second poll.
  return parseWindows(await osascript(WINDOW_SCRIPT, { timeoutMs: 4_000 }));
}
