import { useCallback, useMemo, useState } from "react";
import {
  useAction,
  useMutation,
  useQueries,
  useQuery,
  type RequestForQueries,
} from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import {
  MCP_ENDPOINT,
  PLACEHOLDER_BYTES_TOTAL,
  PLACEHOLDER_NOTE_TOTAL,
  PLACEHOLDER_OBJECT_COUNT,
  PLACEHOLDER_PARA_PRESENT,
  PLACEHOLDER_VERSIONING_ON,
  placeholderIngestionAddress,
} from "./placeholderData";
import { useFileBrowser } from "./files/useFileBrowser";
import { useMembers } from "./members/useMembers";
import { toBindStorageArgs, type Provider } from "./storage/connect";
import { atName, contextTone, describeScopes, formatCount, grantTone, lastUsedLabel } from "./format";
import {
  buildConstellation,
  contextKindFor,
  type ClientInput,
  type ContextInput,
} from "./map/graph";
import type {
  ConsoleClient,
  ConsoleContext,
  ConsoleData,
  ConsoleStorage,
  StorageActions,
} from "./types";

/**
 * The live console.
 *
 * Reads every fact the control plane can honestly answer and fills the rest
 * from `placeholderData.ts`.
 *
 * The folder tree and the note itself are no longer among the placeholders:
 * they come from `useFileBrowser`, which reads the customer's bucket through
 * the actions in `apps/convex/functions/files.ts`. Note content passes through
 * an action and is returned; it is never stored in the control plane, which is
 * the same rule that made a *cached* tree impossible. The note and byte totals
 * remain placeholders because nothing counts a whole bucket yet.
 */

interface WorkspaceSummary {
  workspaceId: Id<"workspaces">;
  slug: string;
  displayName: string;
  kind: string;
  role: string;
}

interface StorageBinding {
  provider: string;
  endpoint: string;
  region: string;
  bucket: string;
  rootPrefix?: string;
  maskedAccessKeyId: string;
  forcePathStyle?: boolean;
  capabilities: { conditionalWrite: boolean };
  status: string;
  lastVerifiedAt?: number;
  lastError?: string;
  /** From the closed set in `functions/provisioning.ts`. See `storage/errors.ts`. */
  errorCode?: string;
  /**
   * Load-bearing for Re-verify: the probe is queued, not awaited, so the pane
   * watches this field to know its outcome landed. See `storage/reverify.ts`.
   */
  updatedAt: number;
}

interface GrantSummary {
  grantId: Id<"oauthGrants">;
  workspaceId: Id<"workspaces">;
  clientId: string;
  clientName?: string;
  scopes: string[];
  status: string;
  lastUsedAt?: number;
}

/** Convex hands back `undefined` while loading and an `Error` when a query throws. */
function usable<T>(value: unknown): T | undefined {
  if (value === undefined || value instanceof Error) return undefined;
  return value as T;
}

export function useLiveConsoleData(): ConsoleData {
  const workspaces = useQuery(api.functions.workspaces.listMyWorkspaces) as
    | WorkspaceSummary[]
    | undefined;

  const [explicitContextId, setExplicitContextId] = useState<Id<"workspaces"> | null>(null);

  const selectContext = useCallback(
    (id: string) => setExplicitContextId(id as Id<"workspaces">),
    [],
  );

  // One subscription per workspace, keyed by id. `useQueries` is what makes a
  // variable-length fan-out legal: a `useQuery` in a loop would break the rules
  // of hooks the moment a context is added or removed.
  const queries = useMemo<RequestForQueries>(() => {
    const spec: RequestForQueries = {};
    for (const workspace of workspaces ?? []) {
      spec[`grants:${workspace.workspaceId}`] = {
        query: api.functions.grants.listGrants,
        args: { workspaceId: workspace.workspaceId },
      };
      spec[`storage:${workspace.workspaceId}`] = {
        query: api.functions.storage.getStorageBinding,
        args: { workspaceId: workspace.workspaceId },
      };
    }
    return spec;
  }, [workspaces]);

  const results = useQueries(queries);
  const revoke = useMutation(api.functions.grants.revokeGrant);
  const bindStorage = useAction(api.functions.storage.bindStorage);
  const reverifyStorage = useMutation(api.functions.storage.reverifyStorage);
  const disconnectStorage = useMutation(api.functions.storage.disconnectStorage);

  // An authenticated session resolves to a *set* of contexts. Default to the
  // first rather than assuming there is exactly one — and drop an explicit
  // selection that no longer exists rather than rendering an empty console.
  const selectedContextId: Id<"workspaces"> | null =
    explicitContextId !== null &&
    (workspaces ?? []).some((w) => w.workspaceId === explicitContextId)
      ? explicitContextId
      : (workspaces?.[0]?.workspaceId ?? null);

  const contexts: ConsoleContext[] = (workspaces ?? []).map((workspace) => ({
    id: workspace.workspaceId,
    slug: workspace.slug,
    displayName: workspace.displayName,
    role: workspace.role,
    kind: workspace.kind,
    status: contextTone(
      usable<StorageBinding | null>(results[`storage:${workspace.workspaceId}`])?.status,
    ),
  }));

  const activeGrants: GrantSummary[] = (workspaces ?? []).flatMap((workspace) =>
    (usable<GrantSummary[]>(results[`grants:${workspace.workspaceId}`]) ?? []).filter(
      (grant) => grant.status === "active",
    ),
  );

  // The map is laid out from ids and labels only, so it should not be recomputed
  // when an unrelated field (a `lastUsedAt` tick) changes.
  const graphKey = JSON.stringify([
    (workspaces ?? []).map((w) => [w.workspaceId, w.slug, w.role, w.kind]),
    activeGrants.map((g) => [g.grantId, g.workspaceId, g.clientName ?? g.clientId]),
  ]);

  const graph = useMemo(() => {
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
  }, [graphKey]);

  const selectedGrants =
    selectedContextId === null
      ? []
      : activeGrants.filter((grant) => grant.workspaceId === selectedContextId);

  const now = Date.now();

  const clients: ConsoleClient[] = selectedGrants.map((grant) => ({
    id: grant.grantId,
    name: grant.clientName ?? grant.clientId,
    detail: `${describeScopes(grant.scopes)} · ${lastUsedLabel(grant.lastUsedAt, now)}`,
    status: grantTone(grant.status, grant.lastUsedAt),
    revoke: () => {
      void revoke({ grantId: grant.grantId });
    },
  }));

  const binding =
    selectedContextId === null
      ? undefined
      : usable<StorageBinding | null>(results[`storage:${selectedContextId}`]);

  const storage: ConsoleStorage | null =
    binding === undefined || binding === null
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
          conditionalWrite: binding.capabilities.conditionalWrite,
          forcePathStyle: binding.forcePathStyle,
          objectCount: PLACEHOLDER_OBJECT_COUNT,
          paraPresent: PLACEHOLDER_PARA_PRESENT,
          versioningOn: PLACEHOLDER_VERSIONING_ON,
          lastError: binding.lastError,
          errorCode: binding.errorCode,
          updatedAt: binding.updatedAt,
          lastVerifiedAt: binding.lastVerifiedAt,
        };

  const selected = contexts.find((c) => c.id === selectedContextId) ?? null;

  // Read access and write access are different grants (CLAUDE.md, "The
  // workspace model"), so a `member` gets a console with no Save button rather
  // than one whose every save is refused.
  const canEdit = selected !== null && (selected.role === "owner" || selected.role === "editor");

  // `bindStorage`, `reverifyStorage` and `disconnectStorage` are all owner-only
  // on the backend, so the whole object is absent for anyone else rather than
  // present-and-disabled. A control that is never offered cannot mislead; a
  // disabled one that an editor could reasonably expect to work does.
  const storageActions: StorageActions | undefined =
    selectedContextId === null || selected?.role !== "owner"
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
        };

  const members = useMembers({
    workspaceId: selectedContextId,
    role: selected?.role,
  });

  const files = useFileBrowser({
    workspaceId: selectedContextId,
    canEdit,
    readOnlyReason:
      selected === null
        ? undefined
        : "You have read-only access to this context. Ask an owner for editor access to change anything.",
  });

  return {
    demo: false,
    avatarInitial: (selected?.slug ?? "?").slice(0, 1).toUpperCase(),
    contexts,
    selectedContextId,
    selectContext,
    graph,
    stats: [
      { value: formatCount(contexts.length), label: "contexts reachable" },
      { value: formatCount(activeGrants.length), label: "AI clients connected" },
      // Placeholders: only the gateway can see inside the customer's bucket.
      { value: PLACEHOLDER_NOTE_TOTAL, label: "notes across all" },
      { value: PLACEHOLDER_BYTES_TOTAL, label: "in your own bucket" },
    ],
    clients,
    storage,
    storageActions,
    endpoint: MCP_ENDPOINT,
    ingestionAddress: placeholderIngestionAddress(selected?.slug ?? "you"),
    files,
    members,
    loading: workspaces === undefined,
  };
}
