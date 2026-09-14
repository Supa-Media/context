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
  | { type: "status-bar"; items: StatusItem[] };

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
}
