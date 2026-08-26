/**
 * The "Copy → Copied → Copy" behaviour from the mockup, as a plain object with
 * its clock and its clipboard injected.
 *
 * It lives outside the React hook on purpose: the interesting parts — that a
 * failed write must not claim success, and that clicking twice restarts the
 * timer instead of stacking two of them and reverting early — are testable
 * without rendering anything. `useCopy` is the thin React binding.
 */

export const COPY_RESET_MS = 1400;

export interface CopyControllerOptions<Handle> {
  /** What lands on the clipboard. */
  text: string;
  /** Resting label, restored after `resetMs`. */
  idleLabel?: string;
  copiedLabel?: string;
  /** Shown when the clipboard refuses — never "Copied" over a no-op. */
  failedLabel?: string;
  resetMs?: number;
  write: (text: string) => Promise<boolean>;
  schedule: (fn: () => void, ms: number) => Handle;
  cancel: (handle: Handle) => void;
  onLabelChange: (label: string) => void;
}

export interface CopyController {
  readonly label: string;
  copy: () => Promise<boolean>;
  dispose: () => void;
}

export function createCopyController<Handle>(
  options: CopyControllerOptions<Handle>,
): CopyController {
  const idleLabel = options.idleLabel ?? "Copy";
  const copiedLabel = options.copiedLabel ?? "Copied";
  const failedLabel = options.failedLabel ?? "Press ⌘C";
  const resetMs = options.resetMs ?? COPY_RESET_MS;

  let label = idleLabel;
  let pending: Handle | null = null;

  function clearPending() {
    if (pending !== null) {
      options.cancel(pending);
      pending = null;
    }
  }

  function setLabel(next: string) {
    if (next === label) return;
    label = next;
    options.onLabelChange(next);
  }

  return {
    get label() {
      return label;
    },

    async copy() {
      const ok = await options.write(options.text);
      // Clear *after* the write resolves: an in-flight second click should
      // extend the confirmation, not let the first timer cut it short.
      clearPending();
      setLabel(ok ? copiedLabel : failedLabel);
      pending = options.schedule(() => {
        pending = null;
        setLabel(idleLabel);
      }, resetMs);
      return ok;
    },

    dispose() {
      clearPending();
    },
  };
}
