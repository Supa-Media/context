/**
 * Watching a brand-new binding settle.
 *
 * `bindStorage` writes the row as `unverified` and schedules the probe; it
 * cannot return the probe's result, because a public function that could see it
 * would have a decrypted credential in scope. So the outcome arrives on the row
 * through the reactive `getStorageBinding` subscription, exactly as it does for
 * Re-verify.
 *
 * This is a plain function of the inputs rather than a controller like
 * `console/storage/reverify.ts`, and the difference is worth stating: Re-verify
 * has to tell "the row moved" from "the row looks the same", because
 * re-verifying a healthy binding most often ends where it started, so it needs
 * a baseline and a generation counter. A *first* bind has no baseline to
 * confuse — there was no row a moment ago — so `status` alone is the whole
 * answer and a reducer is enough.
 */

import { describeStorageFailure, type StorageFailure } from "../console/storage/errors";

export type ConnectState =
  /** Nothing submitted yet. */
  | { kind: "idle" }
  /** The action is in flight — the credential is on its way. */
  | { kind: "binding" }
  /** The row exists and the probe has not reported yet. */
  | { kind: "verifying" }
  | { kind: "connected" }
  | { kind: "failed"; failure: StorageFailure }
  /** Queued, but nothing came back inside the window. */
  | { kind: "timeout"; message: string };

/** The slice of the binding this needs. */
export interface WatchedBinding {
  status: string;
  lastError?: string;
  errorCode?: string;
}

/**
 * How long to wait for the probe before saying so.
 *
 * Matches `REVERIFY_TIMEOUT_MS`. The probe does real network I/O against a
 * bucket that may be slow, and a timeout is not a failure — the check is still
 * queued and the console updates on its own when it lands, which is what the
 * message says.
 */
export const CONNECT_TIMEOUT_MS = 30_000;

export function connectProgress({
  submitted,
  binding,
  timedOut,
}: {
  /** True once the connect action has been called. */
  submitted: boolean;
  /** The row: `undefined` while loading, `null` when there is none yet. */
  binding: WatchedBinding | null | undefined;
  timedOut: boolean;
}): ConnectState {
  if (!submitted) return { kind: "idle" };

  // No row yet — either the action is still running, or its write has not come
  // back down the subscription. Both are "hold on", not "nothing happened".
  if (binding === undefined || binding === null) {
    return timedOut
      ? {
          kind: "timeout",
          message:
            "Still waiting on your provider. Nothing is lost — your bucket's status shows up in the console as soon as the check lands.",
        }
      : { kind: "binding" };
  }

  if (binding.status === "connected") return { kind: "connected" };

  if (binding.status === "error") {
    return { kind: "failed", failure: describeStorageFailure(binding.errorCode, binding.lastError) };
  }

  // `unverified`, or a status this client has not heard of. Either way the
  // probe has not delivered a verdict, so keep waiting rather than guessing.
  return timedOut
    ? {
        kind: "timeout",
        message:
          "Still waiting on your provider. Nothing is lost — your bucket's status shows up in the console as soon as the check lands.",
      }
    : { kind: "verifying" };
}

/** What to show while the check runs. Two stages, because they feel different. */
export function connectProgressLabel(state: ConnectState): string | null {
  switch (state.kind) {
    case "binding":
      return "Saving your credential…";
    case "verifying":
      return "Checking that we can list and write to your bucket…";
    default:
      return null;
  }
}

/** Whether the flow may move on from the storage step. */
export function connectSettled(state: ConnectState): boolean {
  return state.kind === "connected";
}

/**
 * Whether a timed-out or failed attempt should still let somebody past.
 *
 * It should. A binding that never verified is a state the schema supports and
 * the console reports, and holding a person on a credential form because their
 * provider is slow is the hostile version of careful.
 */
export function connectEscapable(state: ConnectState): boolean {
  return state.kind === "failed" || state.kind === "timeout";
}
