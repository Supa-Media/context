/**
 * The Tex page's data, as the gateway's `/tex/page` routes answer it
 * (the contract: `docs/decisions/texting-assistant/tex-page.md`).
 *
 * Every field is read defensively in `texPageRead.ts`: a section whose records
 * do not exist yet answers empty, never an error, so the page draws whatever
 * the gateway has and nothing else.
 */

import type { MachineAction, MachineAsk, SlotPlace } from "./texMachineTypes";

export type ChatKey = string; // "me" or a group's key

export interface ChatRef {
  key: ChatKey;
  name: string;
  /** How many people are in a group chat. */
  people?: number;
  /** A group chat's home: its workspace as `@slug` and its folder (`tex/groups/<words>`). */
  home?: { context: string; folder: string };
}

export type ActionKind = "advisor" | "job" | "mailcheck" | "tool";

export interface TurnAction {
  kind: ActionKind;
  label: string;
  /** A job id, an advisor ask id, or an email check id. */
  ref?: string;
}

export interface Turn {
  at: number;
  who: string;
  said: string;
  thought: string;
  did: TurnAction[];
  /** `null` when Tex stayed quiet. */
  reply: string | null;
  ms: number;
  /** Replies it wrote that were sent back before one went, oldest first. */
  drafts?: TurnDraft[];
}

/** A reply that did not go out, and what sent it back: the reviewer (the gates, before 2026-11-06), a code check, or a later text. */
export interface TurnDraft {
  text: string;
  by: "review" | "gates" | "code" | "late";
  failed: string[];
  notice?: string;
}

export type JobState = "running" | "waiting" | "done" | "failed" | "stopped";

export interface JobSummary {
  id: string;
  title: string;
  state: JobState;
  startedAt: number;
  endedAt?: number;
  failedSteps: number;
  /** What the job is waiting on the person for. */
  needs?: string;
  /** In a group: who asked for it. */
  for?: string;
  /** The step it is on now. */
  now?: string;
  slot?: number;
  /** Where it ran when that was one of the person's machines: "On Seyi's MacBook Pro". */
  ranOn?: string;
  /** The coding tool it ran with, as the page names it: "Claude Code". */
  tool?: string;
  /** The machine it runs on, by the key of its `places` entry, and that machine's name. Absent in Tex's cloud. */
  machine?: string;
  machineName?: string;
}

export interface JobStep {
  at: number;
  text: string;
  failed?: boolean;
  why?: string;
}

export interface JobDetail extends JobSummary {
  steps: JobStep[];
  result?: { summary?: string; href?: string; label?: string };
}

export interface Slot {
  slot: number;
  job: JobSummary | null;
  /** The key of the `places` entry it runs in, when the gateway names places. */
  place?: string;
}

export interface Tiles {
  /** `next` is words ("8:00") or, as the gateway sends it, the instant. */
  routines: { on: number; next?: string | number };
  checkins: { next?: string | number };
  about: { count: number; newToday: number };
  computer: { running: boolean; url?: string };
  settings: { summary: string };
}

export interface Behind {
  advisor: { today: number; last?: string };
  mailcheck: { today: number; waiting: number };
}

export interface Overview {
  chats: ChatRef[];
  chat: ChatRef;
  status: { jobs: number; needsYou: number };
  thinking: Turn[];
  thinkingToday: number;
  minions: Slot[];
  earlier: JobSummary[];
  earlierWeek: number;
  tiles: Tiles;
  behind: Behind;
  /** Where the slots run: Tex's cloud, then each of the person's machines. Absent from a gateway without machines. */
  places?: SlotPlace[];
  /** Someone else's machine job waiting for the person's yes. */
  asks?: MachineAsk[];
}

export interface AdvisorAsk {
  id: string;
  at: number;
  job?: string;
  question: string;
  answer: string;
  read: string;
  ms: number;
}

export type Verdict = "sent" | "waiting" | "stopped";

export interface MailCheck {
  id: string;
  at: number;
  to: string;
  subject: string;
  verdict: Verdict;
  why: string;
  from: string;
}

export interface Routine {
  id: string;
  title: string;
  when: string;
  what?: string;
  on: boolean;
  pausedSince?: string;
}

export interface CheckIn {
  id: string;
  when: string;
  what: string;
  done?: boolean;
  result?: string;
  /** When it next runs, where it is set. */
  at?: number;
}

export interface AboutLine {
  line: string;
  text: string;
  source: string;
  at: number;
  isNew?: boolean;
}

export type ListKind = "thinking" | "jobs" | "advisor" | "mailcheck" | "routines" | "checkins" | "about" | "settings";

export interface ListItems {
  thinking: Turn;
  jobs: JobSummary;
  advisor: AdvisorAsk;
  mailcheck: MailCheck;
  routines: Routine;
  checkins: CheckIn;
  about: AboutLine;
  settings: never;
}

/** What a list read answers: its items, and the extras some kinds carry. */
export interface ListPage<K extends ListKind> {
  items: ListItems[K][];
  cursor?: string;
  /** checkins */
  looksAt?: string[];
  quietHours?: string;
  /** Tex's own jobs the person can switch off, on unless off (their own Tex only; Dev2, 2026-11-08). */
  switches?: TexSwitches;
  /** about */
  total?: number;
  /** settings: the person's or the group's own instructions, the quick picks that add a line (Dev2, 2026-11-01), and a group's `answers`. */
  instructions?: string;
  picks?: { id: string; label: string }[];
  values?: Record<string, string | number>;
  number?: string;
  approver?: string;
  people?: string[];
}

/** The daily tidy (`housekeeping`) and the nightly rewrite of About me (`dreams`), each true when on. */
export interface TexSwitches {
  housekeeping: boolean;
  dreams: boolean;
}

export type PageAction =
  | { type: "steer"; job: string; text: string }
  | { type: "stop"; job: string }
  | { type: "report"; job: string; step: number }
  | { type: "routine.toggle"; id: string; on: boolean }
  | { type: "routine.remove"; id: string }
  | { type: "checkin.edit"; id: string; when?: string; what?: string }
  | { type: "checkin.cancel"; id: string }
  | { type: "checkin.add"; when: string; what: string }
  | { type: "switch.set"; name: keyof TexSwitches; on: boolean }
  | { type: "about.fix"; line: string; text: string }
  | { type: "about.remove"; line: string }
  | { type: "settings"; values: Record<string, string | number> }
  | { type: "group.settings"; values: Record<string, string | number> }
  | MachineAction;

/** The page's own views, addressed in the URL so a reload or a back press keeps the place. */
export type SubView =
  | "routines"
  | "checkins"
  | "about"
  | "computer"
  | "settings"
  | "thinking"
  | "jobs"
  | "advisor"
  | "mailcheck"
  | "history"
  | "sees"
  /** The chat's conversations (`conversations/`). */
  | "conversations"
  /** Tex › Your machines; one machine is `machine` with the place's `machine` id; `connect` adds one. */
  | "machines"
  | "machine"
  | "connect";

export const SUB_VIEWS: readonly SubView[] = [
  "routines",
  "checkins",
  "about",
  "computer",
  "settings",
  "thinking",
  "jobs",
  "advisor",
  "mailcheck",
  "history",
  "sees",
  "conversations",
  "machines",
  "machine",
  "connect",
];

/**
 * The chat's history file: its one ledger, as `POST /tex/page/ledger` answers
 * it (`apps/mcp/src/http/texPage/ledger.js`; decided by the owner,
 * 2026-11-02, `docs/decisions/texting-assistant/chat-ledger.md`).
 */
export const LEDGER_KINDS = ["text", "thinking", "said", "tool", "reply", "advisor", "mail_check", "job", "note", "judge", "classify"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

/** One entry as kept: `{v, id, at, kind, seq}` and the kind's own fields, shown raw. */
export interface LedgerEntry {
  id: string;
  at: number;
  kind: string;
  seq?: number;
  [field: string]: unknown;
}

export interface LedgerManifest {
  schema: string;
  version: number;
  count: number;
  created: number | null;
  updated: number | null;
}

/** A `before` past every entry: the newest page. */
export const LATEST = Number.MAX_SAFE_INTEGER;

export interface LedgerQuery {
  kinds?: LedgerKind[];
  /** `YYYY-MM-DD`, in the person's own time zone. */
  day?: string;
  /** The newest entries before this `seq`, newest first (`LATEST` for the newest of all). */
  before?: number;
  /** Only this job's work (its page). */
  job?: string;
  /** `false`: none of any job's work (the Jobs filter off). */
  jobs?: false;
}

export interface LedgerPage {
  manifest: LedgerManifest | null;
  entries: LedgerEntry[];
  /** The `seq` to read older entries before; absent once the oldest is shown. */
  older?: number;
}

/** What the next texted turn is shown of the chat, and the settings that shaped it. */
export interface LedgerSees {
  settings: Record<string, string | number | boolean>;
  text: string;
}

/** Which Tex the page draws: calm #, busy, stuck tugging at its yarn, wild, resting. */
export type Mood = "calm" | "busy" | "stuck" | "wild" | "rest";

/**
 * One of the chat's conversations: a subject the classifier sorted the chat's
 * texts into, as `POST /tex/page/ledger` `{view: "conversations"}` answers it
 * (`apps/mcp/src/http/texPage/conversations.js`;
 * `docs/decisions/texting-assistant/conversation-threads.md`).
 */
export interface Conversation {
  id: string;
  title: string;
  description: string;
  status: "open" | "finished";
  /** When it started, and when a text last joined it (ms). */
  started: number;
  last: number;
  /** How many of the people's texts are in it. */
  texts: number;
}

/** One line of a conversation: a person's text or Tex's answer. */
export interface ConversationLine {
  id: string;
  at: number;
  who: "person" | "tex";
  /** The person's name in a group chat. */
  name?: string;
  text: string;
}

/** One conversation with its lines, oldest first; `more` says older lines are kept. */
export interface ConversationDetail {
  thread: Conversation | null;
  lines: ConversationLine[];
  more: boolean;
}
