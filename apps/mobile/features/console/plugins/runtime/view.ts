/**
 * The shape `useRuntime` hands the plugins pane: `RuntimeView`, the dialogs
 * and settings-pane rows a plugin can open, and `RuntimeActions`. Split out
 * of `../runtime.ts` — see that facade for the file this used to be.
 */

import type { ReactNode } from "react";
import type { LinkPreview, StatusItem } from "../sandboxTypes";
import type { RuntimeState } from "./state";
import type { CommandOutcome, PendingCommand, PluginRegistration, PluginWorkReason } from "./commands";

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
   * The command each plugin is currently waiting on, keyed by plugin id.
   *
   * One per plugin for the same reason `outcomes` is: somebody presses one at a
   * time. Cleared with the frame, so a plugin that was stopped mid-command is
   * not left saying it is still running something.
   */
  pending?: Record<string, PendingCommand>;
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
  /**
   * The suggestion dialog a plugin currently has open, or `null`.
   *
   * One at a time, and held here rather than keyed by plugin: it is a single
   * surface in front of the reader, so a second plugin opening one replaces the
   * first exactly as it does in the guest.
   */
  modal?: OpenModal | null;
  /**
   * The plain dialog a plugin currently has open, or `null`.
   *
   * Separate from `modal` rather than folded into it: one asks the reader to
   * choose and routes an index back, the other only shows them something. One
   * field for both would make every consumer re-derive which kind it had.
   */
  textModal?: OpenTextModal | null;
  /**
   * The last dialog pick that did nothing, and why — or `null`.
   *
   * Not part of `modal`: the dialog is already closed by the time this is
   * known, because the guest closes its own before running the plugin's
   * handler. This is what the console puts in that space instead of the
   * silence the whole path was reported for.
   */
  pickFailure?: { pluginId: string; reason: PluginWorkReason } | null;
  /** The plugin settings pane currently open, or `null`. */
  settingsPane?: OpenSettingsPane | null;
  /** Plugin ids that registered a settings pane, so a row can offer to open it. */
  settingsTabs?: string[];
  /** Absent for anyone the server would refuse, and in the demo. */
  actions?: RuntimeActions;
}

/**
 * The suggestion dialog a running plugin has open, and who opened it.
 *
 * The plugin is named on the dialog because a reader is being asked to choose
 * something by somebody else's code, and "which plugin is this" is the first
 * question that deserves an answer — the same reason a status bar item carries
 * its plugin.
 */
export interface OpenModal {
  pluginId: string;
  /** The exact frame. A restarted plugin is a different one and owns nothing here. */
  nonce: string;
  placeholder: string;
  instructions: { command: string; purpose: string }[];
}

/**
 * A plain dialog a plugin has open: a title, a body, and who is showing it.
 *
 * The text is the guest's `textContent` and nothing else — a plugin cannot put
 * markup, a link, an image or a script in front of a reader, the same boundary
 * the suggestion dialog keeps.
 */
export interface OpenTextModal {
  pluginId: string;
  /** The exact frame, so a dismissal reaches the plugin that opened it. */
  nonce: string;
  title: string;
  text: string;
}

/**
 * One row of a plugin's own settings pane, as the console draws it.
 *
 * A `heading` or a `note` is the plugin's own words — the walk in the sandbox
 * reduces whatever it built to text, so a pane that opens with a sponsor iframe
 * and a tracking image contributes those and nothing else. Everything with an
 * `index` is a control, and the index is what a change is addressed by.
 */
export type PluginSettingRow =
  | { kind: "heading"; level: number; text: string }
  | { kind: "note"; text: string }
  | PluginSettingControl;

/**
 * One control, with its kind spelled out per member.
 *
 * Written as five members rather than one with a union `kind`, and that is not
 * style: a single member whose `kind` is a union does not discriminate, so
 * `Extract<PluginSettingRow, { kind: "dropdown" }>` collapses to `never` and
 * every field read off it is an error. Five members make the union do the work
 * it exists for — and make `options` a fact about dropdowns rather than an
 * empty array on everything else.
 */
export type PluginSettingControl = PluginSettingBase &
  (
    | { kind: "toggle"; value: boolean }
    | { kind: "text"; value: string }
    | { kind: "slider"; value: number }
    | { kind: "button"; value: string }
    | { kind: "dropdown"; value: string; options: { value: string; label: string }[] }
  );

interface PluginSettingBase {
  index: number;
  name: string;
  desc: string;
  label: string;
  placeholder: string;
  disabled: boolean;
}

/**
 * The settings pane a plugin currently has open, and whose it is.
 *
 * `error` is what the plugin's own `display()` threw. It is drawn rather than
 * swallowed: a pane that stopped part-way looks exactly like a plugin with
 * fewer settings, which is the quieter and worse failure.
 */
export interface OpenSettingsPane {
  pluginId: string;
  nonce: string;
  rows: PluginSettingRow[];
  error: string | null;
}

export interface ActiveSandbox {
  bundle: import("../sandboxTypes").PluginRuntimeBundle;
  nonce: string;
  attempts: number;
}

export interface RuntimeActions {
  start: (pluginId: string, bundleFingerprint: string) => Promise<void>;
  /** Close the plain dialog, telling the plugin that opened it. */
  dismissTextModal?: () => void;
  /** Put away the note about a pick that did nothing. Nothing crosses. */
  dismissPickFailure?: () => void;
  /** Ask a running plugin to draw its own settings pane. */
  openSettingsPane?: (pluginId: string) => void;
  /** Work one of its controls. The index names a row in the pane now on screen. */
  changeSetting?: (index: number, value: boolean | string | number) => void;
  closeSettingsPane?: () => void;
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
  /**
   * Ask the running plugins whether any wants to complete this line.
   *
   * Resolves to an empty list when nobody does, when nobody may be asked, or
   * when nobody answers in time — the editor treats all three the same way,
   * which is to carry on.
   *
   * Optional, like `host`: a surface with no editor to complete into — the
   * landing page's demo console — has no suggestions, and absence says that
   * more honestly than a function that always resolves empty.
   */
  askSuggestions?: (line: string, ch: number) => Promise<{ text: string }[]>;
  /** Take the pick; resolves to the rewritten line, or null if nothing answers. */
  applySuggestion?: (index: number) => Promise<string | null>;
  /**
   * Ask the open dialog what to show for what the reader has typed.
   *
   * Resolves empty when nothing is open, when the answer is stale, or when the
   * plugin does not answer in time — the dialog treats all three as "no rows",
   * which is what it can honestly draw.
   */
  askModalSuggestions?: (query: string) => Promise<{ text: string }[]>;
  /**
   * Take the reader's pick. Returns nothing, for `run`'s reason: what the
   * plugin does with it happens in the sandbox, and the dialog closing is
   * reported back through `modal` rather than guessed at here.
   */
  pickModalSuggestion?: (index: number) => void;
  /** Close it without choosing, so the plugin's own onClose still runs. */
  dismissModal?: () => void;
  /**
   * Ask the running plugins to preview these links; resolves to what they gave.
   *
   * One call for the whole note rather than one per link, because that is what
   * a markdown post-processor is: Obsidian hands it a rendered document, not a
   * link at a time, and a plugin that caches per render — YouVersion does —
   * would be defeated by a call per link.
   */
  askPreviews?: (links: LinkPreview[]) => Promise<LinkPreview[]>;
}
