/**
 * Context's own encryption of a managed bucket, as its owner sees it.
 *
 * Absent or `null` hides the Encryption row: a workspace the rollout has not
 * reached yet is promised nothing. A failed check is ours to fix, so it
 * arrives here as `paused`, never as a failure.
 */
export interface ManagedEncryptionView {
  state: "encrypting" | "checking" | "encrypted" | "paused";
  filesDone?: number;
  filesTotal?: number;
}
