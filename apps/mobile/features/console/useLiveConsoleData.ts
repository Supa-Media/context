import { useCallback, useMemo, useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import {
  useAction,
  useMutation,
  useQueries,
  type RequestForQueries,
} from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { MCP_ENDPOINT, placeholderIngestionAddress } from "./placeholderData";
import { describeQueryFailure } from "./failure";
import { EMPTY_QUERY_SPEC } from "./querySpec";
import { useFileBrowser } from "./files/useFileBrowser";
import { ingestionAvailabilityFor } from "./ingestion/settings";
import { capabilitiesForRole } from "./capabilities";
import { visibilityTierForRole } from "./visibility";
import { useIngestionSettings } from "./ingestion/useIngestionSettings";
import { useMembers } from "./members/useMembers";
import { toBindStorageArgs, type Provider } from "./storage/connect";
import { atName, contextTone, describeScopes, formatCount, grantTone, lastUsedLabel } from "./format";
import { ownPersonalContext, viewerIdentity } from "./identity";
import { formatNotesTotal, totalNotes } from "./noteTotals";
import { forgetContextCopies, forgetLocalCopies } from "../offline/forget";
import { defaultContext } from "./nav";
import {
  buildConstellation,
  contextKindFor,
  type ClientInput,
  type ContextInput,
} from "./map/graph";
import {
  type ConsoleClient,
  type ConsoleContext,
  type ConsoleData,
  type ConsoleStorage,
  type StorageActions,
} from "./types";

/**
 * The live console.
 *
 * Reads every fact the control plane can honestly answer, and **says nothing at
 * all** about the rest. There is no import of an invented value in this file
 * and there must never be one again: everything a signed-in person reads here
 * is either derived from Convex or absent.
 *
 * That is the fix for #20 and #25, which were the same bug on two surfaces —
 * a bucket's object count, its PARA structure, its versioning state, and the
 * note and byte totals were all constants from `placeholderData.ts`, drawn as
 * verified facts about somebody's own storage. They could not be made true
 * here; they could only stop being asserted, until something actually looked.
 *
 * **"notes across all" is the first of them to come back**, on exactly the terms
 * that file described: the verification probe now walks the bucket and persists
 * what it counted, so the tile reads a field on the binding rather than a
 * constant. Everything the probe still does not measure — bytes, PARA presence,
 * versioning — stays absent. See `functions/lib/noteCount.ts` for the walk and
 * `./noteTotals.ts` for why the total can be a floor.
 *
 * The folder tree and the note itself were never placeholders: they come from
 * `useFileBrowser`, which reads the customer's bucket through the actions in
 * `apps/convex/functions/files.ts`. Note content passes through an action and
 * is returned; it is never stored in the control plane, which is the same rule
 * that made a *cached* tree impossible.
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
  /**
   * Optional, because a Dropbox binding has none of them — see the validator
   * on `getStorageBinding`. `maskedAccessKeyId` in particular is `undefined`
   * rather than an empty string, so that the console renders nothing instead
   * of a masked credential that does not exist.
   */
  endpoint?: string;
  region?: string;
  bucket?: string;
  rootPrefix?: string;
  maskedAccessKeyId?: string;
  forcePathStyle?: boolean;
  capabilities: { conditionalWrite: boolean };
  status: string;
  lastVerifiedAt?: number;
  lastError?: string;
  /** From the closed set in `functions/provisioning.ts`. See `storage/errors.ts`. */
  errorCode?: string;
  /**
   * What the last walk of this bucket counted, and whether it reached the end.
   *
   * All absent until a verification has looked — which is the state a brand-new
   * binding is in, and the state a binding whose probe failed stays in. Absent
   * is not zero, and `noteTotals.ts` is where that distinction is kept.
   */
  noteCount?: number;
  noteCountedAt?: number;
  noteCountTruncated?: boolean;
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
  /**
   * Whether the row is the caller's own client, decided by the server.
   *
   * A context's `owner` is the only role shown anybody else's grants, so this
   * is `true` on every row for everybody else — and it is the server's answer
   * rather than a comparison made here, because the alternative is this file
   * being told a user id in order to re-derive something it was already sent.
   */
  isMine: boolean;
  lastUsedAt?: number;
}

/**
 * Convex hands back `undefined` while loading and an `Error` when a query threw.
 *
 * **Only true of `useQueries`.** `useQuery` re-throws a failed query during
 * render before any caller can look at it, so this guard is live code here and
 * would be dead code beside a `useQuery`. That is exactly what it was until the
 * subscriptions in this file moved across: see `./failure.ts`.
 */
function usable<T>(value: unknown): T | undefined {
  if (value === undefined || value instanceof Error) return undefined;
  return value as T;
}

export function useLiveConsoleData(): ConsoleData {
  // `useQueries`, not `useQuery`, and this is the whole point of the exercise.
  // `listMyWorkspaces` is the query the console cannot render without, and a
  // `useQuery` re-throws a failure *during render* — with no boundary above it
  // that unmounted the entire console to a blank dark page, silently. Here the
  // error arrives as a value and becomes `failure` below: a screen with words
  // on it and a way out.
  //
  // The spec depends on nothing, so it is stable forever, and the `api`
  // reference is reached for *inside* the memo — `api` is a proxy that mints a
  // new object on every property access, and one in a dependency array is what
  // makes `useSubscription` set state during render. See `./querySpec.ts`.
  //
  // `listMyInvitations` rides along in the same spec for the reason the `(app)`
  // layout gives about its own copy: Convex dedupes identical subscriptions, so
  // this is not a second round trip. The console needs it so that a note link
  // into a context somebody was *invited* to sends them to the invitation
  // rather than to the map — see `resolveContextRoute`.
  const workspacesSpec = useMemo<RequestForQueries>(
    () => ({
      workspaces: { query: api.functions.workspaces.listMyWorkspaces, args: {} },
      invitations: { query: api.functions.invitations.listMyInvitations, args: {} },
    }),
    [],
  );
  const specResults = useQueries(workspacesSpec);
  const workspacesResult = specResults.workspaces;
  /**
   * `undefined` while in flight, and deliberately not `[]`.
   *
   * A failed invitation query is also `undefined` here: the console renders
   * perfectly well without it, and the only consequence is that an invited
   * person following a note link lands on the map — the behaviour that existed
   * before this list did. It must never take the console down.
   */
  const invitations = usable<Array<{ slug: string; token: string }>>(
    specResults.invitations,
  );
  const workspaces = usable<WorkspaceSummary[]>(workspacesResult);
  const failure =
    workspacesResult instanceof Error
      ? describeQueryFailure(workspacesResult, "your context")
      : null;

  const [explicitContextId, setExplicitContextId] = useState<Id<"workspaces"> | null>(null);

  const selectContext = useCallback(
    (id: string) => setExplicitContextId(id as Id<"workspaces">),
    [],
  );

  // One subscription per workspace, keyed by id. `useQueries` is what makes a
  // variable-length fan-out legal: a `useQuery` in a loop would break the rules
  // of hooks the moment a context is added or removed.
  //
  // The dependency list is `[workspaces]` and must stay that way — a value from
  // `useQuery`, which is referentially stable between data changes. It must
  // never gain an `api.…` entry: those are fresh proxies on every access, and
  // an unstable `useQueries` spec renders the console as a blank white page.
  // See `./querySpec.ts` for the full chain.
  const queries = useMemo<RequestForQueries>(() => {
    // An account with no contexts subscribes to nothing, and says so with the
    // shared constant rather than a fresh `{}`.
    if ((workspaces ?? []).length === 0) return EMPTY_QUERY_SPEC;
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
  const leaveWorkspace = useMutation(api.functions.workspaces.leaveWorkspace);
  const deleteAccountMutation = useMutation(api.functions.account.deleteAccount);
  // Not destructured: the context is undefined in test harnesses that
  // mount this hook without ConvexAuthProvider, and the account block owns
  // ordinary sign-out anyway — this reference exists only for deletion.
  const authActions = useAuthActions();

  // An authenticated session resolves to a *set* of contexts, never to one, and
  // an explicit selection that no longer exists is dropped rather than
  // rendering an empty console. With no explicit choice, `defaultContext`
  // prefers a context you own — "the first of the list" opened somebody else's,
  // which greets a person with a filtered view of a place they visit. It is
  // `nav.ts`'s because the *URL* answers the same question through
  // `landingHref`, and a rule with two implementations here would be a rule the
  // redirect quietly overrides.
  const selectedContextId: Id<"workspaces"> | null =
    explicitContextId !== null &&
    (workspaces ?? []).some((w) => w.workspaceId === explicitContextId)
      ? explicitContextId
      : (defaultContext(workspaces ?? [])?.workspaceId ?? null);

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

  // One entry per reachable context, and all three cases kept apart: the
  // binding, `null` for a context with no bucket, `undefined` for one whose
  // query has not landed or has errored. `?? null` here read every
  // still-loading context as bucketless, so the first paint printed an exact
  // total missing a whole bucket's notes. See `noteTotals.ts`.
  const notes = totalNotes(
    (workspaces ?? []).map((workspace) => {
      const result = results[`storage:${workspace.workspaceId}`];
      if (result === undefined || result instanceof Error) return undefined;
      return (result as StorageBinding | null) ?? null;
    }),
  );

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

  const binding =
    selectedContextId === null
      ? undefined
      : usable<StorageBinding | null>(results[`storage:${selectedContextId}`]);

  /*
    Three values, not two. `binding` is `undefined` until the subscription
    answers and `null` when the answer is "no bucket", and the difference is
    the difference between a pause and an accusation — see `ConsoleData.storage`.
  */
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
          conditionalWrite: binding.capabilities.conditionalWrite,
          noteCount: binding.noteCount,
          noteCountedAt: binding.noteCountedAt,
          noteCountTruncated: binding.noteCountTruncated,
          forcePathStyle: binding.forcePathStyle,
          // `objectCount`, `paraPresent` and `versioningOn` are deliberately
          // not set. Nothing has counted this bucket, looked for PARA folders,
          // or read its versioning setting, so the pane draws no row for any of
          // them rather than a plausible one. See `ConsoleStorage`.
          lastError: binding.lastError,
          errorCode: binding.errorCode,
          updatedAt: binding.updatedAt,
          lastVerifiedAt: binding.lastVerifiedAt,
        };

  const selected = contexts.find((c) => c.id === selectedContextId) ?? null;

  // Read access and write access are different grants (CLAUDE.md, "The
  // workspace model"), so a `member` gets a console with no Save button rather
  // than one whose every save is refused.
  //
  // Derived in `capabilities.ts` rather than here, and every site below reads
  // it from there. Inline, the two expressions were unreachable by any test —
  // mutating `canEdit` to accept any role, and `isOwner` to a constant `true`,
  // each passed the entire suite.
  const { canEdit, isOwner } = capabilitiesForRole(selected?.role);

  // `bindStorage`, `reverifyStorage` and `disconnectStorage` are all owner-only
  // on the backend, so the whole object is absent for anyone else rather than
  // present-and-disabled. A control that is never offered cannot mislead; a
  // disabled one that an editor could reasonably expect to work does.
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
        };

  // Same owner-only rule as the storage binding, and one rule beyond it: only a
  // personal context has a capture address at all, so a shared one is handed a
  // state that says so rather than a form for an inbox it does not have.
  const ingestion = useIngestionSettings({
    workspaceId: selectedContextId,
    availability: ingestionAvailabilityFor(selected?.kind),
    canEdit: isOwner,
  });

  const members = useMembers({
    workspaceId: selectedContextId,
    role: selected?.role,
  });

  const files = useFileBrowser({
    slug: selected?.slug,
    workspaceId: selectedContextId,
    canEdit,
    // The clearance every server read for this person is already filtered by,
    // handed down so a copy on the device is filed under it too. Derived here
    // and nowhere else: `visibilityTierForRole` is this app's single answer to
    // the question, and a second derivation inside the offline layer would be
    // a second answer that can disagree with the one on screen.
    tier: visibilityTierForRole(selected?.role),
    // Not `canEdit`: an `editor` may write notes and may not rewrite the access
    // map that decides which notes they can see at all. Same rule as
    // `storageActions`, and the same reason — the control is absent rather than
    // present and refused.
    isOwner,
    readOnlyReason:
      selected === null
        ? undefined
        : "You have read-only access to this context. Ask an owner for editor access to change anything.",
    // From the connect-time probe, through the binding query this hook already
    // subscribes to. A second subscription would be a second answer that could
    // disagree with the one the settings pane and the status bar draw from.
    conditionalWrite: storage?.conditionalWrite,
  });

  // The viewer, not the viewed. The avatar and the account block used to take
  // the *selected* context's slug, so clicking into a shared context renamed
  // the signed-in person after it — top, bottom, everywhere. `identity.ts` is
  // where the rules live; the inputs here are the only Convex-shaped parts:
  // the real issued address is used only when the selected context *is* the
  // viewer's own personal one (that is the only case the owner-only ingestion
  // subscription answers for, and the guard keeps a second owned personal
  // context from lending its address to the first), and the email comes off
  // the selected context's member list, where the control plane already marks
  // the caller's own row.
  const own = ownPersonalContext(contexts);
  const viewer = viewerIdentity({
    contexts,
    ownAddress:
      own !== null && selected?.id === own.id ? ingestion.settings?.address : undefined,
    email: members.members.find((member) => member.isMe)?.email,
  });

  return {
    demo: false,
    viewer,
    contexts,
    invitations,
    selectedContextId,
    selectContext,
    graph,
    // Walking out of somebody else's context is the member's own move — the
    // server refuses it for owners (`OWNER_CANNOT_LEAVE`), so the rail only
    // offers it on a row whose role is not `owner`. The subscription drops it from
    // `contexts` on its own once the membership row is gone.
    // What is cached for a context you have left is a copy of somewhere you can
    // no longer reach — notes somebody shared with you, held on your machine
    // after the membership that justified holding them is gone. It is cleared
    // **on the server's answer, never on the request**: `leaveWorkspace`
    // returns `{ left: false }` for a membership row it did not find — already
    // left in another tab, or removed by the owner while this console was open
    // — and clearing on the press would throw away the offline copy of a
    // context the person still has.
    //
    // An owner is a *third* case: `leaveWorkspace` throws `OWNER_CANNOT_LEAVE`
    // rather than answering `{ left: false }`, so nothing below the `await`
    // runs at all. Same outcome, different path — and the rejection reaches the
    // rail's `void data.leaveContext?.(id)`, which has nowhere to put it. That
    // is pre-existing and is not what this line is about.
    leaveContext: async (id: string) => {
      const result = await leaveWorkspace({ workspaceId: id as Id<"workspaces"> });
      if (result.left) await forgetContextCopies(id);
      return result;
    },
    // Everything on the control plane goes; the person's own storage is not
    // ours to touch. The local sign-out afterwards clears the tokens for a
    // session whose server rows the mutation just deleted — its own signOut
    // call failing server-side is expected and swallowed by the auth client.
    deleteAccount: async () => {
      await deleteAccountMutation({});
      // After the deletion, and before the sign-out. After, because a deletion
      // that failed must not cost somebody the queue it never sent; before,
      // because the browser must not still be holding readable note text once
      // the session it belonged to is over. `forget.ts` owns the failure
      // stance — it can report, and it can never block this.
      await forgetLocalCopies();
      await authActions?.signOut();
    },
    // Three tiles, not the mockup's four. "in your own bucket" is still gone:
    // nothing measures a bucket's size, so there is no honest value to put in
    // it, and #20's fix — delete the tile rather than print a constant or a
    // permanent em dash — still stands for everything unmeasured.
    //
    // "notes across all" is back because it is measured now. It is app level
    // like the other two, summing every context this person can reach, which
    // costs nothing: the hook already subscribes to every workspace's binding
    // for the rail's status pips. The tile is absent, not zero, until something
    // has walked at least one bucket, and carries a `+` when the total is a
    // floor — see `noteTotals.ts`.
    stats: [
      ...(notes === null
        ? []
        : [{ value: formatNotesTotal(notes), label: "notes across all" }]),
      { value: formatCount(contexts.length), label: "in your context" },
      { value: formatCount(activeGrants.length), label: "AI clients connected" },
    ],
    clients,
    storage,
    storageActions,
    endpoint: MCP_ENDPOINT,
    ingestionAddress:
      ingestion.settings?.address ?? placeholderIngestionAddress(selected?.slug ?? "you"),
    ingestion,
    files,
    members,
    // A query that threw is not "still loading". Leaving the console spinning
    // forever on an answer that already arrived — and is an error — is the
    // quieter version of the blank page this replaced.
    loading: workspaces === undefined && failure === null,
    failure,
  };
}
