/**
 * "Never record these apps", and what that has to mean to be worth having.
 *
 * The blocklist is the promise that makes the rest of this app acceptable: a
 * person can put their therapy call, their 1:1 tool or their bank's video
 * support on it and know the machine will not listen. So it is honoured in two
 * places, not one:
 *
 *  1. **Before detection.** `redactBlocked` strips a blocked app's processes,
 *     windows and tabs out of the signals *before* they reach `detect()`. A
 *     blocked app therefore cannot become a `MeetingSource`, cannot raise the
 *     panel, and — this is the part that matters — its window title never
 *     reaches a log line, a tooltip or the "what it noticed" list.
 *  2. **Before capture.** `blockedSource` is checked again at the consent gate,
 *     so even a source that arrived some other way (a calendar event naming a
 *     conference URL, a future collector) cannot start a recording.
 *
 * Two gates for one rule is not belt-and-braces for its own sake: (1) is what
 * keeps the blocked app out of the *user interface*, and (2) is what keeps it
 * out of the *microphone*. Removing either leaves a real hole.
 *
 * ## The matching rule, stated once
 *
 * Names arrive in four shapes on macOS — `Zoom`, `zoom.us`, `us.zoom.xos`,
 * `/Applications/zoom.us.app` — and a person types one word. So an entry
 * matches when, after lowercasing and stripping any path and `.app` suffix, it
 * equals the candidate, or equals one of the candidate's dot-separated
 * segments, or equals a segment of the candidate URL's host.
 *
 * It is deliberately **not** a substring match. `zoom` blocking `Zoombini`, or
 * `meet` blocking `Meetup`, is a blocklist that silently stops recording
 * meetings the person expected to be recorded — and they would have no way to
 * find out why. Segment equality is the widest rule that cannot do that.
 */

import type { DetectionSignals, MeetingSource, WindowSignal } from "../contract.ts";

/**
 * Reduce an app name, bundle id or path to the token a person would type.
 * `/Applications/zoom.us.app` and `zoom.us` both become `zoom.us`.
 */
export function normalizeAppName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (trimmed === "") return "";
  const leaf = trimmed.split("/").filter(Boolean).pop() ?? trimmed;
  return leaf.endsWith(".app") ? leaf.slice(0, -4) : leaf;
}

/**
 * The blocklist as normalized tokens.
 *
 * Empty entries are dropped here rather than trusted to be absent: a blocklist
 * containing `""` would otherwise match every candidate whose normalized name
 * was empty, and "blocks everything" is not a failure a person could diagnose.
 */
function entrySet(blocklist: readonly string[]): Set<string> {
  return new Set(blocklist.map(normalizeAppName).filter((entry) => entry !== ""));
}

function segments(candidate: string): string[] {
  const normalized = normalizeAppName(candidate);
  if (normalized === "") return [];
  return [normalized, ...normalized.split(".").filter(Boolean)];
}

function hostSegments(url: string | undefined): string[] {
  if (!url) return [];
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return [];
  }
  if (host === "") return [];
  const parts = host.split(".").filter(Boolean);
  // The full host and every suffix of it: `teams.microsoft.com` is matched by
  // `teams`, by `microsoft.com`, and by the whole host — but not by `com`,
  // which is why the last segment alone is dropped.
  const suffixes: string[] = [];
  for (let i = 0; i < parts.length - 1; i += 1) suffixes.push(parts.slice(i).join("."));
  return [host, ...parts.slice(0, -1), ...suffixes];
}

/** True when `candidate` — an app name, bundle id or path — is on the list. */
export function isBlockedApp(candidate: string | undefined, blocklist: readonly string[]): boolean {
  if (!candidate) return false;
  const entries = entrySet(blocklist);
  if (entries.size === 0) return false;
  return segments(candidate).some((segment) => entries.has(segment));
}

/** True when a window belongs to a blocked app *or* points at a blocked host. */
export function isBlockedWindow(window: WindowSignal, blocklist: readonly string[]): boolean {
  if (isBlockedApp(window.app, blocklist)) return true;
  const entries = entrySet(blocklist);
  return hostSegments(window.url).some((segment) => entries.has(segment));
}

/**
 * True when a detected source names a blocked app or a blocked conference host.
 * The second gate: this is what the consent gate asks before any capture.
 */
export function isBlockedSource(source: MeetingSource, blocklist: readonly string[]): boolean {
  if (isBlockedApp(source.app, blocklist)) return true;
  const entries = entrySet(blocklist);
  return hostSegments(source.url).some((segment) => entries.has(segment));
}

/**
 * The signals a blocked app is absent from.
 *
 * `microphoneInUse` is deliberately *not* cleared when the blocked app is the
 * one holding the microphone. It is a single machine-wide boolean with no app
 * attached, so clearing it would be a guess — and the guess that would hurt is
 * the other one: leaving it true means a genuine unrelated meeting starting
 * during a blocked call still reads as a meeting, and the blocked app is still
 * absent from every name, title and URL the detector or the UI ever sees.
 */
export function redactBlocked(signals: DetectionSignals, blocklist: readonly string[]): DetectionSignals {
  if (blocklist.length === 0) return signals;
  const entries = entrySet(blocklist);
  return {
    ...signals,
    processes: signals.processes.filter((name) => !isBlockedApp(name, blocklist)),
    windows: signals.windows.filter((window) => !isBlockedWindow(window, blocklist)),
    calendarEvents: signals.calendarEvents.filter(
      (event) => !hostSegments(event.conferenceUrl).some((segment) => entries.has(segment)),
    ),
  };
}
