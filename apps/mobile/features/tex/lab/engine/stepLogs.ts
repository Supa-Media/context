/**
 * Every step on the canvas and what it logs (Dev2, 2026-11-14: "Every single block should have proper logging of
 * what's going in and out and what parameters were set ... if I go through another thing and I see a step doesn't log
 * what's going in and out ... I'm going to rip your head off").
 *
 * One row per canvas step: the ledger records that say what it got (`got`) and what it gave (`gave`), and where its
 * settings come from (`settings`). `stepIO.ts` reads each. `__tests__/texLabStepLogs.test.ts` fails when a step on the
 * canvas has no row here, or when a turn that logged every record below still leaves a step without its Got and Gave.
 * A new step is logged before it is drawn.
 */
export type StepLog = { got: string; gave: string; settings: string };

export const STEP_LOGS: Record<string, StepLog> = {
  checkin: { got: "note (check-in): what it was asked to look at (about)", gave: "note: the text it sent, or its turn's steps when it stayed quiet", settings: "door step: model, effort; the check-in setting" },
  routine: { got: "note (routine): the routine note it ran", gave: "note: what it texted and its outcome", settings: "door step; the routine's own settings" },
  notify: { got: "note (ping): what another AI asked it to say", gave: "note: the text as sent", settings: "their ping settings (no model)" },
  text: { got: "text: the words, picture or tapback as it arrived", gave: "text: kept in the chat's record, with its event id", settings: "the chat's service" },
  triage: { got: "step triage: the ids of the texts code looked at", gave: "step triage: where code sent them (straight to Tex, to the judge, beside a running turn) and the rule that did", settings: "code" },
  decide: { got: "step decide / judge (moment): the ids of the texts it weighed, put back into words from the chat; whether a turn was running", gave: "its verdict, why, how sure, a tapback, what a running turn does", settings: "its model (Clef)" },
  react: { got: "step react: the text it reacted on", gave: "step react: the emoji sent, or that it failed", settings: "who chose it (judge, a tool starting)" },
  lanes: { got: "reply timing + door step: the texts the turn covers", gave: "reply timing waitMs: how long it waited for the turn ahead; step lane: the write lock", settings: "one turn per chat (groups three)" },
  door: { got: "door step: what kind of turn, for which chat and texts", gave: "door step: every setting the turn runs with; brief; reply timing: what it gathered; the prompt's context modules", settings: "door step output" },
  router: { got: "step router: the question", gave: "step router: the tier and model it picked", settings: "its model" },
  fd: { got: "the text; each round's context modules, in prompt order, with sizes and fingerprints", gave: "thinking, said, tool calls, each round's tokens, the answer", settings: "reply timing rounds: model per round; door step: effort" },
  fallback: { got: "step fallback: the model that failed and why", gave: "step fallback: the model it moved to", settings: "the setup's fallback" },
  planner: { got: "tool plan_big_ask: the ask and folder", gave: "tool plan_big_ask: the jobs it started", settings: "door step: planner on or off" },
  tools: { got: "tool: its name and arguments", gave: "tool: its result, time and whether it failed", settings: "the tools the door allowed" },
  advisor: { got: "tool ask_advisor / advisor: the question", gave: "the advisor's answer", settings: "door step: advisor model" },
  checks: { got: "step checks: the draft", gave: "step checks / judge (code): passed, or why it went back", settings: "code" },
  mail: { got: "mail_check: the email (to, subject)", gave: "mail_check: its verdict and why", settings: "its model" },
  card: { got: "step card: the tool, template and pins", gave: "step card: its verdict", settings: "its model" },
  reviewer: { got: "judge (review): the draft", gave: "judge (review): let it go or sent back, with feedback", settings: "its model" },
  send: { got: "the answer as it left the checks", gave: "text: each text sent, delivered or not", settings: "the chat's service" },
  classifier: { got: "step classifier: the text", gave: "step classifier: the threads it filed it into", settings: "its model" },
  selfreview: { got: "step selfreview: the chat it looked back on", gave: "step selfreview: what to do better", settings: "its model" },
  job: { got: "job: the job and its brief", gave: "job: its state and advice", settings: "the job's model" },
  jobcheck: { got: "advisor (check): the job's work so far", gave: "advisor (check): keep going or done, and why", settings: "the advisor's model" },
  mailadv: { got: "step mailadv: the mail and who sent it", gave: "step mailadv: what to tell them", settings: "its model" },
  handback: { got: "step handback: the job's answer", gave: "step handback: passed, or what's wrong", settings: "its model" },
  egress: { got: "step egress: the words, the action, the workspace and the subject", gave: "step egress: allow or not, and why", settings: "its model and effort" },
  picture: { got: "step picture: the tool (draw_visual, draw_picture or make_picture) and its args", gave: "step picture: the result", settings: "its model (Gemini)" },
  nudge: { got: "step nudge: the question, the answer and whether the chat is tainted", gave: "step nudge: what it wrote into About me", settings: "its model" },
  reflect: { got: "step reflect: the question, tainted, own text and can write", gave: "step reflect: what it wrote down, and why not", settings: "its model" },
  nightly: { got: "step nightly: which run (dream or housekeeping), the time zone and since", gave: "step nightly: which step it started and with what", settings: "code; the control plane's schedule" },
  dream: { got: "step dream: the time zone and since", gave: "step dream: the outcome, the status and when", settings: "its model" },
  daysum: { got: "step daysum: the time zone and now", gave: "step daysum: the outcome", settings: "its model" },
  housekeep: { got: "step housekeep: the time zone", gave: "step housekeep: the outcome and the status", settings: "its model" },
};

/** Step names the gateway and Worker log under another canvas step's name. */
export const STEP_ALIAS: Record<string, string> = { lane: "lanes", model: "fd", steer: "fd", recheck: "decide" };

/** The canvas step a `step` entry belongs to, or null (`timing` entries are Door steps' gathering, read from the reply). */
export const nodeOfStep = (step: unknown): string | null => (typeof step !== "string" || step === "timing" ? null : (STEP_ALIAS[step] ?? (step in STEP_LOGS ? step : null)));
