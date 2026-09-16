import type { PluginSettingRow } from "./runtime";

export interface PluginRuntimeBundle {
  pluginId: string;
  version: string;
  bundleFingerprint: string;
  manifestJson: string;
  mainJs: string;
  stylesCss: string | null;
  runtimeToken: string;
  expiresAt: number;
}

export type SandboxEvent =
  | { type: "loaded" | "unloaded" }
  | { type: "rpc"; request: object; respond: (response: unknown) => void }
  | { type: "crashed"; code: string; message: string }
  /**
   * The frame stopped being the document we wrote — see `sandboxFrameIsOurs`.
   *
   * Deliberately **not** a `crashed`: that path reloads the bundle up to three
   * times, and a bundle that navigates away would simply do it again on each
   * attempt. This one ends the plugin.
   */
  | { type: "disowned" }
  | { type: "notice"; message: string }
  | {
      type: "registration";
      kind: "command" | "ribbon";
      id: string;
      name: string;
      /** Whether it takes an editor, and so needs a note open to run at all. */
      needsEditor: boolean;
    }
  /**
   * How a command the host asked for turned out.
   *
   * `ok: false` is the plugin's failure, not the sandbox's — the guest answers
   * either way, because a host that never hears back cannot tell a command that
   * broke from one still running.
   */
  | { type: "command-result"; id: string; ok: boolean; error: string | null }
  /**
   * Everything the plugin currently has in its status bar.
   *
   * The whole list every time, so the console replaces rather than reconciles —
   * there is no removal message that could be lost, and a guest torn down
   * mid-render cannot leave a reading on the screen that nothing is producing
   * any more.
   */
  | { type: "status-bar"; items: StatusItem[] }
  /**
   * What the plugin offered for the line the host asked about.
   *
   * Text only — the plugin rendered each suggestion into an element inside its
   * own sandbox and the guest reported what that element says. `seq` comes back
   * unchanged so an answer for a line the cursor has left can be dropped.
   */
  | { type: "suggest-results"; seq: number; items: { text: string }[] }
  /*
    A plugin asked for its suggestion dialog to be opened, or closed.

    The console draws the dialog; the guest never has one. See the classes in
    `sandbox.js` for why that inversion exists and why they are exported at all
    rather than left absent.
  */
  | {
      type: "suggest-modal";
      open: boolean;
      placeholder: string;
      instructions: { command: string; purpose: string }[];
    }
  /**
   * A plain dialog the plugin filled in, or closed.
   *
   * No query and no pick — a `Modal` shows something rather than asking. The
   * text arrives again whenever the plugin changes it, because a plugin may
   * fill it after an await and the one this was built for does.
   */
  | { type: "text-modal"; open: boolean; title: string; text: string }
  /** This plugin registered a settings pane. One bit; it only turns a control on. */
  | { type: "settings-tab" }
  /**
   * The pane, as rows to draw.
   *
   * Sent again whenever the plugin redraws it — which the pane this was built
   * against does from its own event bus, after a toggle. `error` is what
   * `display()` threw, so a pane that stopped part-way says so instead of
   * looking like a plugin with fewer settings.
   */
  | { type: "settings-pane"; open: boolean; rows: PluginSettingRow[]; error: string | null }
  | { type: "suggest-modal-results"; seq: number; items: { text: string }[] }
  /*
    `reopened` says whether the plugin opened another dialog while handling the
    pick — a two-step flow picks a translation and then a verse, and a console
    that closed unconditionally would shut the one it just asked for.
  */
  | { type: "suggest-modal-picked"; seq: number; reopened: boolean }
  /**
   * The line the plugin's own `selectSuggestion` produced.
   *
   * The trusted editor makes this edit through its own editing path, which is
   * why a suggester needs no write grant: it is the person typing.
   */
  | { type: "suggest-applied"; seq: number; line: string }
  /**
   * What the plugin's markdown post-processor attached to each link.
   *
   * Text keyed to an href, and nothing else. The processor ran against a
   * document the *guest* built from the links the host named, inside the
   * sandbox, and what crosses is what it left on each anchor — never the
   * element, never its markup, never a handler.
   *
   * A link the plugin ignored is simply absent, so an empty list and a plugin
   * with no processor are the same answer, which is correct: neither has
   * anything to draw.
   */
  | { type: "preview-results"; seq: number; previews: LinkPreview[] };

/**
 * One link's preview, as the plugin left it.
 *
 * `text` may carry newlines: the guest reports one line per element the plugin
 * built, because a popup of two sibling spans reads as one glued sentence
 * otherwise. Both fields are bounded by the parser before they reach here —
 * `href` came from the note, but `text` is entirely the plugin's.
 */
export interface LinkPreview {
  href: string;
  text: string;
}

/**
 * The links of the open note, on their way to one frame.
 *
 * Note *content* — these are the addresses somebody wrote down and the words
 * they wrote around them — so this is gated on `maySeeContent` exactly as a
 * suggestion query is, and for the same reason: a plugin approved to read tags
 * and links in the *metadata* sense was not approved to read the note.
 */
export interface PreviewMessage {
  seq: number;
  links: LinkPreview[];
}

/**
 * A suggestion query on its way to one frame.
 *
 * `seq` is what makes this deliverable through props and what makes a stale
 * answer droppable — see `freshSuggestions`.
 */
export interface SuggestMessage {
  seq: number;
  line: string;
  ch: number;
}

/** A pick, routed back to the frame that offered it. */
export interface SuggestApplyMessage {
  seq: number;
  index: number;
}

/**
 * One line a plugin put in its status bar.
 *
 * **The plugin's words, not Context's**, which is what makes the id worth
 * carrying: the console keys on it so a changing reading updates in place
 * rather than reordering the row under somebody's eyes. Both strings are
 * bounded by the parser before they reach here — a plugin controls both.
 */
export interface StatusItem {
  id: string;
  text: string;
}

export type ParsedSandboxEvent =
  | { type: "ready" }
  | Exclude<SandboxEvent, { type: "rpc" }>
  | { type: "rpc"; request: object };

/**
 * The note the console has open, as the host tells a guest about it.
 *
 * Path and etag, never content. The etag is carried because the shim refuses a
 * write without one, so a plugin that reads the active note and edits it would
 * otherwise have to re-read the file purely to learn a version the host already
 * had.
 */
export interface ActiveFileRef {
  path: string;
  etag: string | null;
}

/**
 * One change Context made, on its way to the loaded plugins.
 *
 * **Only changes made through Context.** A write from Obsidian, rclone or
 * anything else touching the bucket directly never passes through this console
 * and is not reported — a limit the product accepted deliberately on
 * 2026-09-14, and one the consent screen states rather than leaving somebody to
 * discover.
 *
 * `seq` is what makes this deliverable through props: the host posts a message
 * when the number changes, so an event is sent exactly once even though the
 * object is handed down on every render.
 */
export interface VaultEventMessage {
  seq: number;
  kind: "create" | "modify" | "delete" | "rename";
  path: string;
  /** The old path, on a rename only. */
  from?: string;
  etag: string | null;
}

/**
 * A command the owner asked a running plugin to run.
 *
 * Carried as a slot with a `seq` for the same reason `VaultEventMessage` is:
 * this reaches the guest through props, and pressing the same command twice
 * must send two messages. Without the counter the second press would change
 * nothing about the object and no effect would fire.
 */
export interface InvokeMessage {
  seq: number;
  id: string;
}

export interface PluginSandboxProps {
  bundle: PluginRuntimeBundle;
  nonce: string;
  onEvent: (event: SandboxEvent) => void;
  /** `null` when nothing is open, which is a state a plugin must be able to see. */
  activeFile?: ActiveFileRef | null;
  /** The most recent change; `undefined` until Context has made one. */
  vaultEvent?: VaultEventMessage;
  /** The command to run; `undefined` until somebody presses one. */
  invoke?: InvokeMessage;
  /**
   * The line to suggest against.
   *
   * Note *content*, so the farm sends it only to a plugin granted
   * `vault:read` — see `maySeeContent`. `undefined` for everyone else, which is
   * the same shape as never having been asked.
   */
  suggest?: SuggestMessage;
  /** The suggestion the person picked, routed back to the frame that offered it. */
  suggestApply?: SuggestApplyMessage;
  /**
   * What the reader typed into the dialog this plugin opened.
   *
   * Routed to that one frame rather than broadcast: a dialog belongs to whoever
   * asked for it, and a query is what the reader typed into *their* dialog.
   * `undefined` for every other frame.
   */
  modalQuery?: { seq: number; query: string };
  /** The row they chose, routed back to the frame that offered it. */
  modalPick?: { seq: number; index: number };
  /** They closed it without choosing, so the plugin's own onClose still runs. */
  modalDismiss?: { seq: number };
  /** Ask this frame for its settings pane, or close it. */
  settingsPane?: { seq: number; open: boolean };
  /** A reader worked a control: which one, and what it now reads. */
  settingsChange?: { seq: number; index: number; value: boolean | string | number };
  textModalDismiss?: { seq: number };
  /**
   * The links to preview.
   *
   * Note content like `suggest`, gated the same way, and `undefined` for a
   * plugin that may not be asked.
   */
  preview?: PreviewMessage;
}
