/**
 * The two storage bodies that open a sealed envelope: handing the gateway a
 * usable credential, and re-encrypting every envelope still on an older key.
 *
 * Split out of `functions/storage.ts`, which keeps `getBindingForGateway` and
 * `rekeyStorageBindings` registered there as internal actions, under the same
 * names and validators, and wires these handlers to them; this module
 * registers none. It is the one module under `lib/storage/` that imports
 * `decryptSecret`, and it takes that place in `DECRYPT_IMPORTERS` from
 * `functions/storage.ts`, which no longer imports it. The credential graph in
 * `__tests__/structure/` follows each registration into its handler here, so
 * both are still the decrypt-capable nodes they were, and nothing else is.
 */

import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import {
  CredentialCryptoError,
  decryptSecret,
  encryptSecret,
  requireKeyset,
} from "../crypto";
import type {
  DataKeyRekeyCandidates,
  GatewayCredential,
  ManagedMigrationRekeyCandidates,
  PlatformSecretRekeyCandidates,
  RekeyCandidates,
  RekeyResult,
  SealedBinding,
} from "./shapes";
import { isServedProvider } from "./shapes";
import type { ConnectorRekeyCandidates } from "./rekeyConnectorSecrets";
import {
  REKEY_BATCH_SIZE,
  type GoogleConnectionRekeyCandidates,
  type ProviderCredentialRekeyCandidates,
} from "./rekeyColumns";

// Same inference cycle as `bindStorage`: annotated, not inferred.
export const getBindingForGatewayHandler = async (
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<GatewayCredential | null> => {
  const binding: SealedBinding | null = await ctx.runQuery(
    internal.functions.storage.getBindingRow,
    { workspaceId: args.workspaceId },
  );
  if (binding === null) return null;

  // A row whose provider this deployment does not serve (a legacy row awaiting
  // purge) is reported as no binding, the same answer as a workspace with none.
  if (!isServedProvider(binding.provider)) return null;

  // Narrowed rather than asserted. These five are guaranteed together for
  // every provider by `bindStorage`, and a row that somehow
  // lacks one is a corrupt binding, not something to paper over with `!`.
  if (
    !binding.endpoint ||
    !binding.region ||
    !binding.bucket ||
    !binding.accessKeyId ||
    !binding.encryptedSecretAccessKey
  ) {
    throw new ConvexError({
      code: "CREDENTIAL_UNAVAILABLE",
      message:
        "This workspace's storage binding is incomplete. Rebind storage to replace it.",
    });
  }

  // The workspace id is the AAD the envelope was sealed with. Passing the id
  // this call was made *for* — rather than one carried inside the row — is
  // what makes a future id-confusion bug in the gateway a decrypt failure
  // instead of a cross-tenant credential handout.
  let secretAccessKey: string;
  try {
    secretAccessKey = await decryptSecret(
      binding.encryptedSecretAccessKey,
      requireKeyset(),
      { workspaceId: args.workspaceId },
    );
  } catch (error) {
    // A `CredentialCryptoError` is a plain `Error`, which a caller sees as an
    // unhelpful "Server Error". Re-throw with a code so the gateway can tell
    // "this binding needs re-pasting" from "the service is broken" — and
    // carry no detail beyond that, since the underlying distinctions (wrong
    // key, wrong workspace, tampered ciphertext) are an oracle.
    if (error instanceof CredentialCryptoError) {
      throw new ConvexError({
        code: "CREDENTIAL_UNAVAILABLE",
        message:
          "This workspace's storage credential could not be opened. Rebind storage to replace it.",
      });
    }
    throw error;
  }

  return {
    provider: binding.provider,
    endpoint: binding.endpoint,
    region: binding.region,
    bucket: binding.bucket,
    rootPrefix: binding.rootPrefix,
    accessKeyId: binding.accessKeyId,
    secretAccessKey,
    forcePathStyle: binding.forcePathStyle,
    capabilities: binding.capabilities,
    status: binding.status,
  };
};

/** The body of `rekeyStorageBindings`: see its registration for the contract. */
export const rekeyStorageBindingsHandler = async (
  ctx: ActionCtx,
  args: { limit?: number },
): Promise<RekeyResult> => {
  const keyset = requireKeyset();
  const limit = Math.min(Math.max(args.limit ?? REKEY_BATCH_SIZE, 1), 200);

  const found: RekeyCandidates = await ctx.runQuery(
    internal.functions.storage.listRekeyCandidates,
    { currentKeyId: keyset.current.id, limit },
  );

  let rekeyed = 0;
  let skipped = 0;
  let unreadable = found.unreadable;
  for (const candidate of found.candidates) {
    const context = { workspaceId: candidate.workspaceId as string };
    let plaintext: string;
    try {
      plaintext = await decryptSecret(candidate.envelope, keyset, context);
    } catch {
      // Nothing configured can open it. Counted, never deleted.
      unreadable += 1;
      continue;
    }
    const applied: boolean = await ctx.runMutation(
      internal.functions.storage.applyRekey,
      {
        bindingId: candidate.bindingId,
        field: candidate.field,
        expectedEnvelope: candidate.envelope,
        envelope: await encryptSecret(plaintext, keyset, context),
      },
    );
    if (applied) rekeyed += 1;
    else skipped += 1;
  }

  // The workspace data keys, in the same pass and under the same budget, so
  // that "run it until it reports nothing left" stays one instruction. An
  // operator who has to remember a second command is an operator who
  // eventually does not, and the cost of forgetting this one is somebody's
  // encrypted notes rather than a credential they can re-enter.
  const dataKeys: DataKeyRekeyCandidates = await ctx.runQuery(
    internal.functions.storage.listDataKeyRekeyCandidates,
    { currentKeyId: keyset.current.id, limit },
  );

  let dataKeysRekeyed = 0;
  let dataKeysSkipped = 0;
  let dataKeysUnreadable = dataKeys.unreadable;
  for (const candidate of dataKeys.candidates) {
    const context = { workspaceId: candidate.workspaceId as string };
    let material: string;
    try {
      material = await decryptSecret(candidate.envelope, keyset, context);
    } catch {
      // Counted loudly and never deleted. This row is the only copy of the
      // key that opens a context's notes.
      dataKeysUnreadable += 1;
      continue;
    }
    const applied: boolean = await ctx.runMutation(
      internal.functions.storage.applyDataKeyRekey,
      {
        rowId: candidate.rowId,
        expectedEnvelope: candidate.envelope,
        envelope: await encryptSecret(material, keyset, context),
      },
    );
    if (applied) dataKeysRekeyed += 1;
    else dataKeysSkipped += 1;
  }

  // The connected mailboxes' Gmail tokens — a different table from
  // `storageBindings`, so `listRekeyCandidates` above never sees them. This
  // is the same class of miss `encryptedDataKey` was before its own pass
  // existed, and it gets the same fix: a dedicated candidate query, wired in
  // here, not merely a column name added to a list somewhere.
  const googleConnections: GoogleConnectionRekeyCandidates =
    await ctx.runQuery(
      internal.functions.storage.listGoogleConnectionRekeyCandidates,
      { currentKeyId: keyset.current.id, limit },
    );

  let googleConnectionsRekeyed = 0;
  let googleConnectionsSkipped = 0;
  let googleConnectionsUnreadable = googleConnections.unreadable;
  for (const candidate of googleConnections.candidates) {
    const context = { workspaceId: candidate.workspaceId as string };
    let plaintext: string;
    try {
      plaintext = await decryptSecret(candidate.envelope, keyset, context);
    } catch {
      googleConnectionsUnreadable += 1;
      continue;
    }
    const applied: boolean = await ctx.runMutation(
      internal.functions.storage.applyGoogleConnectionRekey,
      {
        connectionId: candidate.connectionId,
        field: candidate.field,
        expectedEnvelope: candidate.envelope,
        envelope: await encryptSecret(plaintext, keyset, context),
      },
    );
    if (applied) googleConnectionsRekeyed += 1;
    else googleConnectionsSkipped += 1;
  }

  // The agent's model account. A fourth table, so a fourth walk — wired in
  // here rather than only named in `ROTATED_ENVELOPE_COLUMNS`, because a
  // column listed as rotated whose table this pass never visits is the exact
  // shape of the `encryptedDataKey` miss.
  const providerCredentials: ProviderCredentialRekeyCandidates =
    await ctx.runQuery(
      internal.functions.storage.listProviderCredentialRekeyCandidates,
      { currentKeyId: keyset.current.id, limit },
    );

  let providerCredentialsRekeyed = 0;
  let providerCredentialsSkipped = 0;
  let providerCredentialsUnreadable = providerCredentials.unreadable;
  for (const candidate of providerCredentials.candidates) {
    const context = { workspaceId: candidate.workspaceId as string };
    let plaintext: string;
    try {
      plaintext = await decryptSecret(candidate.envelope, keyset, context);
    } catch {
      providerCredentialsUnreadable += 1;
      continue;
    }
    const applied: boolean = await ctx.runMutation(
      internal.functions.storage.applyProviderCredentialRekey,
      {
        rowId: candidate.rowId,
        expectedEnvelope: candidate.envelope,
        envelope: await encryptSecret(plaintext, keyset, context),
      },
    );
    if (applied) providerCredentialsRekeyed += 1;
    else providerCredentialsSkipped += 1;
  }

  // And the platform's own credentials. Losing these is an outage rather than
  // data loss — an operator re-enters them — but a rotation that cannot be
  // finished without one is a rotation nobody performs, which is the state
  // this pass exists to end.
  const platform: PlatformSecretRekeyCandidates = await ctx.runQuery(
    internal.functions.storage.listPlatformSecretRekeyCandidates,
    { currentKeyId: keyset.current.id, limit },
  );

  let platformSecretsRekeyed = 0;
  let platformSecretsSkipped = 0;
  let platformSecretsUnreadable = platform.unreadable;
  const platformContext = { platform: "integration" as const };
  for (const candidate of platform.candidates) {
    let value: string;
    try {
      value = await decryptSecret(
        candidate.envelope,
        keyset,
        platformContext,
      );
    } catch {
      platformSecretsUnreadable += 1;
      continue;
    }
    const applied: boolean = await ctx.runMutation(
      internal.functions.storage.applyPlatformSecretRekey,
      {
        rowId: candidate.rowId,
        expectedEnvelope: candidate.envelope,
        envelope: await encryptSecret(value, keyset, platformContext),
      },
    );
    if (applied) platformSecretsRekeyed += 1;
    else platformSecretsSkipped += 1;
  }

  // Connected apps' tokens (workspace-bound) and the client secrets their
  // authorization servers issued us (platform-bound): two more tables.
  const connectors: ConnectorRekeyCandidates = await ctx.runQuery(
    internal.functions.storage.listConnectorRekeyCandidates,
    { currentKeyId: keyset.current.id, limit },
  );
  let connectorSecretsRekeyed = 0;
  let connectorSecretsSkipped = 0;
  let connectorSecretsUnreadable = connectors.unreadable;
  for (const candidate of connectors.connections) {
    const context = { workspaceId: candidate.workspaceId as string };
    let plaintext: string;
    try {
      plaintext = await decryptSecret(candidate.envelope, keyset, context);
    } catch {
      connectorSecretsUnreadable += 1;
      continue;
    }
    const applied: boolean = await ctx.runMutation(internal.functions.storage.applyConnectionRekey, {
      rowId: candidate.rowId,
      field: candidate.field,
      expectedEnvelope: candidate.envelope,
      envelope: await encryptSecret(plaintext, keyset, context),
    });
    if (applied) connectorSecretsRekeyed += 1;
    else connectorSecretsSkipped += 1;
  }
  for (const candidate of connectors.clients) {
    let plaintext: string;
    try {
      plaintext = await decryptSecret(candidate.envelope, keyset, platformContext);
    } catch {
      connectorSecretsUnreadable += 1;
      continue;
    }
    const applied: boolean = await ctx.runMutation(internal.functions.storage.applyOAuthClientRekey, {
      rowId: candidate.rowId,
      expectedEnvelope: candidate.envelope,
      envelope: await encryptSecret(plaintext, keyset, platformContext),
    });
    if (applied) connectorSecretsRekeyed += 1;
    else connectorSecretsSkipped += 1;
  }

  const managedMigrations: ManagedMigrationRekeyCandidates =
    await ctx.runQuery(
      internal.functions.storage.listManagedMigrationRekeyCandidates,
      { currentKeyId: keyset.current.id, limit },
    );
  let managedMigrationsRekeyed = 0;
  let managedMigrationsSkipped = 0;
  let managedMigrationsUnreadable = managedMigrations.unreadable;
  for (const candidate of managedMigrations.candidates) {
    const context = { workspaceId: candidate.workspaceId as string };
    let plaintext: string;
    try {
      plaintext = await decryptSecret(candidate.envelope, keyset, context);
    } catch {
      managedMigrationsUnreadable += 1;
      continue;
    }
    const applied: boolean = await ctx.runMutation(
      internal.functions.storage.applyManagedMigrationRekey,
      {
        rowId: candidate.rowId,
        expectedEnvelope: candidate.envelope,
        envelope: await encryptSecret(plaintext, keyset, context),
      },
    );
    if (applied) managedMigrationsRekeyed += 1;
    else managedMigrationsSkipped += 1;
  }

  return {
    rekeyed,
    skipped,
    unreadable,
    dataKeysRekeyed,
    dataKeysSkipped,
    dataKeysUnreadable,
    googleConnectionsRekeyed,
    googleConnectionsSkipped,
    googleConnectionsUnreadable,
    providerCredentialsRekeyed,
    providerCredentialsSkipped,
    providerCredentialsUnreadable,
    platformSecretsRekeyed,
    platformSecretsSkipped,
    platformSecretsUnreadable,
    managedMigrationsRekeyed,
    managedMigrationsSkipped,
    managedMigrationsUnreadable,
    connectorSecretsRekeyed,
    connectorSecretsSkipped,
    connectorSecretsUnreadable,
  };
};
