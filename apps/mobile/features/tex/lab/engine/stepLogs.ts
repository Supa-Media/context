/**
 * Every step on the canvas and what it logs (Dev2, 2026-11-14: "Every single block should have proper logging of
 * what's going in and out and what parameters were set ... if I go through another thing and I see a step doesn't log
 * what's going in and out ... I'm going to rip your head off").
 *
 * One row per canvas step: the ledger records that say what it got (`got`) and what it gave (`gave`), where its
 * settings come from (`settings`), and what its time measures (`time`). `stepIO.ts` reads each. `__tests__/texLabStepLogs.test.ts` fails when a step on the
 * canvas has no row here, or when a turn that logged every record below still leaves a step without its Got and Gave.
 * A new step is logged before it is drawn.
 */
/**
 * `time`: what its real time measures (Dev2, 2026-11-15: "3 nodes are actually logging as 0s which is obviously wrong").
 * Every step's is its own, never another step's and never a remainder; plain code with no wait reads 0 on the Workers
 * clock, which moves only across a wait, and is shown as under 1 ms.
 */
export type StepLog = { got: string; gave: string; settings: string; time: string };

export const STEP_LOGS: Record<string, StepLog> = {
  checkin: { got: "note (check-in): what it was asked to look at (about)", gave: "note: the text it sent, or its turn's steps when it stayed quiet", settings: "door step: model, effort; the check-in setting" , time: "node run: its own time" },
  routine: { got: "note (routine): the routine note it ran", gave: "note: what it texted and its outcome", settings: "door step; the routine's own settings" , time: "node run: its own time" },
  notify: { got: "note (ping): what another AI asked it to say", gave: "note: the text as sent", settings: "their ping settings (no model)" , time: "node run: its own time" },
  text: { got: "text: the words, picture or tapback as it arrived", gave: "text: kept in the chat's record, with its event id", settings: "the chat's service" , time: "step text: the service's lag from the person's send to the webhook" },
  oldLine: { got: "step oldLine: the staff setting (mode, whether a new number and an archive day are set) and how long ago this chat was last told", gave: "step oldLine: redirect, hold or pass, and the reply's length", settings: "staff console, Platform → Lines (no model)" , time: "step oldLine: its own time" },
  edit: { got: "step edit: edit or unsend, 1:1 or group, the new words' length, and where the words before came from (the chat's own text, the line's copy, or none)", gave: "step edit: turn, same or withdraw, and why", settings: "none (no model)", time: "step edit: its own time" },
  moveChat: { got: "step moveChat: the kind of chat staff moved and whether a new number and an archive day are set", gave: "step moveChat: told, already told, on the new line already, or why it failed, and the text's length", settings: "staff console, Platform → Lines (no model)" , time: "step moveChat: its own time" },
  triage: { got: "step triage: the ids of the texts code looked at", gave: "step triage: where code sent them (straight to Tex, to the judge, beside a running turn) and the rule that did", settings: "code" , time: "step triage: its own time (plain code: under 1 ms)" },
  decide: { got: "step decide / judge (moment): the ids of the texts it weighed, put back into words from the chat; whether a turn was running", gave: "its verdict, why, how sure, a tapback, what a running turn does", settings: "its model (Clef)" , time: "step decide: the judge's call" },
  react: { got: "step react: the text it reacted on", gave: "step react: the emoji sent, or that it failed", settings: "who chose it (judge, a tool starting)" , time: "step react: the tapback's call to the service" },
  lanes: { got: "reply timing + door step: the texts the turn covers", gave: "reply timing waitMs: how long it waited for the turn ahead; step lane: the write lock", settings: "one turn per chat (groups three)" , time: "reply timing waitMs: the wait for the turn ahead" },
  door: { got: "door step: what kind of turn, for which chat and texts", gave: "door step: every setting the turn runs with; brief; reply timing: what it gathered; the prompt's context modules", settings: "door step output" , time: "reply timing: from the turn's start to the first model call" },
  router: { got: "step router: the question", gave: "step router: the tier and model it picked", settings: "its model" , time: "step router: its call" },
  fd: { got: "the text; each round's context modules, in prompt order, with sizes and fingerprints", gave: "thinking, said, tool calls, each round's tokens, the answer", settings: "reply timing rounds: model per round; door step: effort" , time: "node runs: each run's own time (less the tools and helpers it called); the rounds count its model calls" },
  fallback: { got: "step fallback: the model that failed and why", gave: "step fallback: the model it moved to", settings: "the setup's fallback" , time: "step fallback: its call" },
  planner: { got: "tool plan_big_ask: the ask and folder", gave: "tool plan_big_ask: the jobs it started", settings: "door step: planner on or off" , time: "tool plan_big_ask: its time" },
  tools: { got: "tool: its name and arguments", gave: "tool: its result, time and whether it failed", settings: "the tools the door allowed" , time: "node runs, or tool entries before the runner: each call's time" },
  advisor: { got: "tool ask_advisor / advisor: the question", gave: "the advisor's answer", settings: "door step: advisor model" , time: "node run: its own time" },
  checks: { got: "step checks: the draft", gave: "step checks / judge (code): passed, or why it went back", settings: "code" , time: "node run: its own time, less the front door's rewrites it sent back for (plain code: under 1 ms)" },
  mail: { got: "mail_check: the email (to, subject)", gave: "mail_check: its verdict and why", settings: "its model" , time: "mail_check: its call" },
  card: { got: "step card: the tool, template and pins", gave: "step card: its verdict", settings: "its model" , time: "step card: its call" },
  reviewer: { got: "judge (review): the draft", gave: "judge (review): let it go or sent back, with feedback", settings: "its model" , time: "judge (review): its call" },
  send: { got: "the answer as it left the checks", gave: "text: each text sent, delivered or not", settings: "the chat's service" , time: "node run (building the reply in the gateway) plus step send (delivery): the texting Worker handing it to the service" },
  classifier: { got: "step classifier: the text", gave: "step classifier: the threads it filed it into", settings: "its model" , time: "node run: its own time, in the background" },
  selfreview: { got: "step selfreview: the chat it looked back on", gave: "step selfreview: what to do better", settings: "its model" , time: "node run: its own time, in the background" },
  job: { got: "job: the job and its brief", gave: "job: its state and advice", settings: "the job's model" , time: "job: its run" },
  jobcheck: { got: "advisor (check): the job's work so far", gave: "advisor (check): keep going or done, and why", settings: "the advisor's model" , time: "advisor (check): its call" },
  mailadv: { got: "step mailadv: the mail and who sent it", gave: "step mailadv: what to tell them", settings: "its model" , time: "step mailadv: its call" },
  handback: { got: "step handback: the job's answer", gave: "step handback: passed, or what's wrong", settings: "its model" , time: "step handback: its call" },
  egress: { got: "step egress: the words, the action, the workspace and the subject", gave: "step egress: allow or not, and why", settings: "its model and effort" , time: "step egress: its call" },
  picture: { got: "step picture: the tool (draw_visual, draw_picture or make_picture) and its args", gave: "step picture: the result", settings: "its model (Gemini)" , time: "step picture: its call" },
  nudge: { got: "step nudge: the question, the answer and whether the chat is tainted", gave: "step nudge: what it wrote into About me", settings: "its model" , time: "node run: its own time, in the background (a skip is under 1 ms)" },
  reflect: { got: "step reflect: the question, tainted, own text and can write", gave: "step reflect: what it wrote down, and why not", settings: "its model" , time: "node run: its own time, in the background (a skip is under 1 ms)" },
  nightly: { got: "step nightly: which run (dream or housekeeping), the time zone and since", gave: "step nightly: which step it started and with what", settings: "code; the control plane's schedule" , time: "node run: its own time" },
  dream: { got: "step dream: the time zone and since", gave: "step dream: the outcome, the status and when", settings: "its model" , time: "node run: its own time" },
  daysum: { got: "step daysum: the time zone and now", gave: "step daysum: the outcome", settings: "its model" , time: "node run: its own time" },
  housekeep: { got: "step housekeep: the time zone", gave: "step housekeep: the outcome and the status", settings: "its model" , time: "node run: its own time" },
};

/** Step names the gateway and Worker log under another canvas step's name. */
export const STEP_ALIAS: Record<string, string> = { lane: "lanes", model: "fd", steer: "fd", recheck: "decide" };

/** The canvas step a `step` entry belongs to, or null (`timing` entries are Door steps' gathering, read from the reply). */
export const nodeOfStep = (step: unknown): string | null => (typeof step !== "string" || step === "timing" ? null : (STEP_ALIAS[step] ?? (step in STEP_LOGS ? step : null)));
