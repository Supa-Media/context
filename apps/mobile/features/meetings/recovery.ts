/**
 * The pure rule behind "a meeting stuck on Finalizing for two hours", crossed
 * into this app the way `protocol.ts` crosses the contract: one file, nothing
 * added or renamed, so `packages/meetings/src/recovery.js` is the only place
 * the rule is stated. See `controller.ts`'s `recoverStaleFinalizes` for the
 * glue — this file is only the import.
 */
export { FINALIZE_TIMEOUT_MS, checkFinalizeTimeout } from "@context/meetings/recovery";
export type { FinalizeRecoveryAction } from "@context/meetings/recovery";
