import type { ReactAction, ReactMutation, RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { storageLayoutAnswerIsCurrent } from "@context/convex/functions/lib/storageLayout";
import { EMPTY_QUERY_SPEC } from "../querySpec";
import { hasNewActivity } from "../activity/activity";
import { toBindStorageArgs, type Provider } from "../storage/connect";
import { atName, contextToneFor, describeScopes, grantTone, lastUsedLabel } from "../format";
import {
  buildConstellation,
  contextKindFor,
  type ClientInput,
  type ContextInput,
} from "../map/graph";
import type {
  ConsoleClient,
  ConsoleContext,
  ConsoleStorage,
  StorageActions,
} from "../types";
import type { GoogleConnection } from "../google/GoogleConnectionsCard";
import {
  memberOf,
  usable,
  type GoogleConnectionSummary,
  type GrantSummary,
  type StorageBinding,
  type WorkspaceSummary,
} from "./summaries";

/*
  What the live console derives from its subscriptions, as plain functions.
  Each is an expression that used to be written inline in
  `useLiveConsoleData`, moved verbatim; the hook still decides when each runs
  and what it is memoized on.
*/

/** What `useQueries` hands back: an answer, `undefined` in flight, or an `Error`. */
type QueryResults = Record<string, unknown>;

/** One subscription per workspace, keyed by id. Called inside the hook's memo. */
export function perWorkspaceQueries(
  workspaces: readonly WorkspaceSummary[] | undefined,
): RequestForQueries {
  // An account with no contexts subscribes to nothing, and says so with the
  // shared constant rather than a fresh `{}`.
  const joined = memberOf(workspaces);
  if (joined.length === 0) return EMPTY_QUERY_SPEC;
  const spec: RequestForQueries = {};
  for (const workspace of joined) {
    spec[`grants:${workspace.workspaceId}`] = {
      query: api.functions.grants.listGrants,
      args: { workspaceId: workspace.workspaceId },
    };
    spec[`storage:${workspace.workspaceId}`] = {
      query: api.functions.storage.getStorageBinding,
      args: { workspaceId: workspace.workspaceId },
    };
    spec[`google:${workspace.workspaceId}`] = {
      query: api.functions.googleConnect.listGoogleConnections,
      args: { workspaceId: workspace.workspaceId },
    };
    /*
      Whether a model key exists, for the one control that would otherwise
      offer a conversation nothing can answer. It returns fingerprints and
      connection times — never a key, and never a fragment of one — and this
      projection keeps only whether the list is empty.
    */
    spec[`providers:${workspace.workspaceId}`] = {
      query: api.functions.providers.listProviders,
      args: { workspaceId: workspace.workspaceId },
    };
  }
  return spec;
}

/** The rail's rows, one per workspace this person can reach. */
export function consoleContextsFrom(
  workspaces: readonly WorkspaceSummary[] | undefined,
  results: QueryResults,
): ConsoleContext[] {
  return (workspaces ?? []).map((workspace) => ({
    id: workspace.workspaceId,
    slug: workspace.slug,
    displayName: workspace.displayName,
    role: workspace.role,
    kind: workspace.kind,
    structureTemplate: workspace.structureTemplate,
    /*
      `contextToneFor`, not `contextTone`: the pinned context has no storage
      subscription behind it (see `memberOf`), and `contextTone` reads that
      silence as a missing binding and answers `warn` — a permanent amber alarm
      about somebody else's bucket, on every account's rail. The distinction is
      argued in full where the function lives.
    */
    status: contextToneFor({
      storageStatus: usable<StorageBinding | null>(
        results[`storage:${workspace.workspaceId}`],
      )?.status,
      pinned: workspace.pinned,
    }),
    meetingsFolder: workspace.meetingsFolder,
    // One rule, one place. See `hasNewActivity`.
    hasNewActivity: hasNewActivity(workspace.activityAt, workspace.activitySeenAt),
    // The leaf, not the picture: the bytes are fetched once per leaf per
    // session, just below. Putting them on this row would make every poll of
    // the console carry a megabyte per workspace.
    icon: workspace.icon,
    pinned: workspace.pinned,
  }));
}

/** The map, laid out from ids and labels only. Called inside the hook's memo. */
export function constellationFrom(graphKey: string) {
  const parsed = JSON.parse(graphKey) as [
    Array<[string, string, string, string]>,
    Array<[string, string, string]>,
  ];
  const contextInputs: ContextInput[] = parsed[0].map(([id, slug, role, kind]) => ({
    id,
    label: atName(slug),
    sub: kind === "shared" ? `shared · ${role}` : role,
    kind: contextKindFor(role, kind),
  }));
  const clientInputs: ClientInput[] = parsed[1].map(([id, contextId, label]) => ({
    id,
    label,
    contextId,
  }));
  return buildConstellation({ contexts: contextInputs, clients: clientInputs });
}

/** The Connections rows: every active grant, app wide. */
export function consoleClientsFrom(
  activeGrants: GrantSummary[],
  contexts: ConsoleContext[],
  revoke: (args: { grantId: Id<"oauthGrants"> }) => Promise<unknown>,
): ConsoleClient[] {
  const now = Date.now();

  // Every grant, not the selected context's: Connections is app level, and one
  // endpoint serves all of them. The row carries which context let the client
  // in, because that is what the grant is attached to and what Revoke acts on.
  const slugOf = new Map(contexts.map((context) => [context.id, atName(context.slug)]));

  const clients: ConsoleClient[] = activeGrants.map((grant) => ({
    id: grant.grantId,
    name: grant.clientName ?? grant.clientId,
    context: slugOf.get(grant.workspaceId) ?? "a context",
    detail: `${describeScopes(grant.scopes)} · ${lastUsedLabel(grant.lastUsedAt, now)}`,
    // Straight from the server's own answer, never derived here: `isMine` is
    // what `listGrants` compared the row against the caller, and the console
    // has no business re-deciding it from a user id it would have to be told.
    mine: grant.isMine,
    status: grantTone(grant.status, grant.lastUsedAt),
    revoke: () => {
      void revoke({ grantId: grant.grantId });
    },
  }));
  return clients;
}

/*
  Three values, not two. `binding` is `undefined` until the subscription
  answers and `null` when the answer is "no bucket", and the difference is
  the difference between a pause and an accusation — see `ConsoleData.storage`.
*/
export function consoleStorageFrom(
  binding: StorageBinding | null | undefined,
): ConsoleStorage | null | undefined {
  const storage: ConsoleStorage | null | undefined =
    binding === undefined
      ? undefined
      : binding === null
        ? null
        : {
          connected: binding.status === "connected",
          status: binding.status,
          provider: binding.provider,
          bucket: binding.bucket,
          endpoint: binding.endpoint,
          region: binding.region,
          rootPrefix: binding.rootPrefix,
          accessKey: binding.maskedAccessKeyId,
          dropboxAccountId: binding.dropboxAccountId,
          conditionalWrite: binding.capabilities.conditionalWrite,
          noteCount: binding.noteCount,
          noteCountedAt: binding.noteCountedAt,
          noteCountTruncated: binding.noteCountTruncated,
          scaffoldReason: binding.scaffoldReason,
          layoutState: binding.storageLayoutState,
          layoutStateAt: binding.storageLayoutAt,
          /*
            Asked *and* answered by the question we still stand behind. The
            probe before this one looked only for a migration state file, so a
            bucket we scaffolded ourselves answered "nobody has run it" and
            every new workspace was offered the update on its first load. Those
            rows are still out there; the predicate is what gets them re-asked
            rather than believed.
          */
          layoutChecked: storageLayoutAnswerIsCurrent(binding),
          forcePathStyle: binding.forcePathStyle,
          // `objectCount`, `paraPresent` and `versioningOn` are deliberately
          // not set. Nothing has counted this bucket, looked for PARA folders,
          // or read its versioning setting, so the pane draws no row for any of
          // them rather than a plausible one. See `ConsoleStorage`.
          lastError: binding.lastError,
          errorCode: binding.errorCode,
          updatedAt: binding.updatedAt,
          lastVerifiedAt: binding.lastVerifiedAt,
          managed: binding.managed,
        };
  return storage;
}

/** The selected context's Google accounts, or none. */
export function googleConnectionsFrom(
  selectedContextId: Id<"workspaces"> | null,
  results: QueryResults,
): GoogleConnection[] {
  const googleConnections: GoogleConnection[] =
    selectedContextId === null
      ? []
      : (
          usable<GoogleConnectionSummary[]>(
            results[`google:${selectedContextId}`],
          ) ?? []
        ).map((connection) => ({
          connectionId: connection.connectionId,
          email: connection.email,
          syncServices: connection.syncServices,
          syncStatus: connection.syncStatus,
          sync: connection.sync,
          lastSyncStartedAt: connection.lastSyncStartedAt,
          lastSyncCompletedAt: connection.lastSyncCompletedAt,
          errorCode: connection.errorCode,
          lastError: connection.lastError,
          gmail: connection.gmail,
          calendar: connection.calendar,
          chat: connection.chat,
          syncRun: connection.syncRun,
        }));
  return googleConnections;
}

/** The owner-only storage controls, as the hook holds them for this render. */
export interface StorageMutations {
  reverifyStorage: ReactMutation<typeof api.functions.storage.reverifyStorage>;
  bindStorage: ReactAction<typeof api.functions.storage.bindStorage>;
  disconnectStorage: ReactMutation<typeof api.functions.storage.disconnectStorage>;
  observeStorageLayout: ReactMutation<typeof api.functions.storage.observeStorageLayout>;
}

// `bindStorage`, `reverifyStorage` and `disconnectStorage` are all owner-only
// on the backend, so the whole object is absent for anyone else rather than
// present-and-disabled. A control that is never offered cannot mislead; a
// disabled one that an editor could reasonably expect to work does.
export function storageActionsFor(
  selectedContextId: Id<"workspaces"> | null,
  isOwner: boolean,
  { reverifyStorage, bindStorage, disconnectStorage, observeStorageLayout }: StorageMutations,
): StorageActions | undefined {
  const storageActions: StorageActions | undefined =
    selectedContextId === null || !isOwner
      ? undefined
      : {
          workspaceId: selectedContextId,
          reverify: () => reverifyStorage({ workspaceId: selectedContextId }),
          connect: async (values) => {
            const args = toBindStorageArgs(values, selectedContextId);
            return await bindStorage({
              ...args,
              workspaceId: selectedContextId,
              provider: args.provider as Provider,
            });
          },
          disconnect: () => disconnectStorage({ workspaceId: selectedContextId }),
          /*
            Not a control anybody presses. It is the console asking the bucket
            where the storage-layout migration got to, so an already-migrated
            context stops being offered it — see
            `storage/StorageMigration.tsx`. Owner-only with the rest of this
            object because the backend is: it spends the workspace's request
            budget against the workspace's bucket.
          */
          observeLayout: () => observeStorageLayout({ workspaceId: selectedContextId }),
        };
  return storageActions;
}
