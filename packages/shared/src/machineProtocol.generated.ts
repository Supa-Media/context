/**
 * Generated from machineProtocol.schema.json by
 * packages/shared/scripts/machineProtocolTypes.mjs. Do not edit by hand:
 * change the schema and run the script.
 */

/* eslint-disable */

export const MACHINE_PROTOCOL_VERSION = 1 as const;

/** The protocol version both sides speak. */
export type ProtocolVersion = 1;

/** An opaque identifier minted by the gateway: a machine, job, run or message id. */
export type Id = string;

/** Milliseconds since the Unix epoch. */
export type Timestamp = number;

/** The coding tool a run starts. A slot is compute, not a tool: any slot runs either. */
export type Tool = "claude" | "codex";

/** How much the coding tool may do without asking. edits: edit files in the run's folder and run allowlisted shell commands. read: read only. full: whatever the tool allows, plain Claude Code or Codex as in the person's own terminal; what Tex sends for every run the owner lets in. */
export type PermissionMode = "read" | "edits" | "full";

/** A delivered note-mail line. note: FYI. ask: needs an answer. Interrupts travel as their own message, never as a kind here. */
export type MessageKind = "note" | "ask";

/** Why the runner would not start or continue an assignment. Each names the local rule that held. */
export type RefusalCode = "busy" | "folder" | "tool" | "not_ready" | "memory" | "limit_day" | "limit_week" | "limit_others" | "plan_limit" | "rule" | "unknown_run" | "bad_message";

/** How a run ended. finished: the tool returned its answer. failed: it exited with an error. cancelled: the server cancelled it. limit: a time or usage limit killed it. lost: the runner restarted and could not find the process. */
export type Outcome = "finished" | "failed" | "cancelled" | "limit" | "lost";

export type ToolFact = {
  name: string;
  installed: boolean;
  signedIn: boolean;
  version?: string;
};

/** What the runner reports about its machine, never the contents of anything: the basis of the slot counts and the good-at note. */
export type MachineFacts = {
  os: "macos" | "linux" | "windows";
  osVersion?: string;
  arch: string;
  chip?: string;
  memoryMb: number;
  cores: number;
  gpu?: string;
  hasScreen?: boolean;
  tools: ToolFact[];
  /** Repository names (owner/name or folder name) found in the allowlisted folders. Never paths outside them. */
  repos?: string[];
  /** The coding tools this runner can sign in when the owner asks from the app (`signIn`). */
  signIn?: Tool[];
  /** The coding tools this runner can install when the owner asks from the app (`install`). */
  install?: Tool[];
};

/** Slot counts the runner works out from memory and cores. recommended: for a machine the person also uses. most: for a machine that only runs Tex. Never over 8. */
export type SlotCounts = {
  recommended: number;
  most: number;
};

/** The machine's limits, enforced on the machine as well as in the gateway. */
export type Limits = {
  slots: number;
  /** Agent time per day, summed over runs, in the owner's time zone. */
  dayMs: number;
  weekMs: number;
  /** Agent time other people's asks may use per day, inside dayMs. */
  othersDayMs: number;
  othersRunsPerDay: number;
  /** Longest a machine job may run, end to end: 4 hours by default, at most 24. */
  longestRunMs: number;
  /** Optional weekly token ceiling; absent means off. */
  weekTokens?: number;
  pauseNearPlanLimit: boolean;
  keepOneForOwner?: boolean;
  timeZone?: string;
};

/** The runner's local copy of what the owner allowed. The runner refuses an assignment these do not allow, even one the gateway sent. */
export type Rules = {
  /** Absolute folder paths on the machine a run may start under. Runs never start in a home folder itself. */
  folders: string[];
  tools: Tool[];
  limits: Limits;
  /** Whether the owner's own runs may use the screen. Never for others. */
  computerUse: boolean;
  /** No longer read: every run loads its folder's own .claude settings, as plain Claude Code does. Kept so older gateways' rules frames stay valid. */
  trustedRepos?: string[];
};

/** A grant minted for one job part, scoped to the job's own grant (the group's for a group's job), never carrying send actions. The runner writes it into a 0600 MCP config file, never argv or the environment, and deletes it when the part ends. */
export type RunGrant = {
  token: string;
  expiresAt: Timestamp;
  mcpUrl: string;
};

/** Start, or carry on, one part of a job in a slot. */
export type Assign = {
  type: "assign";
  runId: Id;
  jobId: Id;
  /** Which fifteen-minute part of the job this is, from 1. */
  part: number;
  title?: string;
  tool: Tool;
  /** One of the rules' folders, or the word @work for the runner's own work folder in its app data when the owner chose none. */
  folder: string;
  /** A repo the job names: the tool starts in its checkout under the folder, or in the folder itself, told to clone it, when it is not there. */
  repo?: string;
  permission: PermissionMode;
  /** Words handed to the agent, never a shell line. */
  brief: string;
  doneWhen: string;
  /** The advisor's words for a part after the first, sent as the next message of the same session. */
  advice?: string;
  /** The CLI session id to resume, kept from an earlier part or before a disconnect. */
  resumeSession?: string;
  grant: RunGrant;
  /** When this part must end; the runner kills the run at this time. */
  deadline: Timestamp;
  /** Whether the machine's owner asked for this job. Other people's runs never get computer use or the kept slot. */
  fromOwner: boolean;
  /** Who asked, as shown to the owner (a handle or name). */
  asker?: string;
  /** The chat the job belongs to, as shown to the owner. */
  chat?: string;
  /** Whether the run may reach the network. Off for others' runs unless the owner turned it on for that chat. */
  network: boolean;
  /** Whether the tool may start its own subagents inside the session. */
  helpers: boolean;
  computerUse: boolean;
};

/** A note-mail line for a running run, written into its session as the next user message at its next step boundary. */
export type Deliver = {
  type: "message";
  runId: Id;
  messageId: Id;
  kind: MessageKind;
  from: string;
  text: string;
  /** The app the sender wrote from, for an agent; absent for Tex or a person. */
  app?: string;
  /** The note whose mail block holds this line. */
  path?: string;
  at?: Timestamp;
};

/** A note-mail line for the machine itself, not for one run: mail to a mailbox joined from a session on this machine (a Claude Code or Codex session in a cloud VM). The runner keeps it in its inbox until that session has been shown it. Words for an agent, never a command. */
export type Mail = {
  type: "mail";
  messageId: Id;
  kind: MessageKind;
  from: string;
  /** The mailbox name it was sent to, or everyone. */
  to?: string;
  text: string;
  /** The app the sender wrote from, for an agent; absent for Tex or a person. */
  app?: string;
  /** The note whose mail block holds this line, its record. */
  path: string;
  at: Timestamp;
};

/** Stop the current step now and read this first. Only from Tex or the person, which the gateway checks before sending. */
export type Interrupt = {
  type: "interrupt";
  runId: Id;
  messageId: Id;
  from: string;
  text: string;
  /** The note whose mail block holds this line, when it came from mail. */
  path?: string;
};

/** End a run now. The runner kills the tool, deletes the run grant file, and answers with a result. */
export type Cancel = {
  type: "cancel";
  runId: Id;
  reason: "stopped" | "limit" | "removed" | "disconnected" | "superseded";
};

/** The machine's owner signs a coding tool in from the app. Without a code: start the tool's own sign-in and answer with its link. With one: hand the tool the code its sign-in page showed. The code is never kept, by the runner or the workspace object. */
export type SignIn = {
  type: "signIn";
  signInId: Id;
  tool: Tool;
  code?: string;
};

/** The machine's owner installs a coding tool from the app. The runner downloads the maker's own published build for this computer, checks it against the published checksum and puts it where the runner finds it. Nothing in the frame says what to run or where to download from. */
export type Install = {
  type: "install";
  installId: Id;
  tool: Tool;
};

/** The first frame on every connection. The runner signs it to prove it holds the machine's private key. */
export type Challenge = {
  type: "challenge";
  protocol: ProtocolVersion;
  nonce: string;
};

/** The hello was accepted. Carries the rules the runner enforces locally and the runs the workspace object still holds for it. */
export type Welcome = {
  type: "welcome";
  machineId: Id;
  name?: string;
  rules: Rules;
  /** Runs the runner reported in its hello that the workspace object still wants. Any other run the runner holds it cancels. */
  keepRuns: Id[];
};

/** The owner changed the machine's settings. Takes effect for new assignments at once; a running run keeps the rules it started with unless a cancel follows. */
export type RulesChanged = {
  type: "rules";
  rules: Rules;
};

/** The workspace object is closing the connection and the runner should not reconnect: the machine was disconnected or its grant revoked. */
export type Goodbye = {
  type: "goodbye";
  reason: "revoked" | "replaced" | "bad_signature" | "protocol";
};

/** Every frame the workspace object sends a runner. Nothing here runs a command: assign hands words to an agent the runner starts under its own rules. */
export type ServerMessage = Challenge | Welcome | RulesChanged | Assign | Deliver | Mail | Interrupt | Cancel | SignIn | Install | Goodbye;

/** A run the runner still has after a reconnect, so the job resumes instead of starting over. */
export type HeldRun = {
  runId: Id;
  /** Whether the tool process is still running. */
  alive: boolean;
  session?: string;
  lastStep?: number;
};

/** The runner's answer to the challenge: the machine id, an Ed25519 signature over helloSigningText(machineId, nonce), and what it can do now. */
export type Hello = {
  type: "hello";
  protocol: ProtocolVersion;
  machineId: Id;
  /** Base64url, no padding. */
  signature: string;
  /** The runner's version. */
  runner: string;
  facts: MachineFacts;
  slots: SlotCounts;
  runs: HeldRun[];
};

export type Accept = {
  type: "accept";
  runId: Id;
};

export type Refuse = {
  type: "refuse";
  runId: Id;
  code: RefusalCode;
  /** When the refusal stops holding, where the runner knows (a limit's reset). */
  until?: Timestamp;
};

/** The coding tool's own session id, sent as soon as the tool names it, so a disconnect can resume the same session. */
export type Session = {
  type: "session";
  runId: Id;
  session: string;
};

/** One step the agent took: the tool and its target, never a file's contents. */
export type Step = {
  type: "step";
  runId: Id;
  /** Counts from 1 within the run, so a resend after a reconnect is recognised. */
  seq: number;
  tool: string;
  action?: string;
  target?: string;
  at: Timestamp;
};

/** What the coding tool said or thought during a run, for the chat's history. Shares the run's step count, so a resend after a reconnect is recognised. */
export type Said = {
  type: "said";
  runId: Id;
  seq: number;
  kind: "text" | "thinking";
  text: string;
  at: Timestamp;
};

export type TokenUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

/** What a run has spent so far, and the tool's own plan-limit signal when it gave one. */
export type Usage = {
  type: "usage";
  runId: Id;
  wallMs: number;
  tokens?: TokenUsage;
  /** The tool reported its plan is used up. */
  planLimited?: boolean;
  planResetsAt?: Timestamp;
  /** How much of the plan's current window is used, 0 to 1, when the tool says. */
  planUtilization?: number;
  /** Which plan window the tool reported, such as five_hour or seven_day. */
  planWindow?: string;
};

/** A run ended. The answer is the tool's last message: untrusted words for the advisor and the coordinator. */
export type Result = {
  type: "result";
  runId: Id;
  outcome: Outcome;
  answer?: string;
  session?: string;
  lastStep?: number;
  wallMs: number;
  /** A short reason, never a file's contents or a credential. */
  error?: string;
  /** No longer sent: a run works in the person's own checkout and makes no branch of its own. Kept so older runners' results stay valid. */
  branch?: string;
};

/** The runner's state, sent after the hello and whenever it changes. */
export type Status = {
  type: "status";
  /** False when neither tool is installed and signed in. */
  ready: boolean;
  notReady?: "no_tool" | "signed_out" | "memory" | "paused";
  busy: number;
  freeMemoryMb: number;
  pausedUntil?: Timestamp;
  tools?: ToolFact[];
};

/** Where a sign-in the owner started from the app has got to: `link` carries the tool's sign-in page, `done` and `failed` end it. A fresh status follows an ending. */
export type SignInState = {
  type: "signInState";
  signInId: Id;
  tool: Tool;
  state: "link" | "done" | "failed";
  /** The tool's own sign-in page, on its maker's site. */
  url?: string;
  /** A one-time code the owner types on that page (a device sign-in, such as Codex's). Nothing is pasted back. */
  userCode?: string;
  error?: string;
};

/** Where an install the owner started from the app has got to: `working` with a step and how far, then `done` (with the version) or `failed`. A fresh status follows an ending. */
export type InstallState = {
  type: "installState";
  installId: Id;
  tool: Tool;
  state: "working" | "done" | "failed";
  step?: "finding" | "downloading" | "checking" | "unpacking";
  percent?: number;
  version?: string;
  error?: string;
};

/** Every frame a runner sends. Anything else closes the connection. */
export type RunnerMessage = Hello | Accept | Refuse | Session | Step | Said | Usage | Result | Status | SignInState | InstallState;

/** POST /machines/pair: a runner asks to be paired. The private key never leaves the machine. */
export type PairStart = {
  /** The machine's Ed25519 public key, raw 32 bytes, base64url without padding. */
  publicKey: string;
  name: string;
  facts: MachineFacts;
};

export type PairStarted = {
  pairingId: Id;
  /** Shown on both screens to compare, like KQ7-4MP. */
  code: string;
  approveUrl: string;
  expiresAt: Timestamp;
  pollMs: number;
};

/** POST /machines/pair/poll: signed with the machine's key, so only the machine that asked can collect the grant. */
export type PairPoll = {
  pairingId: Id;
  /** Ed25519 over pairSigningText(pairingId), base64url. */
  signature: string;
};

export type PairStatus = {
  status: "waiting" | "approved" | "declined" | "expired";
  machineId?: Id;
  /** The owning workspace's handle, for display. */
  workspace?: string;
  /** The machine grant, bound to its public key. Returned once. */
  grant?: string;
  socketUrl?: string;
};
