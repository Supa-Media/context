/**
 * The person's own machines on the Tex page: computers that run Tex's coding
 * jobs with that person's own Claude Code and Codex (design: project files
 * `tex-machines-artboards/design-spec.md`, approved by the owner 2026-11-04).
 *
 * The gateway answers these from the workspace object that owns each machine
 * (`/tex/page/machines`, see `texMachineRead.ts`). Every field is read
 * defensively: a gateway that does not know machines yet answers nothing, and
 * the page then draws no machine screens and no link to them.
 */

/** `mac`: the Context Mac app carries the runner. `cli`: the runner started by `npx @supa-media/context machine`. */
export type MachineKind = "mac" | "cli";

/**
 * - `online`: connected and able to take a job.
 * - `offline`: not connected (asleep, closed, no network).
 * - `paused`: connected, but its daily limit or the person's plan limit is reached.
 * - `notReady`: connected, but neither Claude Code nor Codex is signed in.
 * - `pending`: a device code is waiting for the person's yes.
 */
export type MachineState = "online" | "offline" | "paused" | "notReady" | "pending";

/** `signedIn` is usable; `installed` needs a sign-in; `missing` is not on the machine; `off` is signed in and switched off here. */
export type ToolState = "signedIn" | "installed" | "missing" | "off";

export type ToolName = "claude" | "codex";

/**
 * A sign-in its owner started from the page (`/machines/app/sign-in`): `starting` while the computer gets the tool's
 * link, `link` while it waits for the code that link's page shows, `checking` once the code is on its way.
 */
export interface MachineSignIn {
  id: string;
  tool: ToolName;
  state: "starting" | "link" | "checking" | "done" | "failed";
  /** The tool maker's own sign-in page; only its own owner is sent it. */
  url?: string;
  error?: string;
  at: number;
}

/** Who besides the owner may send a machine work in one chat: nobody, everyone there, or the people named. */
export type MachineWho = "me" | "everyone" | string[];

/** One chat a machine serves, with how it serves it. */
export interface MachineChat {
  /** "me" for the owner's own chat, else the group's key. */
  key: string;
  name: string;
  who: MachineWho;
  /** The owner says yes before someone else's job starts. */
  askFirst: boolean;
  /** How many of the machine's slots this chat may use at once. */
  slots: number;
}

export interface MachineRun {
  job: string;
  title: string;
  /** In a group: who asked for it. Absent for the owner's own ask. */
  for?: string;
  startedAt: number;
}

export interface Machine {
  id: string;
  name: string;
  kind: MachineKind;
  /** "macOS", "Linux". */
  os: string;
  state: MachineState;
  /** Why it is paused. */
  paused?: "limit" | "plan";
  /** When it went offline, connected, or asked to connect. */
  since?: number;
  connectedAt?: number;
  /** Jobs at once, as the owner set it. */
  slots: number;
  /** What its CPU and memory suggest for shared use, and the most if it only runs Tex. */
  recommended: number;
  most: number;
  running: MachineRun[];
  /** When its last job finished, for "Nothing. The last job finished at 1:52 PM". */
  lastEndedAt?: number;
  /** Minutes used today, and the daily limit in minutes (plus today's one-day raise). */
  usedMin: number;
  limitMin: number;
  raisedMin?: number;
  /** Jobs others may start on it in a day, across every chat. */
  othersPerDay: number;
  pauseNearPlan: boolean;
  tools: Record<ToolName, ToolState>;
  /** Folders its jobs may work in, as the machine names them (`~/code/context`). */
  folders: string[];
  /** Only a Mac app machine can offer computer use; always the owner's own asks only. */
  computerUse: boolean;
  chats: MachineChat[];
  /** The pairing code, while `pending`. */
  code?: string;
  /** The tools its runner can sign in from the page. */
  canSignIn?: ToolName[];
  signIn?: MachineSignIn;
}

/** A device code waiting for the person's yes (screen 3b). */
export interface Pairing {
  code: string;
  name: string;
  os: string;
  tools: ToolName[];
  at: number;
}

export interface MachinesPage {
  machines: Machine[];
  cloud: { slots: number; busy: number };
  /** The newest code waiting for a yes, or null. */
  pairing: Pairing | null;
  /** In a group chat: its other people by handle (`@bo`), whom a machine's rule there may name. */
  chatPeople?: string[];
}

/** Someone else's job waiting for the owner's yes (screen 5), on the owner's page. */
export interface MachineAsk {
  job: string;
  who: string;
  title: string;
  machine: string;
  /** The machine's own name, "MacBook Pro" in "on your MacBook Pro". */
  machineName: string;
  tool: ToolName;
  folder?: string;
  /** "uses 1 of the 2 slots for this chat". */
  slotsFor: number;
  at: number;
}

/** Where the slots on the Tex home run (screen 6): Tex's cloud and each machine, in order. */
export interface SlotPlace {
  key: string;
  kind: "cloud" | "machine";
  /** A machine's kind, so its card can show the right glyph. Absent for Tex's cloud. */
  machineKind?: MachineKind;
  name: string;
  slots: number;
  offline?: boolean;
  since?: number;
}

/** What may change on a machine from the page. */
export interface MachineValues {
  slots?: number;
  claude?: boolean;
  codex?: boolean;
  computerUse?: boolean;
  limitMin?: number;
  othersPerDay?: number;
  pauseNearPlan?: boolean;
  folders?: string[];
}

export interface MachineChatValues {
  who?: MachineWho;
  askFirst?: boolean;
  slots?: number;
}

export type MachineAction =
  | { type: "machine.set"; id: string; values: MachineValues }
  | { type: "machine.disconnect"; id: string }
  | { type: "machine.pair"; code: string; approve: boolean }
  | { type: "machine.chat"; id: string; chat: string; values: MachineChatValues }
  | { type: "machine.chat.add"; id: string; chat: string }
  | { type: "machine.chat.remove"; id: string; chat: string }
  | { type: "machine.raise"; id: string; minutes: number }
  | { type: "machine.signIn"; id: string; tool: ToolName }
  | { type: "machine.signInCode"; id: string; signInId: string; code: string }
  | { type: "job.allow"; job: string; mode: "once" | "always" | "decline" };
