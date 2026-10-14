/**
 * What one page of a whole-bucket move needs, and running it here.
 *
 * The page itself is the gateway's (`apps/mcp/src/moves/migrationPage.js`'s
 * `runMigrationPage`): listing, the file limit, and reconciling. This module
 * builds its input once, for both places it runs: the gateway's mover, which
 * receives it when a ticket is spent (`managedProvisioning.openMoverPage`), and
 * this deployment's own action while the mover is switched off.
 *
 * Takes the opened credentials as plain arguments and never opens one: the
 * decrypt stays in `functions/managedProvisioning.ts`, the module the structure
 * tests allow it in (see `targetReady.ts`, which keeps the same rule).
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import { runMigrationPage } from "../../../../mcp/src/moves/migrationPage.js";
import type { ManagedEncryptionOption } from "../managedEncryptionFns/storeOption";
import {
  MIGRATION_OBJECT_BYTE_CAP,
  MIGRATION_PAGE_SIZE,
  MIGRATION_WAVE_BYTE_BUDGET,
  MIGRATION_WAVE_WIDTH,
  MOVER_WAVE_BYTE_BUDGET,
  MOVER_WAVE_WIDTH,
} from "./constants";
import { intoOwnersBucket } from "./direction";
import { migrationTargetCredential } from "./targetReady";

/** What a page reports back, wherever it ran. */
export interface MigrationPageResult {
  copied: number;
  changes: number;
  processed: number;
  nextCursor: string | null;
  skipped: string[];
}

/** Bounds for a page run in a Convex action, and for one run in a Worker. */
export const ACTION_PAGE_LIMITS = {
  pageSize: MIGRATION_PAGE_SIZE,
  byteCap: MIGRATION_OBJECT_BYTE_CAP,
  maxWidth: MIGRATION_WAVE_WIDTH,
  byteBudget: MIGRATION_WAVE_BYTE_BUDGET,
};
export const MOVER_PAGE_LIMITS = {
  pageSize: MIGRATION_PAGE_SIZE,
  byteCap: MIGRATION_OBJECT_BYTE_CAP,
  maxWidth: MOVER_WAVE_WIDTH,
  byteBudget: MOVER_WAVE_BYTE_BUDGET,
};

/** What a page may do to the destination, read off the migration row alone. */
export function migrationPageRules(migration: Doc<"managedStorageMigrations">) {
  return {
    // Into a customer's bucket, only a destination checked empty before the
    // first write may lose keys the source lacks. A row started before that
    // check existed never had it, so it deletes nothing.
    deleteUnmatchedTarget: !intoOwnersBucket(migration) || migration.targetClaimed === true,
    // And even then only Context's plumbing: the customer's own files were
    // removed once, up front, if they chose to start fresh.
    ...(intoOwnersBucket(migration) ? { deleteOnlyUnder: ".context/" } : {}),
    // Merging: a file of theirs with a name the workspace also uses is kept
    // beside it on the first pass, before it is written over.
    keepTargetConflicts: migration.existingFiles === "merge" && migration.phase === "copy",
  };
}

type SourceCredential = { provider: string };

/**
 * One page's input: both bindings, the source's encryption when leaving
 * managed storage (so the customer's bucket gets plain files), the page's
 * position and its rules.
 */
export function migrationPageFor(
  workspaceId: Id<"workspaces">,
  migration: Doc<"managedStorageMigrations">,
  sourceCredential: SourceCredential,
  targetSecretAccessKey: string,
  sourceEncryption: ManagedEncryptionOption | null,
  limits: typeof ACTION_PAGE_LIMITS,
) {
  return {
    workspaceId: String(workspaceId),
    phase: migration.phase,
    cursor: migration.cursor ?? null,
    source: { ...sourceCredential, workspaceId: String(workspaceId) },
    target: migrationTargetCredential(migration, targetSecretAccessKey),
    ...(sourceEncryption === null
      ? {}
      : {
          managedEncryption: { mode: sourceEncryption.mode },
          encryptionKey: { current: sourceEncryption.current, keys: sourceEncryption.keys },
        }),
    limits,
    rules: migrationPageRules(migration),
  };
}

/** Run a page in this action: the fallback while the mover is switched off. */
export async function runMigrationPageHere(
  page: ReturnType<typeof migrationPageFor>,
): Promise<MigrationPageResult> {
  return (await runMigrationPage({
    ...page,
    cursor: page.cursor ?? undefined,
  })) as MigrationPageResult;
}
