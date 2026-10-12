/**
 * "Check it's you" (Dev2, 2026-10-12, board k2), on the client.
 *
 * The server refuses every big change from a device that has not confirmed an
 * emailed code lately, with the error code `EMAIL_PROOF_REQUIRED`
 * (`apps/convex/functions/lib/emailProof.ts`). Rather than teach every button
 * that asks for one, the Convex client itself is taught once: a mutation or
 * action refused that way opens the dialog, waits for the code, and runs again
 * exactly once. A refused mutation wrote nothing, and every guarded action
 * asks before it does anything, so running it again is safe.
 *
 * Dismissing the dialog lets the original refusal through, and its message
 * ("Check it's you: confirm with a code we email you.") is what the button
 * that asked shows.
 */

export const EMAIL_PROOF_REQUIRED = "EMAIL_PROOF_REQUIRED";

export function needsEmailProof(error: unknown): boolean {
  const data = (error as { data?: unknown } | null)?.data;
  return typeof data === "object" && data !== null && (data as { code?: unknown }).code === EMAIL_PROOF_REQUIRED;
}

type Listener = (open: boolean) => void;

let pending: { promise: Promise<boolean>; resolve: (proven: boolean) => void } | null = null;
const listeners = new Set<Listener>();

/** Open the dialog, or join the one already open. True once a code was confirmed. */
export function requestEmailProof(): Promise<boolean> {
  if (pending !== null) return pending.promise;
  // With nothing mounted to answer, say no at once rather than hang.
  if (listeners.size === 0) return Promise.resolve(false);
  let resolve!: (proven: boolean) => void;
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });
  pending = { promise, resolve };
  for (const listener of listeners) listener(true);
  return promise;
}

/** The dialog's answer: confirmed, or closed without a code. */
export function settleEmailProof(proven: boolean): void {
  const settling = pending;
  pending = null;
  for (const listener of listeners) listener(false);
  settling?.resolve(proven);
}

export function subscribeEmailProof(listener: Listener): () => void {
  listeners.add(listener);
  listener(pending !== null);
  return () => {
    listeners.delete(listener);
  };
}

const INSTALLED = Symbol.for("context.emailProofRetry");

type Callable = (...args: unknown[]) => Promise<unknown>;

/**
 * Wrap the client's `mutation` and `action` so a refusal for want of a code
 * asks for one and tries again. Idempotent: the client is a singleton and
 * this may run on every mount.
 */
export function installEmailProofRetry(client: object): void {
  const target = client as Record<string | symbol, unknown>;
  if (target[INSTALLED] === true) return;
  target[INSTALLED] = true;
  for (const method of ["mutation", "action"] as const) {
    const original = (target[method] as Callable).bind(client);
    target[method] = async (...args: unknown[]) => {
      try {
        return await original(...args);
      } catch (error) {
        if (!needsEmailProof(error)) throw error;
        if (!(await requestEmailProof())) throw error;
        return await original(...args);
      }
    };
  }
}
