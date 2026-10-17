/**
 * The shapes a storage binding travels in: the provider and capability
 * validators, the sealed row the gateway path reads, the credential it hands
 * back, and the batches the rekey sweep works in.
 *
 * Split out of `functions/storage.ts`, which keeps every registered storage
 * function; this module registers none and opens no credential.
 */

import { v } from "convex/values";
import type { Id } from "../../../_generated/dataModel";
import type { EnvelopeField } from "./rekeyColumns";

export const providerValidator = v.union(
  v.literal("r2"),
  v.literal("s3"),
  v.literal("b2"),
  v.literal("s3-compatible"),
);

/**
 * Providers whose conditional-write support we do not assume.
 *
 * R2 (`onlyIf: { etagMatches }`) and AWS S3 (`If-Match`) support it. B2 and
 * arbitrary S3-compatible endpoints do not reliably, so a new binding starts
 * with `conditionalWrite: false` and only a real probe at verification time
 * may turn it on. Optimistically claiming the capability would mean silently
 * dropping conflict detection — a lost write with no error, which is the one
 * failure mode a notes product cannot have.
 */
export function initialCapabilities(): StorageCapabilities {
  return {
    conditionalWrite: false,
    conditionalCreate: false,
    conditionalDelete: false,
    serverSideCopy: false,
  };
}

export interface StorageCapabilities {
  conditionalWrite: boolean;
  conditionalCreate?: boolean;
  conditionalDelete?: boolean;
  serverSideCopy?: boolean;
}

/**
 * The capability object, once, for every validator that carries it.
 *
 * It was restated in four places — `recordVerification`, the sealed-row query,
 * the gateway credential union (twice) and the console's binding view — and a
 * field added to the schema and to three of the five is a field the gateway
 * never sees, which is a silent capability loss rather than a type error.
 * `serverSideCopy` was added as exactly that: probed since #374, in the schema
 * from this change, and worth nothing until every hop below carries it.
 */
export const capabilitiesValidator = v.object({
  conditionalWrite: v.boolean(),
  conditionalCreate: v.optional(v.boolean()),
  conditionalDelete: v.optional(v.boolean()),
  serverSideCopy: v.optional(v.boolean()),
});

/** What the binding write returns. Named so the action can annotate itself. */
export interface BindingResult {
  bindingId: Id<"storageBindings">;
  status: string;
}

/**
 * The providers a binding can be served to the gateway under.
 *
 * A provider removed from the product can still have rows in the schema until
 * its purge has run (the purge module is named in the schema). Such a row is never
 * served: `getBindingForGateway` reports no binding for it, exactly as it would
 * for a provider this deployment does not know.
 */
export const SERVED_PROVIDERS = ["r2", "s3", "b2", "s3-compatible"] as const;
export type ServedProvider = (typeof SERVED_PROVIDERS)[number];

export function isServedProvider(provider: string): provider is ServedProvider {
  return (SERVED_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * The sealed row, as `getBindingRow` returns it.
 *
 * The S3 fields are optional because a row may predate them. The per-provider
 * check at the consumer refuses rather than half-builds.
 */
export interface SealedBinding {
  /** A served provider, or a row from a removed one awaiting purge. See `SERVED_PROVIDERS`. */
  provider: string;
  endpoint?: string;
  region?: string;
  bucket?: string;
  rootPrefix?: string;
  accessKeyId?: string;
  encryptedSecretAccessKey?: string;
  /** Absent means "let the adapter decide". See the schema for why. */
  forcePathStyle?: boolean;
  capabilities: StorageCapabilities;
  status: string;
}

/**
 * What the gateway gets: an opened credential that is complete.
 *
 * Spelled out rather than derived from `SealedBinding`: a *row* may be missing
 * fields a credential handed to the gateway may not. `getBindingForGateway`
 * narrows the row before returning, so the required fields here are a
 * guarantee it has already made.
 */
export interface S3GatewayCredential {
  /**
   * A literal union, not `string`, so consumers can narrow on it.
   */
  provider: ServedProvider;
  endpoint: string;
  region: string;
  bucket: string;
  rootPrefix?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  capabilities: StorageCapabilities;
  status: string;
}

export type GatewayCredential = S3GatewayCredential;

/** One batch of envelopes still sealed under an older key. */
export interface RekeyCandidates {
  candidates: {
    bindingId: Id<"storageBindings">;
    workspaceId: Id<"workspaces">;
    field: EnvelopeField;
    envelope: string;
  }[];
  unreadable: number;
}

/** Candidate rows outside `storageBindings`, one per envelope. */
export interface DataKeyRekeyCandidates {
  candidates: {
    rowId: Id<"workspaceDataKeys">;
    workspaceId: Id<"workspaces">;
    envelope: string;
  }[];
  unreadable: number;
}

/**
 * What one re-encrypt pass moved.
 *
 * The data-key counts are reported separately rather than folded into the
 * first three, because the two failures are not the same size. A binding this
 * pass cannot open is a credential the owner re-enters. A **workspace data key**
 * it cannot open is every encrypted note in that context, and there is no
 * re-entering it: the operator must stop and put the previous envelope key
 * back rather than finish step 4.
 */
export interface RekeyResult {
  rekeyed: number;
  skipped: number;
  unreadable: number;
  dataKeysRekeyed: number;
  dataKeysSkipped: number;
  dataKeysUnreadable: number;
  googleConnectionsRekeyed: number;
  googleConnectionsSkipped: number;
  googleConnectionsUnreadable: number;
  providerCredentialsRekeyed: number;
  providerCredentialsSkipped: number;
  providerCredentialsUnreadable: number;
  platformSecretsRekeyed: number;
  platformSecretsSkipped: number;
  platformSecretsUnreadable: number;
  managedMigrationsRekeyed: number;
  managedMigrationsSkipped: number;
  managedMigrationsUnreadable: number;
}

export interface ManagedMigrationRekeyCandidates {
  candidates: {
    rowId: Id<"managedStorageMigrations">;
    workspaceId: Id<"workspaces">;
    envelope: string;
  }[];
  unreadable: number;
}

/** Platform-scoped envelopes, one per `appSecrets` row. */
export interface PlatformSecretRekeyCandidates {
  candidates: { rowId: Id<"appSecrets">; envelope: string }[];
  unreadable: number;
}
