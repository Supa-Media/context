/**
 * BROWSERBASE'S CAPTCHA SOLVER, HEARD WHILE IT WORKS (owner, 2026-11-05).
 *
 * Browserbase solves captchas itself and says so in the page's console:
 * `browserbase-solving-started`, then `-finished` or `-errored`. Its guide for
 * agents: while a solve runs, don't click, type, reload or hand over; after
 * it, look at the page again. An invisible reCAPTCHA shows nothing on the
 * page (./captcha.ts can't see it being solved), so a press made mid-solve
 * is turned away without a word: an airline's check-in form reset twice that
 * way while another agent got through the same form minutes later.
 *
 * This listens on the page's connection for those three lines and keeps the
 * latest. Only the solver's own fixed words are matched and kept; nothing
 * else the page logs is read or leaves it. The Log domain is turned on to
 * hear them; the Runtime domain is not (a known bot-check tell): a console
 * line Chrome reports through Runtime is heard only if something else turned
 * it on.
 */

import type { CdpTransport } from "./cdp";

export type SolverState = "solving" | "finished" | "errored";

export interface Solver {
  /** The solver's latest word on this connection, or null when it has said nothing. */
  state(): SolverState | null;
}

const LINES: Record<string, SolverState> = {
  "browserbase-solving-started": "solving",
  "browserbase-solving-finished": "finished",
  "browserbase-solving-errored": "errored",
};

/** The solver's state a console line names, or null for any other line. */
export function solverLine(text: unknown): SolverState | null {
  return typeof text === "string" ? (LINES[text.trim()] ?? null) : null;
}

/** Start listening on `cdp` for the page attached as `sessionId`. */
export async function watchSolver(cdp: CdpTransport, send: (method: string) => Promise<unknown>, sessionId?: string): Promise<Solver> {
  let latest: SolverState | null = null;
  const heard = (state: SolverState | null, via: string, from?: string) => {
    if (state === null || (sessionId !== undefined && from !== undefined && from !== sessionId)) return;
    latest = state;
    // The state and the channel only, so production shows which one carries the solver's words.
    console.log(JSON.stringify({ event: "site_shots_captcha_solver", state, via }));
  };
  cdp.on?.("Log.entryAdded", (params, from) => heard(solverLine((params as { entry?: { text?: unknown } } | null)?.entry?.text), "log", from));
  cdp.on?.("Runtime.consoleAPICalled", (params, from) => {
    const args = (params as { args?: Array<{ value?: unknown }> } | null)?.args ?? [];
    heard(solverLine(args[0]?.value), "runtime", from);
  });
  await send("Log.enable").catch(() => undefined);
  return { state: () => latest };
}

/** How often a held step looks again at whether the solver is done. */
const SOLVER_POLL_MS = 250;
/** What a step held past the call's time by a captcha solve says. */
export const STILL_SOLVING = "a captcha is being solved for you; don't press anything, read the page again in a few seconds";

export const nap = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait while `solving`, until `end`; how long it waited. */
export async function solveEnds(solving: () => boolean, end: number, now: () => number, pause: (ms: number) => Promise<unknown> = nap): Promise<number> {
  const from = now();
  while (solving() && now() < end) await pause(SOLVER_POLL_MS);
  return now() - from;
}
