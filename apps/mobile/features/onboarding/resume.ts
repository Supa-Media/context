import { CONSOLE_ROUTE, isInvitePath, type RouteDecision } from "../auth/redirect";
import { WELCOME_ROUTE, isWelcomePath } from "./route";

/**
 * Picking an unfinished setup back up, at sign-in.
 *
 * `/welcome` can be left for good halfway through: a person claims their
 * name, reaches "where do your notes live", and closes the tab. The `(app)`
 * gate then renders the console — they own a workspace, so there is somewhere
 * to go — and nothing ever asks again. They are left with a name and nowhere
 * for a note to be written.
 *
 * So at the first console visit of a session, an owner whose **personal
 * workspace has no storage binding at all** is sent back to the step that
 * asks, with a way out. The rule is deliberately that narrow:
 *
 *  - **No binding, not a failing one.** A bucket that stopped verifying is a
 *    different problem with its own notice in the console, and "set up your
 *    storage" over a bucket full of notes would be wrong news.
 *  - **Only a session that came in by the front door.** Somebody who signed
 *    in to follow a link to a note is taken to the note; being redirected
 *    away from what you were sent is worse than being asked later. It is the
 *    *entry* that is judged, not the path at the moment the answer lands:
 *    `/console` forwards to the last place within a tick, which is sooner
 *    than a second round trip for the binding comes back, so a path check
 *    would almost never see the front door it was waiting for.
 *  - **Once per sign-in, and skippable.** "I'll do this later" goes to the
 *    console and the question comes back at the next sign-in — not on every
 *    load in between, which is what `markResumeAsked` records.
 *  - **Only when every answer is in.** A binding still loading, or a query
 *    that failed, is not evidence of anything, and a gate that cannot answer
 *    renders — the same rule as `needsOnboarding`.
 */
export const RESUME_STORAGE_HREF = `${WELCOME_ROUTE}?resume=storage`;

export interface ResumeWorkspaceRow {
  workspaceId: string;
  kind: string;
  role: string;
}

/** The personal workspace this account owns, if it owns one. */
export function ownPersonalWorkspace<T extends ResumeWorkspaceRow>(
  rows: readonly T[] | undefined,
): T | undefined {
  return rows?.find((row) => row.kind === "personal" && row.role === "owner");
}

/** The console's front door: `/console` and nothing under it. */
export function isFrontDoor(pathname: string): boolean {
  return pathname.split("?")[0]!.split("#")[0]!.replace(/\/+$/, "") === CONSOLE_ROUTE;
}

export function resumeAtLogin({
  rows,
  binding,
  asked,
  entry,
  pathname,
}: {
  /** `listMyWorkspaces`, or `undefined` while it is outstanding. */
  rows: readonly ResumeWorkspaceRow[] | undefined;
  /**
   * `getStorageBinding` for that personal workspace: `null` is "none", an
   * object is a binding in any state, `undefined` is no answer (loading,
   * failed, or not asked).
   */
  binding: object | null | undefined;
  /** Whether this sign-in has already been asked. */
  asked: boolean;
  /** How this session came in — see `sessionEntry`. */
  entry: "front" | "deep";
  /** Where the person is now. */
  pathname: string;
}): RouteDecision {
  if (asked || entry !== "front") return { action: "render" };
  // Their own gates, and redirecting to where somebody already is is a loop.
  if (isWelcomePath(pathname) || isInvitePath(pathname)) return { action: "render" };
  if (ownPersonalWorkspace(rows) === undefined) return { action: "render" };
  if (binding !== null) return { action: "render" };
  return { action: "redirect", href: RESUME_STORAGE_HREF };
}

/*
  How this JavaScript session came in, judged once, at its first signed-in
  render of the app. On the web a sign-in ends in a real navigation to where
  it was headed (`landAfterSignIn`), so the first render after it *is* the
  destination; on a phone `resetResumeAsked` at sign-in clears it so the next
  render judges again.
*/
let entry: "front" | "deep" | null = null;

export function sessionEntry(pathname: string): "front" | "deep" {
  if (entry === null) entry = isFrontDoor(pathname) ? "front" : "deep";
  return entry;
}

/*
  Where "asked since this sign-in" lives.

  `localStorage` on the web, because a reload and a second tab are both "in
  between" and neither should ask again; memory on a phone, where there is no
  `localStorage` and an app launch is the natural session. `resetResumeAsked`
  runs at sign-in, which is what makes the question come back at the next one.

  Every access is guarded: storage can throw in a private window, and a
  prompt that cannot be remembered must fail towards *not* nagging.
*/
const ASKED_KEY = "context.lc.onboarding.resume-asked.v1";
let askedInMemory = false;

function sessionStore(): Storage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function resumeAsked(): boolean {
  if (askedInMemory) return true;
  try {
    return sessionStore()?.getItem(ASKED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markResumeAsked(): void {
  askedInMemory = true;
  try {
    sessionStore()?.setItem(ASKED_KEY, "1");
  } catch {
    // Memory still holds it for this session.
  }
}

export function resetResumeAsked(): void {
  askedInMemory = false;
  entry = null;
  try {
    sessionStore()?.removeItem(ASKED_KEY);
  } catch {
    // Nothing to forget.
  }
}
