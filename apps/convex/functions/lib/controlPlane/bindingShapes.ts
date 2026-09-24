/**
 * What `/gateway/binding` hands back: the binding shapes, the search index
 * and encryption key beside them, and their validators.
 *
 * Split out of `functions/controlPlane.ts`, which keeps every registered
 * function; this module registers none. It is on the gateway's path,
 * so `scripts/check-exit-is-ungated.mjs` scans it exactly as it scans that
 * file.
 */

import { v } from "convex/values";
import type { Doc, Id } from "../../../_generated/dataModel";
import {
  /*
    The capability object, from the one module that owns it.

    #653 named this exact hazard — "a field added to the schema and to three of
    the five is a field the gateway never sees" — and then left the gateway's
    two copies restated here. `serverSideCopy` landed in the schema and in
    `storage.ts`, so `getBindingForGateway` started returning it and this
    file's `v.object` refused its own return value: every `POST
    /gateway/binding` threw `ReturnsValidationError`, the gateway read that as
    a control-plane failure, and every client was told `storage_unavailable`.
    Importing the shape is what makes the next field impossible to miss.
  */
  capabilitiesValidator,
  type StorageCapabilities,
} from "../storage/shapes";

/** Statuses a `storageBindings` row can hold, and what the gateway sees. */
export type BindingStatus = Doc<"storageBindings">["status"];

/**
 * Whether a binding row is one the gateway may build a store from.
 *
 * Only `connected` — a binding something has actually talked to. `unverified`
 * means nothing has contacted that bucket yet and `error` means something did
 * and it failed; handing either to the gateway would be claiming a bucket
 * works on no evidence. The gateway is told nothing about which: a non-usable
 * binding is reported as no binding at all, so this route cannot be used to
 * probe another tenant's storage health.
 */
export function isUsable(status: BindingStatus): boolean {
  return status === "connected";
}

/** Exactly the credentialed-binding payload the contract documents. */
export interface S3GatewayBinding {
  workspaceId: Id<"workspaces">;
  provider: string;
  endpoint: string;
  region: string;
  bucket: string;
  rootPrefix?: string;
  accessKeyId: string;
  /** Radioactive: sign with it, never log it, never cache it. */
  secretAccessKey: string;
  /**
   * `binding.forcePathStyle` in the contract. Absent means "let `S3Store`
   * decide", which is what the gateway's `nativeStore` already passes through.
   */
  forcePathStyle?: boolean;
  capabilities: StorageCapabilities;
  status: string;
}

/**
 * The Dropbox payload: a short-lived access token, a folder, and nothing else.
 *
 * A separate shape rather than the S3 one with holes, so there is no way to
 * hand the gateway a Dropbox binding that still carries a bucket credential.
 */
export interface DropboxGatewayBinding {
  workspaceId: Id<"workspaces">;
  provider: "dropbox";
  accessToken: string;
  rootPrefix?: string;
  capabilities: StorageCapabilities;
  status: string;
}

export type GatewayBinding = S3GatewayBinding | DropboxGatewayBinding;

/**
 * The D1 write credential, for the one workspace this binding was opened for.
 *
 * ## Why the gateway is the thing that gets it
 *
 * The projection is a copy of note *text*, and the gateway is the only
 * component in this system that ever reads note text. The control plane holds
 * the encrypted storage credential and hands it out; it does not fetch bucket
 * objects, and giving it that ability to run a backfill would be a second
 * internet-facing component reading customers' notes. So the projection is the
 * gateway's job, and this is the pair of things it cannot get anywhere else: a
 * database to write into, and a token that may write into it.
 *
 * ## `apiToken` is radioactive, exactly like `secretAccessKey`
 *
 * Never logged, never cached across requests, never in an error. It is fetched
 * per request from `appSecrets` and decrypted server-side, on the same route
 * and under the same two proofs as the bucket key beside it — which is the
 * reason it is a sibling of the binding rather than a route of its own: a
 * second route would be a second internet-facing path to a credential, and
 * `structure.test.ts` is explicit that adding one is a conversation.
 *
 * ## THE CAVEAT, STATED RATHER THAN HIDDEN
 *
 * `SEARCH_D1_API_TOKEN` carries `D1:Edit` on the **whole Cloudflare account**,
 * because that is what creating and deleting databases needs and there is one
 * token. Handed to the gateway it is therefore wider than the job: it can reach
 * every opted-in context's database, not only the one this response names. That
 * is a real widening of what a compromised gateway holds, and it is written
 * here rather than left to be discovered.
 *
 * What bounds it today: the gateway already holds every bucket credential it is
 * handed, one request at a time, so the marginal reach is over derived copies
 * of notes whose canonical originals it can already read. What would remove it
 * is a per-database token, which Cloudflare's API can mint — and which nobody
 * should invent quietly, because it adds a credential this control plane has to
 * create, store, rotate and revoke per context, and that is a design decision
 * with a cost, not an implementation detail.
 */
export interface GatewaySearchIndex {
  databaseId: string;
  accountId: string;
  /** Radioactive: write with it, never log it, never cache it. */
  apiToken: string;
  state: "backfilling" | "ready";
}

/**
 * What `/gateway/binding` answers with: the storage binding, and — only where
 * an owner asked for one and it exists — the index credential beside it.
 *
 * One shape rather than two calls, because both answers are about the same
 * workspace and that workspace is resolved once, from the grant. A second route
 * would resolve it a second time, which is a second place for the selection to
 * be wrong.
 */
export interface OpenedGatewayBinding {
  binding: GatewayBinding;
  /** Absent is the normal case: no opt-in, or one not yet provisioned. */
  searchIndex?: GatewaySearchIndex;
  /**
   * The key that opens this context's encrypted notes, where one exists.
   *
   * Absent is the ordinary answer and means "this context has never encrypted
   * anything", which is every context today. It is deliberately **not** created
   * on this path: reading a context that has never used the feature must not
   * write a key row to it, so `create` is false here and the key comes into
   * existence at the moment an owner turns encryption on for a note.
   *
   * A sibling of the binding rather than a field inside it, for the reason
   * `searchIndex` is one: the key belongs to the workspace, and a binding is
   * only the storage that workspace currently points at. See
   * `docs/decisions/encryption.md`.
   */
  encryptionKey?: GatewayEncryptionKey;
  /**
   * A workspace-key rotation in progress, where one is. Absent is the normal
   * case — no rotation ever started, or the last one finished — and it is
   * present regardless of whether this request also asked to start or
   * continue one, so a gateway that never asks can still tell a walk is
   * outstanding. See "Rotation" in `docs/decisions/encryption.md`.
   */
  rotation?: GatewayKeyRotation;
  /**
   * The free managed tier's note cap, where one is in force. Absent for every
   * other context. The gateway refuses a new note past it and nothing else;
   * `docs/decisions/billing.md`, "The free managed tier".
   */
  noteCap?: number;
}

/**
 * The workspace data key(s), as the gateway receives them.
 *
 * `keys` is radioactive on exactly the terms `secretAccessKey` is: every entry
 * opens every note wrapped under that generation, in one context. It lives for
 * one request, it is never logged, and `structure.test.ts` fails the build if
 * a public function declares a field named `dataKey`.
 *
 * Every live generation is included, not only `current` — a bucket can hold
 * notes from before the workspace's most recent rotation.
 */
export interface GatewayEncryptionKey {
  current: string;
  keys: Record<string, string>;
}

/** A rotation's identity, without its progress — the walk itself lives in the customer's bucket. */
export interface GatewayKeyRotation {
  fromGeneration: string;
  toGeneration: string;
}

/** The credentialed S3 payload, as a validator. Declared once, used twice. */
export const s3BindingValidator = v.object({
  workspaceId: v.id("workspaces"),
  provider: v.string(),
  endpoint: v.string(),
  region: v.string(),
  bucket: v.string(),
  rootPrefix: v.optional(v.string()),
  accessKeyId: v.string(),
  secretAccessKey: v.string(),
  forcePathStyle: v.optional(v.boolean()),
  capabilities: capabilitiesValidator,
  status: v.string(),
});

/** The Dropbox payload. A separate shape, never the S3 one with holes. */
export const dropboxBindingValidator = v.object({
  workspaceId: v.id("workspaces"),
  provider: v.literal("dropbox"),
  accessToken: v.string(),
  rootPrefix: v.optional(v.string()),
  capabilities: capabilitiesValidator,
  status: v.string(),
});

export const encryptionKeyValidator = v.object({
  current: v.string(),
  keys: v.record(v.string(), v.string()),
});

export const keyRotationValidator = v.object({
  fromGeneration: v.string(),
  toGeneration: v.string(),
});

export const searchIndexValidator = v.object({
  databaseId: v.string(),
  accountId: v.string(),
  apiToken: v.string(),
  state: v.union(v.literal("backfilling"), v.literal("ready")),
});
