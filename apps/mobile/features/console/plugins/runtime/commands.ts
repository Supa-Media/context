/**
 * A plugin's registrations, its status bar items and the commands the owner
 * can press — what shows up, what it is called, and how invoking one is
 * routed to the exact frame that registered it. Split out of
 * `../runtime.ts` — see that facade for the file this used to be.
 */

import type { StatusItem } from "../sandboxTypes";
import type { RuntimeState } from "./state";

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

/**
 * How long the editor waits for a plugin to answer before carrying on.
 *
 * #533 shipped a command with no timeout and named the gap: *"a pending state
 * that can hang for ever is worse than none"*. In a completion menu that state
 * is entered on a keystroke, so the clock is not optional here. Short enough
 * that a wedged guest is indistinguishable from no suggester, long enough for a
 * guest that has to reach the network through the broker.
 */
export const SUGGEST_TIMEOUT_MS = 1200;

/**
 * Why a piece of a plugin's work did not land, and the sentence for it.
 *
 * The guest names which of three cases it is and the console writes the words:
 * a sentence carried up from a sandbox would be a plugin composing Context's
 * error message, often *about that plugin's own* missing grant. The set is
 * closed in `@context/obsidian-runtime`, so the worst a lying guest achieves is
 * the wrong one of three.
 *
 * Shared by the two surfaces that have to say it — a command's outcome on the
 * plugins pane and a dialog pick in front of the reader — because one of them
 * wording it differently would make the same refusal read as two problems.
 */
export type PluginWorkReason = "no-note" | "not-allowed" | "failed";

export function pluginWorkNote(reason: PluginWorkReason): string {
  if (reason === "no-note") {
    return "It asked for the note you have open, and nothing was open. Open a note and try again.";
  }
  if (reason === "not-allowed") {
    return "It is not allowed to change your notes. Turn on “Create and change notes” with Change what it can do.";
  }
  return "The change it made could not be saved. Your note is as it was.";
}

/**
 * What came back from the last command this plugin was asked to run.
 *
 * `ok: false` with an `error` is the plugin failing, not Context: the command
 * threw inside the sandbox and the guest reported it rather than swallowing it.
 * `ok: false` with a `reason` is the other way round — it ran, and asked for
 * something Context could not give it. The console says which command either
 * way, because a plugin with several is otherwise a screen saying something
 * went wrong somewhere.
 */
export interface CommandOutcome {
  id: string;
  ok: boolean;
  error: string | null;
  /**
   * Why it did nothing, when the why is Context's to say rather than the
   * plugin's — see `PluginWorkReason`.
   *
   * Absent means the ordinary case: it ran, or it threw and `error` carries
   * what it threw.
   */
  reason?: PluginWorkReason | null;
  /**
   * Nothing answered, as opposed to the plugin answering that it failed.
   *
   * The guest reports `command-result` either way, and `ok: false` is the
   * plugin failing *inside* the sandbox and saying so — which the card quotes.
   * A silence is not that: there is no message to quote, and saying "the plugin
   * reported" about one would put words in its mouth and send a reader to the
   * wrong place to look.
   *
   * Absent means false, the rule `needsEditor` follows and for the same reason:
   * a row written before this field existed was an ordinary failure.
   */
  timedOut?: boolean;
}

/**
 * A command the console has sent and not yet heard back about.
 *
 * Held beside `outcomes` rather than inside it because they are different
 * facts with different lifetimes — one is "still waiting", the other is "here
 * is how it went" — and a single nullable field would make the card's two
 * branches read as one.
 */
export interface PendingCommand {
  id: string;
  /** The press this belongs to, so a late answer cannot clear a newer one. */
  seq: number;
}

/**
 * How long the console waits for a command before saying nothing answered.
 *
 * Far longer than `SUGGEST_TIMEOUT_MS` (1.2s) and `PREVIEW_TIMEOUT_MS` (8s),
 * and the asymmetry is the argument rather than an oversight. Those two are
 * entered on a keystroke with somebody waiting mid-word, so a wedged guest has
 * to be indistinguishable from no plugin almost immediately. A command is a
 * deliberate press whose work may be a network round trip per verse through the
 * broker — giving up early would report a working plugin as wedged, which is
 * worse than the silence this replaces.
 *
 * #533 named this gap in its own log entry and shipped without it: *"a command
 * that is slow or never answers shows nothing between the press and the result.
 * The honest version needs a timeout this change lacks."*
 */
export const COMMAND_TIMEOUT_MS = 30000;

/**
 * The command in flight for this plugin, named, or `null`.
 *
 * Resolved against what the **running frame** registered, exactly as
 * `commandOutcomeFor` is: a press survives a restart in the host's map, and the
 * replacement frame may register a different set. Naming an id this frame does
 * not have would put a command on the card that is not there to press.
 */
export function commandPendingFor(
  registered: PluginRegistration[],
  pending: PendingCommand | undefined,
): { name: string } | null {
  if (pending === undefined) return null;
  const match = registered.find((one) => one.id === pending.id);
  return match === undefined ? null : { name: match.name };
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
): {
  name: string;
  ok: boolean;
  error: string | null;
  timedOut: boolean;
  reason: PluginWorkReason | null;
} | null {
  if (outcome === undefined) return null;
  const match = registered.find((one) => one.id === outcome.id);
  if (match === undefined) return null;
  return {
    name: match.name,
    ok: outcome.ok,
    error: outcome.error,
    timedOut: outcome.timedOut === true,
    reason: outcome.reason ?? null,
  };
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
