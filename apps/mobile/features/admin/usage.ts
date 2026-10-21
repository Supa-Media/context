/**
 * The Usage tab's arithmetic and words, kept apart from its drawing so they can
 * be tested without mounting anything. The figures come from
 * `usageAnalytics.report` (`apps/convex/functions/lib/adminFns/usageAnalytics.ts`).
 */

import { USAGE_BUTTONS, USAGE_ACTIONS, isUsageAction, isUsageButton } from "@context/shared";
import { formatCount, shortDay, type Point } from "./report";

/**
 * Plain names for the cleaned routes the app reports. A route not listed is
 * shown as itself, which is still only route names and placeholders.
 */
const PAGE_LABELS: Readonly<Record<string, string>> = {
  "/": "Home",
  "/:value": "Website page",
  "/console": "Workspaces",
  "/console/:context": "Workspace",
  "/console/:context/settings": "Workspace settings",
  "/console/connections": "Connections",
  "/console/map": "Map",
  "/console/search": "Search",
  "/console/shared": "Shared with me",
  "/note/:context/:value": "Note",
  "/meetings": "Meetings",
  "/meetings/:value": "A meeting",
  "/welcome": "Welcome",
  "/workspace/new": "New workspace",
  "/login": "Sign in",
  "/signin/:token": "Sign-in link",
  "/invite/:token": "Invitation",
  "/join/:token": "Join a workspace",
  "/s/:token": "Shared link",
  "/authorize": "Connect an AI",
  "/connect/cli": "Connect the CLI",
  "/tex/:context": "Tex's computer",
  "/text": "Text Tex",
  "/texts/:token": "Tex sign-in link",
  "/waitlist": "Waitlist",
  "/admin": "Staff console",
  "/admin/:value": "Staff console",
  "/privacy": "Privacy",
  "/terms": "Terms",
  "/support": "Support",
};

export function pageLabel(route: string): string {
  return PAGE_LABELS[route] ?? route;
}

export function buttonLabel(button: string): string {
  return isUsageButton(button) ? USAGE_BUTTONS[button] : isUsageAction(button) ? USAGE_ACTIONS[button] : button;
}

/** `45s`, `4m 10s`, `2h 5m`. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A change in a duration, signed like every change on the console: `+38s`, `−1m 5s`. */
export function formatSignedDuration(change: number): string {
  const value = Math.round(change);
  if (value === 0) return "±0s";
  return `${value > 0 ? "+" : "−"}${formatDuration(Math.abs(value))}`;
}

/** Hours, whole below a hundred and rounded above, for "Total hours". */
export function formatHours(seconds: number): string {
  const hours = seconds / 3600;
  if (hours > 0 && hours < 1) return "<1";
  return formatCount(Math.round(hours));
}

/** `2.6` visits each, or a dash when nobody came. */
export function perEach(total: number, people: number): string {
  if (people <= 0) return "—";
  return (Math.round((total / people) * 10) / 10).toFixed(1);
}

/** The window's busiest day, or `null` when every day was empty. */
export function busiestDay(daily: readonly Point[]): { count: number; day: string } | null {
  let best: Point | null = null;
  for (const point of daily) if (point.count > 0 && (best === null || point.count >= best.count)) best = point;
  return best === null ? null : { count: best.count, day: shortDay(best.day) };
}

/**
 * How a figure compares with the window before. There is no change to print
 * when the window before measured nothing: "+41 on the 30 before" against a
 * period nobody counted is a claim, not a figure.
 */
export function comparison(now: number, prior: number, days: number): { change: number | null; words: string } {
  if (prior === 0) return { change: null, words: now === 0 ? "nothing yet" : `none in the ${days} before` };
  return { change: now - prior, words: `on the ${days} before` };
}

/** The same for a duration, which reads `+38s` rather than `+38`. */
export function durationComparison(
  now: number,
  prior: number | null,
  days: number,
): { change: string | null; up: boolean; words: string } {
  if (prior === null || prior === 0) return { change: null, up: false, words: "nothing to compare yet" };
  return { change: formatSignedDuration(now - prior), up: now >= prior, words: `on the ${days} before` };
}

/** Each row's share of the list's largest, for the bar beside it. */
export function shares(values: readonly number[]): number[] {
  const top = Math.max(0, ...values);
  return values.map((value) => (top === 0 ? 0 : value / top));
}
