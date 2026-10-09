import type { Decision } from "./gateway";

/**
 * What the approvals screen says about one held call.
 *
 * Every function takes `now` rather than reading the clock, so the wording is a
 * fact about two timestamps and the tests do not depend on when they run. The
 * sentences are the person's own words for the row they are looking at: who
 * asked, when, how long the answer is good for, and what happened after they
 * pressed a button.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const RESULT_LIMIT = 200;

/** "Asked by Claude Desktop", or a neutral line when the gateway did not name the client. */
export function clientLine(client: string | null): string {
  return client === null ? "Asked by an app you connected" : `Asked by ${client}`;
}

/** How long ago it was asked, in the largest unit that is still a count. */
export function askedLine(createdAt: number, now: number): string {
  // A timestamp ahead of this clock is a skew, not an age: say "just now".
  const age = Math.max(0, now - createdAt);
  if (age < MINUTE_MS) return "Asked just now";
  if (age < HOUR_MS) return `Asked ${Math.floor(age / MINUTE_MS)} min ago`;
  if (age < DAY_MS) return `Asked ${Math.floor(age / HOUR_MS)} h ago`;
  const date = new Date(createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `Asked on ${date}`;
}

/**
 * How long the answer is still good for.
 *
 * Rounded **up**, so a call with a few seconds left reads as one minute rather
 * than as expired. "Expired" is only said once the time has actually run out.
 */
export function expiryLine(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left <= 0) return "Expired";
  return `Expires in ${Math.ceil(left / MINUTE_MS)} min`;
}

/** The notice after a decision. `ok` is the gateway's word that the call ran. */
export function decisionNotice(decision: Decision): { tone: "ok" | "warn"; text: string } {
  if (decision.status === "denied") return { tone: "ok", text: "Denied. Nothing ran." };
  if (decision.ok) return { tone: "ok", text: "Approved. It ran as asked." };
  const reason = oneLine(decision.result);
  return {
    tone: "warn",
    text: reason.length > 0 ? `Approved, but it did not run. ${reason}` : "Approved, but it did not run.",
  };
}

/** The count on the Approvals tab, or nothing when nothing is waiting. */
export function pendingCount(waiting: number): string {
  return waiting > 0 ? String(waiting) : "";
}

/**
 * The arguments as the JSON that was sent, for the person to read before they
 * say yes. A value JSON cannot write is said so rather than thrown.
 */
export function argsText(args: unknown): string {
  try {
    return JSON.stringify(args, null, 2) ?? "null";
  } catch {
    return "(not shown)";
  }
}

/** A tool's own answer, flattened to one line and kept short enough for a notice. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > RESULT_LIMIT ? `${flat.slice(0, RESULT_LIMIT - 1)}…` : flat;
}
