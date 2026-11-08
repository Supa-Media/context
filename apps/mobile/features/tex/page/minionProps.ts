/**
 * The minion characters (Dev2, 2026-11-04): each minion card is the calm #
 * Tex holding what it is doing right now (a laptop while it codes, a
 * magnifying glass while it researches, a hard hat and hammer while it
 * builds), so the figure changes as the job moves from step to step.
 *
 * What a job is doing is read from the step it is on (`JobSummary.now`,
 * which starts with the tool's name: `search_web: flights to Lisbon`,
 * `browse: thecut.co`), from the computer it runs on (a job there is coding),
 * and from its state (waiting on the person). A tool not named here leaves
 * the plain #: the words beside it still say what the job is.
 *
 * The drawings are in a 100 × 100 box: the # takes its lower left, the prop
 * the right and the top. `still` parts stay put; `moving` parts loop through
 * `motion` a few times after each new step, then rest (reduced motion
 * leaves them at rest). A job whose step didn't work also sweats (`TROUBLE`).
 */

import type { JobSummary } from "./texPageTypes";

export type Activity =
  | "coding"
  | "writing"
  | "building"
  | "painting"
  | "researching"
  | "browsing"
  | "sending"
  | "planning"
  | "thinking"
  | "waiting"
  | "working";

/** One stroke of a prop. `fill` paper hides the # behind it; ink and accent fill solid. */
export interface PropPart {
  d: string;
  fill?: "paper" | "ink" | "accent" | "crit";
  /** Stroke colour; ink when left out, none for a filled shape drawn without an edge. */
  stroke?: "ink" | "accent" | "warn" | "none";
  /** Stroke width in box units; the # itself is about 3.5 at this size. */
  width?: number;
}

/** How the moving parts loop: turn about `origin` by ±`amount` degrees, slide or bob by `amount` units, or pulse. */
export interface PropMotion {
  kind: "turn" | "slide" | "bob" | "pulse";
  amount: number;
  /** The pivot of a turn, in box units. */
  origin?: readonly [number, number];
  /** One loop, in milliseconds. */
  ms: number;
}

export interface MinionProp {
  /** The word the card leads its line with; none for the plain #. */
  word: string | null;
  still: PropPart[];
  moving: PropPart[];
  motion: PropMotion | null;
}

/** Where the # sits in the 100 box: its own square, in the lower left. */
export const HASH_BOX = { x: -8, y: 10, size: 94 } as const;

export const PROP_STROKE = 3.2;

/** A job with a step that didn't work: a drop of sweat by the #, in the warning red, whatever it holds. */
export const TROUBLE: PropPart = { d: "M9 18 q-4.5 6.5 -1.5 9.5 q3 2.5 5.5 -0.5 q2 -3 -4 -9 z", fill: "crit", stroke: "none" };

/** How many loops a prop's moving parts run after a new step arrives, before they rest. */
export const LOOPS = 3;

/** How long a character holds before the next step may change it, so a quick run of steps doesn't flicker. */
export const HOLD_MS = 5000;

export const MINION_PROPS: Record<Activity, MinionProp> = {
  coding: {
    word: "Coding",
    still: [
      { d: "M63.9 51.5 h30.4 a1.9 1.9 0 0 1 1.9 1.9 v19 h-34.2 v-19 a1.9 1.9 0 0 1 1.9 -1.9 z", fill: "paper" },
      { d: "M57.25 72.4 h43.7 l-2.85 5.7 h-38 z", fill: "paper" },
    ],
    moving: [{ d: "M73.4 58.15 l-3.8 3.8 l3.8 3.8" }, { d: "M81.47 57.2 l-2.85 9.5" }, { d: "M85.75 58.15 l3.8 3.8 l-3.8 3.8" }],
    motion: { kind: "bob", amount: 1.5, ms: 1400 },
  },
  writing: {
    word: "Writing",
    still: [
      { d: "M58.2 70.5 h32.3 v17.1 h-32.3 z", fill: "paper" },
      { d: "M62.95 76.2 h15.2" },
      { d: "M62.95 81.9 h9.5" },
    ],
    moving: [
      { d: "M81.95 76.2 L87.74 70.5 L97.24 49.79 L92.11 47.32 L82.61 68.03 Z", fill: "paper" },
      { d: "M82.61 68.03 L87.74 70.5" },
    ],
    motion: { kind: "turn", amount: 6, origin: [81.95, 76.2], ms: 1300 },
  },
  building: {
    word: "Building",
    still: [
      { d: "M23 28.2 A15 14 0 0 1 53 28.2 Z", fill: "paper" },
      { d: "M17 28.7 h42", width: 4.5 },
      { d: "M38 15.2 v7" },
    ],
    moving: [
      { d: "M75.3 87.6 L88.6 61", width: 4 },
      { d: "M82.52 54.25 L96.11 61 L93.06 66.89 L79.48 60.14 Z", fill: "ink" },
    ],
    motion: { kind: "turn", amount: 8, origin: [75.3, 87.6], ms: 1200 },
  },
  painting: {
    word: "Painting",
    still: [
      { d: "M22 28.2 Q36 15 55 25.5 Q51 29.5 22 28.2 Z", fill: "paper" },
      { d: "M38 18.5 l1 -4" },
    ],
    moving: [
      { d: "M96.2 45.8 L87.65 64.8", width: 3.6 },
      { d: "M85.18 63.09 L91.26 65.75 L89.27 70.12 L83.18 67.46 Z", fill: "paper" },
      { d: "M83.18 67.46 q-4.75 4.75 -3.32 11.4 q4.75 -2.85 9.4 -8.74 z", fill: "accent", stroke: "ink" },
    ],
    motion: { kind: "turn", amount: 8, origin: [96.2, 45.8], ms: 1400 },
  },
  researching: {
    word: "Researching",
    still: [],
    moving: [
      { d: "M88.6 70.5 L97.15 80", width: 4.5 },
      { d: "M70.55 62.9 a10.45 10.45 0 1 0 20.9 0 a10.45 10.45 0 1 0 -20.9 0 z", fill: "paper" },
      { d: "M75.77 59.1 a6.17 6.17 0 0 1 4.27 -3.23" },
    ],
    motion: { kind: "slide", amount: 3, ms: 1600 },
  },
  browsing: {
    word: "Browsing",
    // A globe, so it never reads as the laptop or the envelope; the pointer clicks beside it.
    still: [
      { d: "M65 60 a13 13 0 1 0 26 0 a13 13 0 1 0 -26 0 z", fill: "paper" },
      { d: "M72 60 a6 13 0 1 0 12 0 a6 13 0 1 0 -12 0 z" },
      { d: "M65.5 60 h25" },
    ],
    moving: [{ d: "M87 70 v14 l3.4 -3.4 l2.8 5.6 l2.5 -1.2 l-2.8 -5.5 h4.6 z", fill: "ink", width: 2.4 }],
    motion: { kind: "bob", amount: 2, ms: 1300 },
  },
  sending: {
    word: "Sending",
    still: [],
    moving: [
      { d: "M66 57.2 h29 v20.9 h-29 z", fill: "paper" },
      { d: "M66 57.2 l14.5 11.4 l14.5 -11.4" },
    ],
    motion: { kind: "slide", amount: 2.5, ms: 1500 },
  },
  planning: {
    word: "Planning",
    still: [
      { d: "M63.9 51.5 h30.4 v28.5 h-30.4 z", fill: "paper" },
      { d: "M63.9 58.15 h30.4" },
      { d: "M71.5 47.7 v6.65" },
      { d: "M86.7 47.7 v6.65" },
    ],
    moving: [{ d: "M71.5 68.6 l3.8 3.8 l7.6 -8.55", stroke: "accent", width: 3.6 }],
    motion: { kind: "pulse", amount: 0.35, ms: 1500 },
  },
  thinking: {
    word: "Thinking",
    still: [
      { d: "M63.9 42.95 a1.9 1.9 0 1 0 3.8 0 a1.9 1.9 0 1 0 -3.8 0 z", fill: "paper" },
      { d: "M68.65 35.35 a2.85 2.85 0 1 0 5.7 0 a2.85 2.85 0 1 0 -5.7 0 z", fill: "paper" },
      { d: "M73.4 24.9 a12.35 9.5 0 1 0 24.7 0 a12.35 9.5 0 1 0 -24.7 0 z", fill: "paper" },
    ],
    moving: [
      { d: "M80.05 24.9 h0.01", width: 4 },
      { d: "M85.75 24.9 h0.01", width: 4 },
      { d: "M91.45 24.9 h0.01", width: 4 },
    ],
    motion: { kind: "pulse", amount: 0.6, ms: 1500 },
  },
  waiting: {
    // Square and amber, and still: the one card that needs the person stands out calmly.
    word: null,
    still: [
      { d: "M69 14 h28 v20 h-14 l-6 6 v-6 h-8 z", fill: "paper", stroke: "warn" },
      { d: "M79.58 20.57 q0 -2.85 3.32 -2.85 q3.32 0 3.32 2.85 q0 2.38 -3.32 3.32 v1.9", stroke: "warn" },
      { d: "M82.9 30.07 h0.01", stroke: "warn", width: 3.6 },
    ],
    moving: [],
    motion: null,
  },
  working: { word: null, still: [], moving: [], motion: null },
};

/** Tool names by what the minion is doing with them; a prefix rule below catches the families. */
const TOOLS: Record<string, Activity> = {
  fetch: "researching",
  orient: "researching",
  notes: "researching",
  related_notes: "researching",
  scope_info: "researching",
  travel_time: "researching",
  job_status: "researching",
  evaluate_lists: "researching",
  app_read: "researching",
  write: "writing",
  remember: "writing",
  save_context: "writing",
  save_email_draft: "writing",
  create_form: "writing",
  update_submission: "writing",
  vote_form: "writing",
  manage: "building",
  apply_layout: "building",
  app_change: "building",
  archive_note: "building",
  connect_app: "building",
  connect_google: "building",
  revoke_link: "building",
  create_link: "building",
  create_workspace: "building",
  migrate_storage_layout: "building",
  set_folder_visibility: "building",
  set_visibility: "building",
  draw_picture: "painting",
  draw_visual: "painting",
  make_picture: "painting",
  picture: "painting",
  browse: "browsing",
  open_page: "browsing",
  fill_card: "browsing",
  fill_login: "browsing",
  submit_form: "browsing",
  sign_out_browser: "browsing",
  send: "sending",
  send_email: "sending",
  mail: "sending",
  mail_agent: "sending",
  google_chat: "sending",
  slack_api: "sending",
  forward_rule: "sending",
  invite_member: "sending",
  chat_share_mail: "sending",
  calendar: "planning",
  calendar_event: "planning",
  read_calendar: "planning",
  ask_advisor: "thinking",
  plan_big_ask: "thinking",
  delegate: "thinking",
};

/** The tool a step line starts with: `search_web: flights` is `search_web`, `write_note save: x` is `write_note`. */
export function stepTool(step: string): string {
  return (/^[A-Za-z][A-Za-z0-9_]*/.exec(step.trim())?.[0] ?? "").toLowerCase();
}

/** What a live job's minion is doing now. */
export function activityOf(job: JobSummary): Activity {
  if (job.state === "waiting") return "waiting";
  // A job on one of the person's computers runs a coding tool there (`apps/agent/src/machineTurn.ts`).
  if (job.machine !== undefined || job.tool !== undefined) return "coding";
  if (job.now === undefined || job.now.trim() === "") return "thinking";
  const tool = stepTool(job.now);
  const named = TOOLS[tool];
  if (named !== undefined) return named;
  if (tool.startsWith("write_") || tool.startsWith("move_")) return tool.startsWith("write_") ? "writing" : "building";
  if (tool.startsWith("search") || tool.startsWith("read_") || tool.startsWith("list_")) return "researching";
  return "working";
}

/**
 * The figure a job's own page draws: the same minion the hub's Minions card
 * shows (Dev2, 2026-11-08), so opening a busy minion keeps its character.
 * A finished job has put its prop down and shows the plain calm #; one with a
 * step that didn't work still sweats. Never the chaos ball: every minion is
 * the calm # (Dev2, 2026-11-04).
 */
export function jobFigureOf(job: JobSummary): { activity: Activity; trouble: boolean } {
  const live = job.state === "running" || job.state === "waiting";
  return { activity: live ? activityOf(job) : "working", trouble: job.failedSteps > 0 };
}
