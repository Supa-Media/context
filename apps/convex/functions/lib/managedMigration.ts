/**
 * One page of a whole-bucket move, reconciled source to target.
 *
 * The implementation lives in the gateway (`apps/mcp/src/moves/migrationPage.js`)
 * because the gateway's mover runs it next to the buckets; this action runs the
 * very same code while the mover is switched off (`lib/storageMover.ts`).
 */

export {
  conflictCopyKey,
  planReconcileWaves,
  reconcileMigrationObject,
  reconcileMigrationPage,
} from "../../../mcp/src/moves/migrationPage.js";

interface ReadableObject {
  contentType?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface MigrationStore {
  get(key: string): Promise<ReadableObject | null>;
  put(
    key: string,
    value: ArrayBuffer,
    options: { contentType: string },
  ): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

/** The half of a listed object the walk reads: its key, and its size if given. */
export interface MigrationListedObject {
  key: string;
  size?: number;
}
