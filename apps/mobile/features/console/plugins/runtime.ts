import type { PluginGrant } from "./grants";
import type { StatusItem, VaultEventMessage } from "./sandboxTypes";
/**
 * Whether a plugin is actually running, and what stopped it if not.
 *
 * Pure and React-free, like the three modules beside it.
 *
 * ## This is the file that earns the word "running"
 *
 * Every screen before it refused to say so, deliberately: an approved grant
 * means *allowed*, never *loaded*, and a console that read one as the other
 * would be telling somebody their plugin works on the strength of a permission
 * they granted. `listRuntimeStates` is the first thing in the product that can
 * answer the question, because it reports what the sandbox host actually did —
 * a bundle loaded, a load that failed three times, or a version Context has
 * stopped.
 *
 * So the rule the earlier modules kept by staying silent, this one keeps by
 * only ever repeating the server: nothing here derives "running" from a grant,
 * from a verdict, or from an install. A plugin with no row is not reported as
 * anything.
 */

/** One row of `obsidianPlugins.listRuntimeStates`, as the control plane returns it. */
export interface RuntimeState {
  pluginId: string;
  bundleFingerprint: string;
  status: "loaded" | "crash-looped" | "blocked";
  attempts: number;
  errorCode?: string;
  errorMessage?: string;
  /** A version Context can go back to, when a blocked one has one. */
  rollbackFingerprint?: string;
  updatedAt: number;
}

/**
 * A command or ribbon action a running plugin registered with the shim.
 *
 * It exists only while the bundle that registered it is loaded. A plugin that
 * stops takes its commands with it, and a list left on screen afterwards would
 * be claiming the console has something it does not.
 */
export interface PluginRegistration {
  kind: "command" | "ribbon";
  id: string;
  name: string;
  /**
   * Whether the command takes an editor — `addCommand({ editorCallback })`.
   *
   * Such a command acts on the note its owner has open and cannot run without
   * one. Obsidian keeps them out of its own palette unless an editor is
   * focused; `editorCommandState` is how this console keeps the same promise.
   *
   * Optional because a guest older than the field reports nothing, and absence
   * has to mean "not editor-scoped" — see the parser.
   */
  needsEditor?: boolean;
}

export interface RuntimeView {
  /** Absent until the owner-only query answers, and for anyone who is not the owner. */
  states?: RuntimeState[];
  loading: boolean;
  /** The trusted, invisible host. Render once at console scope. */
  host?: ReactNode;
  /**
   * What each running plugin registered, keyed by plugin id.
   *
   * Held here rather than on `RuntimeState` because the two have different
   * lifetimes and different authorities: a state row is the control plane's
   * record and survives a reload, while a registration is something the
   * sandbox said in this browser tab and is gone the moment the frame is.
   */
  registrations?: Record<string, PluginRegistration[]>;
  /**
   * How each plugin's last pressed command turned out, keyed by plugin id.
   *
   * One per plugin, not one per command: a person presses one at a time, and
   * keeping every command's last result would put stale outcomes beside
   * controls nobody has touched since. Cleared with the frame, like
   * `registrations`.
   */
  outcomes?: Record<string, CommandOutcome>;
  /**
   * What each running plugin has in its status bar, keyed by plugin id.
   *
   * Held beside `registrations` and with the same lifetime: this is something a
   * frame in this browser tab said, and it goes when the frame does.
   */
  statusItems?: Record<string, StatusItem[]>;
  /**
   * The note the console has open, or `null`.
   *
   * Here because an editor command cannot run without one, and the card has to
   * know that *before* it draws the control rather than after somebody presses
   * it. The path, not the content — this is the console telling its owner about
   * their own open note, not something crossing to a plugin.
   */
  openNote?: string | null;
  /** Absent for anyone the server would refuse, and in the demo. */
  actions?: RuntimeActions;
}

export interface ActiveSandbox {
  bundle: import("./sandboxTypes").PluginRuntimeBundle;
  nonce: string;
  attempts: number;
}

export interface RuntimeActions {
  start: (pluginId: string, bundleFingerprint: string) => Promise<void>;
  stop: (pluginId: string, bundleFingerprint: string) => Promise<void>;
  /**
   * Ask a running plugin to run one of the commands it registered.
   *
   * Returns nothing, and that is the honest shape. The host posts a message
   * into a frame it does not control; the guest may answer `command-result`,
   * or may hang, or may have been torn down between the press and the post. A
   * promise here would have to either resolve on delivery — which says nothing
   * about whether the command ran — or wait for an answer that is not
   * guaranteed to come. The outcome arrives through `outcomes` instead.
   */
  run: (pluginId: string, id: string) => void;
}

/**
 * What came back from the last command this plugin was asked to run.
 *
 * `ok: false` is the plugin failing, not Context: the command threw inside the
 * sandbox and the guest reported it rather than swallowing it. The console says
 * which command, because a plugin with several is otherwise a screen saying
 * something went wrong somewhere.
 */
export interface CommandOutcome {
  id: string;
  ok: boolean;
  error: string | null;
}

/**
 * This plugin's runtime row, or null.
 *
 * Matched on the plugin **and its exact bundle**, for the same reason a grant
 * is. A row left behind by a version that is no longer installed describes code
 * that is no longer there, and rendering it against the new bundle would report
 * a crash that this bundle never had — or, worse, report it loaded.
 */
export function runtimeFor(
  plugin: { id: string; bundleFingerprint: string | null },
  states: RuntimeState[],
): RuntimeState | null {
  if (plugin.bundleFingerprint === null) return null;
  return (
    states.find(
      (row) => row.pluginId === plugin.id && row.bundleFingerprint === plugin.bundleFingerprint,
    ) ?? null
  );
}

/** The chip for a runtime row. */
export function runtimePill(state: RuntimeState): {
  label: string;
  tone: "ok" | "warn" | "crit";
} {
  switch (state.status) {
    case "loaded":
      return { label: "Running", tone: "ok" };
    case "crash-looped":
      return { label: "Stopped itself", tone: "crit" };
    case "blocked":
      return { label: "Turned off", tone: "warn" };
  }
}

/**
 * What happened, in the reader's terms, and always answering the only question
 * they actually have first: whether their notes are all right.
 *
 * They are, and the reason is structural rather than reassuring — a plugin runs
 * in a sandbox with no access it was not granted, so a plugin that cannot start
 * is a plugin that did nothing. That sentence is here rather than in a component
 * because it is the one line that must not be dropped from a failure screen to
 * save space.
 */
export function runtimeNote(state: RuntimeState): string {
  switch (state.status) {
    case "loaded":
      return "Loaded and running in a sandbox of its own, with only what you approved.";
    case "crash-looped":
      return (
        `It failed to load ${countWord(state.attempts)} in a row, so Context stopped retrying rather than looping. ` +
        "Your notes are untouched: a plugin runs with no access it was not granted, so one that cannot start did nothing."
      );
    case "blocked":
      return (
        "Context turned this version off. Your notes are untouched, and the audit trail lists every write it made " +
        "before it stopped."
      );
  }
}

function countWord(attempts: number): string {
  if (attempts === 1) return "once";
  if (attempts === 2) return "twice";
  return `${attempts} times`;
}

/**
 * The version to go back to, when a blocked one names one.
 *
 * Null rather than a disabled control everywhere else, because "roll back" with
 * nothing to roll back to is a button whose precondition the reader cannot
 * satisfy — the same argument that keeps `unknown` from having an install path.
 */
export function rollbackTarget(state: RuntimeState): string | null {
  return state.status === "blocked" && state.rollbackFingerprint
    ? state.rollbackFingerprint
    : null;
}

/**
 * The server's own error, when it left one.
 *
 * `errorMessage` is written for this reader — "Plugin access was revoked" is
 * more use than anything this module could compose from a code — and the code
 * is shown beside it only when there is no message, so a bare
 * `GRANT_REVOKED` never appears as the whole explanation.
 */
export function runtimeDetail(state: RuntimeState): string | null {
  const message = state.errorMessage?.trim();
  if (message) return message;
  const code = state.errorCode?.trim();
  return code ? `The runtime reported ${code}, with no further detail.` : null;
}

/**
 * What a running plugin added to Context, in a sentence.
 *
 * Null when it added nothing — most plugins register nothing at all, and "adds
 * 0 commands" on every row is noise that makes the rows that *do* add something
 * harder to spot.
 *
 * Deliberately a count and a list of names rather than a row of buttons, and
 * the reason is narrower than it first looks. The *guest* can already run a
 * command: `sandbox.js` keeps a `commands` Map and handles an inbound
 * `{ type: "command", id }` by invoking it and answering `command-result`.
 * What is missing is the **host** half — neither `PluginSandbox` posts that
 * message nor does `sandboxTypes.ts` know the reply — so the button would have
 * nothing behind it today, which is the failure this section has refused in
 * four other places. Wiring the host half is frontend work and needs nobody's
 * permission; until it is done, these are names.
 */
export function describeRegistrations(list: PluginRegistration[]): string | null {
  if (list.length === 0) return null;
  const commands = list.filter((one) => one.kind === "command").length;
  const ribbon = list.filter((one) => one.kind === "ribbon").length;
  const parts: string[] = [];
  if (commands > 0) parts.push(plural(commands, "command", "commands"));
  if (ribbon > 0) parts.push(plural(ribbon, "ribbon action", "ribbon actions"));
  return `Registered ${parts.join(" and ")}.`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The registrations to show for one plugin, and only while it is running.
 *
 * A stopped, crashed or blocked plugin reports none, whatever is still sitting
 * in the map — the map is keyed by plugin and a frame can leave without
 * clearing it, so the status is what decides, not the leftovers.
 */
export function registrationsFor(
  state: RuntimeState,
  registrations: Record<string, PluginRegistration[]> | undefined,
): PluginRegistration[] {
  if (state.status !== "loaded") return [];
  return registrations?.[state.pluginId] ?? [];
}

/**
 * A plugin's status bar items, and only while it is running.
 *
 * The same rule `registrationsFor` keeps, and the reason is stronger here. A
 * registration left behind claims the console has a command it does not; a
 * status bar item left behind is a *reading* — "412 words", "syncing", "3 tasks
 * due" — and nothing has produced it since the frame went. Stale is the
 * generous word for it.
 */
export function statusItemsFor(
  state: RuntimeState,
  statusItems: Record<string, StatusItem[]> | undefined,
): StatusItem[] {
  if (state.status !== "loaded") return [];
  return statusItems?.[state.pluginId] ?? [];
}

/**
 * Said beside a plugin's status bar, every time one is drawn.
 *
 * The first third-party text the console displays. Everywhere else in this
 * section the words are Context's and the discipline was to claim nothing the
 * server had not said; here the words are the plugin's, and the equivalent
 * discipline is to say so. A reader who takes "412 words" for something Context
 * measured has been misled by the frame it was put in rather than by the text.
 *
 * It is also why the element itself never crosses. The console draws this with
 * its own components in its own theme, so a plugin cannot style, size or
 * position anything outside its sandbox — the same boundary the view conditions
 * draw, reached from the other side.
 */
export const STATUS_BAR_NOTE = "The plugin's own status bar, updated while it runs.";

/**
 * Why the names are listed and nothing is pressable **here**.
 *
 * Now shown only where there are no controls at all — the landing page's demo
 * console, which has no bucket, no frame and nothing to press. In the live
 * console a registered command is a button.
 *
 * It is kept rather than deleted because the alternative is a reader of the
 * demo wondering why a command they can see does nothing, and because the
 * section's rule is that no row ends on its refusal: this is that row's
 * closing line.
 */
export const REGISTRATION_NOTE =
  "This preview only lists what a plugin adds. In your own console these run.";

/**
 * The last command's outcome, paired with the name it was pressed under.
 *
 * Null when the plugin has no outcome, and — the part worth a function —
 * **also null when the outcome names a command the plugin no longer lists**. A
 * bundle can register different commands across two loads, and a result left
 * over from the previous one would attach a failure to whichever command
 * happens to sit in that position now, or to an id with no name at all.
 *
 * Returning the name rather than the id is the other half: `toggle` means
 * nothing to a reader, and a plugin with several commands otherwise gets a
 * screen saying something went wrong somewhere.
 */
export function commandOutcomeFor(
  registered: PluginRegistration[],
  outcome: CommandOutcome | undefined,
): { name: string; ok: boolean; error: string | null } | null {
  if (outcome === undefined) return null;
  const match = registered.find((one) => one.id === outcome.id);
  if (match === undefined) return null;
  return { name: match.name, ok: outcome.ok, error: outcome.error };
}

/**
 * Said beside an editor command that cannot run yet.
 *
 * The precondition, before the press rather than after it. The guest does
 * refuse the call — `sandbox.js` throws "Open a note before running this
 * command" — but a refusal that arrives only once somebody has pressed a
 * control teaches them the product is broken. Obsidian solves the same problem
 * by keeping these out of its palette entirely; this keeps the name visible, so
 * a reader can see the plugin has the command, and says what it is waiting for.
 */
export const EDITOR_COMMAND_HINT =
  "Open a note first — this command edits the note you have open.";

/**
 * How one registration should be drawn, given the note the console has open.
 *
 * ## Why an editor command is different from every other control here
 *
 * `addCommand({ editorCallback })` is Obsidian's way of saying "this acts on
 * the open editor". YouVersion Linker's `Generate links` is one: it rewrites
 * Bible references in the note you are looking at, in place. Two things follow,
 * and the card was getting both wrong.
 *
 * **It cannot run with nothing open.** Obsidian does not offer these in its
 * palette unless an editor is focused. Context drew the button always, and the
 * guest threw after the press.
 *
 * **It does not say what it changes.** "Generate links" reads like it produces
 * something somewhere; it edits one specific file. So the label names it — the
 * basename, because a button is not the place for a long path, and a person
 * looking at this already has the full path in the file browser beside it.
 */
export function editorCommandState(
  registration: PluginRegistration,
  openNote: string | null | undefined,
): { runnable: boolean; label: string; hint: string | null } {
  const prefix = registration.kind === "ribbon" ? "Ribbon" : "Command";
  const base = `${prefix} · ${registration.name}`;
  if (registration.needsEditor !== true) {
    return { runnable: true, label: base, hint: null };
  }
  const path = typeof openNote === "string" && openNote.trim() !== "" ? openNote : null;
  if (path === null) return { runnable: false, label: base, hint: EDITOR_COMMAND_HINT };
  return { runnable: true, label: `${base} → ${basenameOf(path)}`, hint: null };
}

function basenameOf(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

/**
 * A command the owner pressed, before it is routed to a frame.
 *
 * Carries the plugin as well as the command, which `InvokeMessage` does not:
 * by the time it reaches one sandbox the plugin is implied by which sandbox it
 * reached, and including it there would be a field the guest could read and
 * nothing would check.
 */
export interface InvokeRequest {
  seq: number;
  pluginId: string;
  /** The frame this was aimed at. A replacement frame has a different one. */
  nonce: string;
  id: string;
}

/**
 * The command to hand this frame, or nothing.
 *
 * **Routing, and the security-relevant half of invoke.** `active-file` and
 * `vault-event` are broadcast to every guest allowed to see paths; a command is
 * the opposite and must reach exactly the plugin whose control was pressed.
 * Delivering it to the others would run whatever *they* registered under the
 * same id — and `toggle`, `refresh` or `open` are ids two unrelated plugins
 * pick without either being at fault.
 *
 * **Addressed to a frame, not to a plugin**, which is the half a self-review of
 * the first draft found missing. A press sets one slot, and each sandbox posts
 * it from an effect that waits for `loaded`. A restart mounts a *new* sandbox,
 * so `loaded` goes false to true again — with the previous press still in the
 * slot — and the replacement would run a command nobody pressed. The guest's
 * ignore-an-unknown-id rule does not save that: a restarted plugin registers
 * the same ids it registered before, so the id resolves and the command runs.
 * Matching the nonce makes the replacement unreachable by an instruction aimed
 * at its predecessor.
 *
 * The asymmetry with `active-file` and `vault-event` is the point rather than
 * an inconsistency. Those are **state**, and a freshly loaded plugin should be
 * told which note is open. A command is an **instruction**, and one aimed at a
 * frame that is gone is not owed to its successor.
 *
 * No grant is consulted, deliberately: the plugin is running, which already
 * required an active grant and a deliberate Start, and whatever the command
 * then does crosses the RPC boundary and is authorized there. Pressing it
 * grants nothing new.
 */
export function invokeFor(
  sandbox: { bundle: { pluginId: string }; nonce: string },
  request: InvokeRequest | undefined,
): { seq: number; id: string } | undefined {
  if (request === undefined) return undefined;
  if (request.pluginId !== sandbox.bundle.pluginId) return undefined;
  if (request.nonce !== sandbox.nonce) return undefined;
  return { seq: request.seq, id: request.id };
}

/**
 * A revoked grant is the one "blocked" that is not a fault.
 *
 * `revokePlugin` marks the runtime row blocked with `GRANT_REVOKED`, so this
 * state is the ordinary, healthy consequence of somebody pressing Revoke. It
 * must not read as a malfunction, and it must not offer a rollback — there is
 * nothing wrong with the version.
 */
export function isRevocation(state: RuntimeState): boolean {
  return state.status === "blocked" && state.errorCode === "GRANT_REVOKED";
}

export function isOwnerStop(state: RuntimeState): boolean {
  return state.status === "blocked" && state.errorCode === "OWNER_DISABLED";
}

export const REVOKED_NOTE =
  "You revoked its access, so Context stopped it. Approve it again whenever you want it back.";
import type { ReactNode } from "react";

/* -------------------------------------------------------------------------- */
/*                    a plugin's own write, as an event                       */
/* -------------------------------------------------------------------------- */

/**
 * Turn one successful plugin RPC into the change the other plugins are told
 * about, or `null` when it was not a change.
 *
 * Pure, and here rather than in `useRuntime`, because the decision is the part
 * worth pinning: which operations count, what path each reports, and what it
 * does with anything it does not recognise.
 *
 * **The writer's own guest is told too.** Obsidian dispatches vault events to
 * every handler including the one whose write caused them, and a shim that
 * filtered the author out would be a difference nobody could debug from inside
 * a plugin.
 *
 * Silence on anything unrecognised is the load-bearing half. An unknown write
 * reported as a `modify` with no version is worse than one not reported at all,
 * because a plugin acts on it — and a future operation kind would arrive here
 * as exactly that.
 */
export function vaultEventForOperation(
  operation: { kind?: unknown; path?: unknown; from?: unknown; to?: unknown } | undefined,
  response: unknown,
): Omit<VaultEventMessage, "seq"> | null {
  if (!operation || typeof operation.kind !== "string") return null;
  if ((response as { ok?: unknown } | null)?.ok !== true) return null;
  const etag = (response as { result?: { etag?: unknown } }).result?.etag;
  const version = typeof etag === "string" ? etag : null;
  const path = typeof operation.path === "string" ? operation.path : null;
  switch (operation.kind) {
    case "vault.create":
      return path === null ? null : { kind: "create", path, etag: version };
    case "vault.modify":
      return path === null ? null : { kind: "modify", path, etag: version };
    case "vault.delete":
      // No version: there is nothing left to hold one, and a path with a stale
      // etag beside it is an invitation to write over what replaced it.
      return path === null ? null : { kind: "delete", path, etag: null };
    case "vault.rename": {
      // Obsidian hands a rename handler the file at its *new* path and the old
      // path beside it, so `to` is the event's path and `from` is the extra.
      const to = typeof operation.to === "string" ? operation.to : null;
      if (to === null) return null;
      const from = typeof operation.from === "string" ? operation.from : undefined;
      return { kind: "rename", path: to, from, etag: version };
    }
    default:
      return null;
  }
}

export interface AppliedPluginNoteWrite {
  path: string;
  text: string;
  expectedEtag: string;
  etag: string;
}

/**
 * The exact successful note replacement the trusted host just performed.
 *
 * This is deliberately narrower than a vault event: only `vault.modify` has
 * both the complete new body and an old version that lets the open editor
 * prove it is still looking at the version the plugin replaced.  The values
 * come from the request the host sent to Convex and the response Convex
 * returned; nothing new is accepted from a guest after authorization.
 */
export function appliedPluginNoteWrite(
  operation: {
    kind?: unknown;
    path?: unknown;
    text?: unknown;
    expectedEtag?: unknown;
  } | undefined,
  response: unknown,
): AppliedPluginNoteWrite | null {
  if (operation?.kind !== "vault.modify") return null;
  if (typeof operation.path !== "string" || typeof operation.text !== "string") return null;
  if (typeof operation.expectedEtag !== "string") return null;
  if ((response as { ok?: unknown } | null)?.ok !== true) return null;
  const etag = (response as { result?: { etag?: unknown } }).result?.etag;
  if (typeof etag !== "string") return null;
  return {
    path: operation.path,
    text: operation.text,
    expectedEtag: operation.expectedEtag,
    etag,
  };
}

/**
 * One suggestion query, before it is routed to a frame.
 *
 * Carries the plugin and the frame for the same reason `InvokeRequest` does: by
 * the time it reaches a sandbox the plugin is implied, and a field the guest
 * could read that nothing checks is worse than no field.
 */
export interface SuggestRequest {
  seq: number;
  pluginId: string;
  /** The frame this was aimed at. A replacement frame has a different one. */
  nonce: string;
  /** The line the cursor is on, up to and including it. Note content. */
  line: string;
  /** Where the cursor sits in that line. */
  ch: number;
}

/**
 * The query to hand this frame, or nothing.
 *
 * The rule #533 established for commands, applied to the other instruction in
 * this protocol. A restart mounts a new frame, and a query aimed at the frame
 * before it is not owed to its successor — a suggester answering it would be
 * completing against a line the person has since left.
 */
export function suggestFor(
  sandbox: { bundle: { pluginId: string }; nonce: string },
  request: SuggestRequest | undefined,
): { seq: number; line: string; ch: number } | undefined {
  if (request === undefined) return undefined;
  if (request.pluginId !== sandbox.bundle.pluginId) return undefined;
  if (request.nonce !== sandbox.nonce) return undefined;
  return { seq: request.seq, line: request.line, ch: request.ch };
}

/**
 * The suggestions to show, or null when the answer is stale.
 *
 * **Typing outruns a round trip.** A menu built from an answer to a line the
 * cursor has already left is worse than no menu: it offers completions for text
 * that is no longer there, and somebody accepts one into the text that is. The
 * sequence the host asked with is the only thing that can tell those apart, so
 * it is required on the wire and compared here.
 */
export function freshSuggestions(
  answer: { seq: number; items: { text: string }[] },
  asked: number | null,
): { text: string }[] | null {
  if (asked === null) return null;
  return answer.seq === asked ? answer.items : null;
}

/**
 * Which loaded plugins may be shown a line of somebody's note.
 *
 * ## Why this is not `maySeePaths`
 *
 * A suggestion query carries **content** — the line somebody is in the middle
 * of typing. Every other piece of state this host pushes to a guest carries a
 * *path*, and `maySeePaths` opens on `vault:read` **or** `metadata:read`
 * because a path is metadata-shaped.
 *
 * A line of prose is not metadata. A plugin granted `metadata:read` was
 * approved to see frontmatter, headings, tags and the links between notes; it
 * was not approved to read the sentence being written. So this is `vault:read`
 * alone, and it is a separate function rather than a parameter on the other one
 * — two gates that answer different questions drift into each other the moment
 * they share a name.
 *
 * The guest cannot enforce this: it is handed the line before it runs any
 * plugin code. The decision has to be made here, before the message is sent.
 */
export function maySeeContent(
  sandbox: { pluginId: string; bundleFingerprint: string },
  grants: readonly PluginGrant[] | undefined,
): boolean {
  if (grants === undefined) return false;
  const grant = grants.find(
    (one) =>
      one.pluginId === sandbox.pluginId &&
      one.bundleFingerprint === sandbox.bundleFingerprint &&
      one.status === "active",
  );
  if (grant === undefined) return false;
  return grant.capabilities.includes("vault:read");
}

/**
 * Which loaded plugins may be told the path of a note.
 *
 * **Found reviewing the diff that introduced the active file.** The host was
 * handing `active-file` and every `vault-event` to every loaded guest alike —
 * including one approved for nothing but its own settings. A plugin with no
 * vault grant cannot read a single note, and was nonetheless being told, live,
 * the path of whatever its owner had open and the path of everything they
 * edited. That is a read the consent screen never offered and the RPC would
 * refuse.
 *
 * A path is note data. So this is the same rule the RPC enforces, applied to the
 * state the host pushes rather than the state a plugin asks for: `vault:read` or
 * `metadata:read`, or nothing crosses.
 *
 * Keyed on the fingerprint as well as the id, like `runtimeFor`: a grant for a
 * bundle that is no longer the one running is not this plugin's grant.
 */
export function maySeePaths(
  sandbox: { pluginId: string; bundleFingerprint: string },
  grants: readonly PluginGrant[] | undefined,
): boolean {
  if (grants === undefined) return false;
  const grant = grants.find(
    (one) =>
      one.pluginId === sandbox.pluginId &&
      one.bundleFingerprint === sandbox.bundleFingerprint &&
      one.status === "active",
  );
  if (grant === undefined) return false;
  return grant.capabilities.includes("vault:read") || grant.capabilities.includes("metadata:read");
}
