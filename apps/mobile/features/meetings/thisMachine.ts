import type { ConnectionView, DesktopShell } from "@context/desktop-bridge";

/**
 * What the settings pane says about the machine the console is running on.
 *
 * A pure function over the shell's own connection state, for the reason
 * `console/capabilities.ts` records in one line: *every guard expressed inside
 * a component in this app was held by nothing.* The card renders what this
 * returns and decides nothing.
 *
 * ## What is deliberately absent
 *
 * A token, in every form. `ConnectionView` carries three words, a base URL and
 * two booleans, and `@context/desktop-bridge` refuses a bridge that exposes
 * anything credential-shaped — so there is nothing here to leak into a screen,
 * a log, or a screenshot somebody pastes into a support thread. The grant lives
 * in the OS keychain, in the shell's main process, where the requests that
 * carry it are made.
 *
 * ## Why `revoked` is a different word from `disconnected`
 *
 * The shell's `UiState` already draws that distinction and it is the whole
 * reason this card is worth drawing: one means "you have not connected this
 * machine", the other means "the grant you had is gone" — and only the second
 * has a queue of finished meetings waiting on somebody pressing a button. A UI
 * that folded them together would leave a person with recordings they could not
 * see a reason for.
 */

export type MachineAction = "connect" | "disconnect" | null;

export interface MachineDescription {
  /** For the pill: what state this machine is in, in one or two words. */
  pill: string;
  tone: "ok" | "warn" | "neutral";
  /** What that means, in a sentence somebody can act on. */
  sentence: string;
  /** The one control, or `null` while a browser window is already open. */
  action: MachineAction;
  /** The label on it. `null` when there is no control. */
  actionLabel: string | null;
  /** A failure from the last attempt, or a fact about this OS. Never a token. */
  notice: string | null;
}

/** The card's heading. Names the machine's kind, never the machine. */
export function machineTitle(shell: DesktopShell | null): string {
  if (shell === null) return "This machine";
  const where =
    shell.platform === "macos" ? "Mac" : shell.platform === "windows" ? "PC" : "computer";
  return `${shell.app} on this ${where}`;
}

/**
 * The one place the four states become words.
 *
 * `gateway` is shown when there is one, because "where do my meetings go" is
 * the question this card exists to answer and a base URL is the answer. It is
 * not a secret: it is the address the person themselves connected.
 */
export function describeMachine(connection: ConnectionView): MachineDescription {
  const notice = machineNotice(connection);

  if (connection.connecting) {
    return {
      pill: "Connecting",
      tone: "neutral",
      sentence:
        "A browser window is open so you can authorise this machine. It gets its own grant — nothing is copied from your other devices.",
      action: null,
      actionLabel: null,
      notice,
    };
  }

  if (connection.state === "connected") {
    return {
      pill: "Connected",
      tone: "ok",
      sentence:
        connection.gateway === null
          ? "This machine records meetings and sends them straight to your context."
          : `Meetings recorded here go to ${connection.gateway}. This machine has its own grant, revocable on its own.`,
      action: "disconnect",
      actionLabel: "Disconnect",
      notice,
    };
  }

  if (connection.state === "revoked") {
    return {
      pill: "Needs reconnecting",
      tone: "warn",
      sentence:
        "The grant this machine had is gone. Anything it recorded is still on this machine, queued, and it goes out as soon as you connect it again.",
      action: "connect",
      actionLabel: "Reconnect this machine",
      notice,
    };
  }

  return {
    pill: "Not connected",
    tone: "neutral",
    sentence:
      "This machine can record a meeting without a window open, and it needs a grant of its own to send one. Connecting it signs nothing else out, and revoking it later leaves your other devices alone.",
    action: "connect",
    actionLabel: "Connect this machine",
    notice,
  };
}

/**
 * The line under the control: what went wrong, or what this OS will not do.
 *
 * The error wins when there is one — it is newer and more specific. The storage
 * warning is not an error and is said anyway: a machine with no encrypted
 * storage is keeping its grant somewhere weaker than a keychain, and that is a
 * fact its owner is entitled to before they connect it rather than after.
 */
function machineNotice(connection: ConnectionView): string | null {
  if (connection.error !== null && connection.error !== "") return connection.error;
  if (!connection.encrypted) {
    return "This computer offers no encrypted storage, so the shell cannot protect this machine's grant as well as it would like.";
  }
  return null;
}
