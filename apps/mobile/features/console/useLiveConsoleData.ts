import { useCallback, useEffect, useMemo, useState } from "react";
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
import { prefetchWorkspacePhotos } from "./useWorkspaceIcons";
import { capabilitiesForRole } from "./capabilities";
import { totalNotes } from "./noteTotals";
import { useRememberedContexts } from "../offline/useRememberedContexts";
import { defaultContext } from "./nav";
import {
  type ConsoleClient,
  type ConsoleContext,
  type ConsoleData,
  type ConsoleStorage,
  type StorageActions,
} from "./types";
import type { GoogleConnection } from "./google/GoogleConnectionsCard";
import { setObservabilityUser } from "../observability/client";
import { useOrganizer } from "../organizer/useOrganizer";
import {
  memberOf,
  usable,
  type GrantSummary,
  type StorageBinding,
  type WorkspaceSummary,
} from "./liveConsole/summaries";
import {
  consoleClientsFrom,
  consoleContextsFrom,
  consoleStats,
  consoleStorageFrom,
  constellationFrom,
  googleConnectionsFrom,
  perWorkspaceQueries,
  storageActionsFor,
} from "./liveConsole/derive";
import { useContextSurfaces } from "./liveConsole/useContextSurfaces";
import { useOfflineUpkeep } from "./liveConsole/useOfflineUpkeep";
import { accountActionsFor } from "./liveConsole/accountActions";

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
      // Which contexts a blended search will reach. It rides in the
      // same spec for the reason `listMyInvitations` does — Convex dedupes
      // identical subscriptions, so the search page subscribing to it as well
      // is not a second round trip — and it is here rather than on the page
      // because the *navigation* needs it: "Search" is drawn only where
      // something would answer it. A failure is `undefined`, which draws the
      // row, which is the same direction `SearchableContextCount` argues for.
      searchable: { query: api.functions.fastSearch.searchableContexts, args: {} },
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
  /*
    The live list, or the one this device remembers when there is no network to
    ask and nothing has landed.

    `useRememberedContexts` carries the whole argument for when a memory may
    stand in for an answer — and the cast is the one place a remembered row
    becomes a `WorkspaceSummary` again. It is safe because the row was written
    from this exact type on a load that did land: `workspaceId` is the string a
    `Id<"workspaces">` already is, and every consumer below uses it as an
    argument or a key rather than as proof of anything. The proof is the
    server's, and offline there is nothing to prove to — a remembered id that
    was somehow wrong reaches a bucket read that refuses it, which is the
    direction this whole feature is allowed to be wrong in.
  */
  const liveWorkspaces = usable<WorkspaceSummary[]>(workspacesResult);
  const workspaces = useRememberedContexts(liveWorkspaces) as WorkspaceSummary[] | undefined;
  // `fastSearch.searchableContexts` answers `{ contexts }` (see
  // `apps/convex/functions/fastSearch.ts`); this reader only ever wanted how
  // many there are. That is now every context the person belongs to rather
  // than the fast-search ones, which is the honest condition for drawing a
  // Search row: the page reads whatever it is given, quickly or slowly.
  const searchableContexts = usable<{ contexts: Array<{ workspaceId: string }> }>(
    specResults.searchable,
  )?.contexts.length;
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
  const queries = useMemo<RequestForQueries>(() => perWorkspaceQueries(workspaces), [workspaces]);

  const results = useQueries(queries);
  const revoke = useMutation(api.functions.grants.revokeGrant);
  const bindStorage = useAction(api.functions.storage.bindStorage);
  /*
    The same action `useFileBrowser` holds, taken here too rather than threaded
    up through `FileBrowser`'s interface: `useAction` returns a callable, not a
    subscription, so a second handle costs nothing and widening that interface
    with a writer no view calls would. Both go through `queuedWriteSender`, so
    there is still exactly one definition of what a queued write is.
  */
  const writeNoteAction = useAction(api.functions.files.writeNote);
  const syncManifestAction = useAction(api.functions.files.syncManifest);
  const readNotesAction = useAction(api.functions.files.readNotes);
  /** The bytes behind a workspace's icon. See the prefetch below for why here. */
  const workspaceIconPhotoAction = useAction(api.functions.files.workspaceIconPhoto);
  const reverifyStorage = useMutation(api.functions.storage.reverifyStorage);
  const observeStorageLayout = useMutation(
    api.functions.storage.observeStorageLayout,
  );
  const disconnectStorage = useMutation(api.functions.storage.disconnectStorage);
  const disconnectGoogle = useMutation(
    api.functions.googleConnect.disconnectGoogleConnection,
  );
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

  const contexts: ConsoleContext[] = consoleContextsFrom(workspaces, results);

  /*
    THE ONE PLACE A WORKSPACE ICON PHOTO IS FETCHED.

    Here rather than in the components that draw it, and that is not tidiness:
    `useAction` throws outside a `ConvexProvider`, and the mark is also drawn by
    the landing page's picture of the console and by the demo console, neither
    of which has a backend. A drawing surface that needed a Convex client would
    be a marketing page that crashes.

    This hook is the one that runs the queries, so the client is guaranteed
    here by construction. `prefetchWorkspacePhotos` fills a module-scope cache
    that `useWorkspaceIcons` reads without importing anything from Convex, and
    a surface with no backend simply never fills it — which is right, because it
    has no real workspace to ask about.

    Called from an effect keyed on the leaves rather than on the array: the
    console re-renders on every poll, and the prefetch itself is idempotent, but
    re-entering it several times a second to do nothing is still a cost worth
    not paying.
  */
  const iconLeaves = contexts
    .flatMap((context) => (context.icon?.kind === "photo" ? [`${context.id}|${context.icon.leaf}`] : []))
    .sort()
    .join(",");
  useEffect(() => {
    if (iconLeaves === "") return;
    prefetchWorkspacePhotos(contexts, (args) =>
      workspaceIconPhotoAction({ workspaceId: args.workspaceId as Id<"workspaces"> }),
    );
    // `contexts` is rebuilt on every render; `iconLeaves` is what actually
    // changes when there is a new photo to fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iconLeaves, workspaceIconPhotoAction]);

  // One entry per reachable context, and all three cases kept apart: the
  // binding, `null` for a context with no bucket, `undefined` for one whose
  // query has not landed or has errored. `?? null` here read every
  // still-loading context as bucketless, so the first paint printed an exact
  // total missing a whole bucket's notes. See `noteTotals.ts`.
  const notes = totalNotes(
    // Contexts this person is in. Counting our notes into somebody's own total
    // would be wrong twice over: they are not theirs, and the console has no
    // binding subscription for that row to count them from.
    memberOf(workspaces).map((workspace) => {
      const result = results[`storage:${workspace.workspaceId}`];
      if (result === undefined || result instanceof Error) return undefined;
      return (result as StorageBinding | null) ?? null;
    }),
  );

  const activeGrants: GrantSummary[] = memberOf(workspaces).flatMap((workspace) =>
    (usable<GrantSummary[]>(results[`grants:${workspace.workspaceId}`]) ?? []).filter(
      (grant) => grant.status === "active",
    ),
  );

  // The map is laid out from ids and labels only, so it should not be recomputed
  // when an unrelated field (a `lastUsedAt` tick) changes.
  const graphKey = JSON.stringify([
    /*
      The map is this person's own estate — their contexts and the clients
      connected to them — so the pinned context is not a node on it. Drawing one
      would put a workspace with none of their clients attached in the middle of
      a picture whose whole subject is what they have connected where.
    */
    memberOf(workspaces).map((w) => [w.workspaceId, w.slug, w.role, w.kind]),
    activeGrants.map((g) => [g.grantId, g.workspaceId, g.clientName ?? g.clientId]),
  ]);

  const graph = useMemo(() => constellationFrom(graphKey), [graphKey]);

  const clients: ConsoleClient[] = consoleClientsFrom(activeGrants, contexts, revoke);

  const binding =
    selectedContextId === null
      ? undefined
      : usable<StorageBinding | null>(results[`storage:${selectedContextId}`]);

  const storage: ConsoleStorage | null | undefined = consoleStorageFrom(binding);

  const selected = contexts.find((c) => c.id === selectedContextId) ?? null;

  /*
    The selected context, for everything that needs a membership row behind it.

    `null` for the pinned context, which every account reaches and nobody
    joined, and `null` is the value every one of these hooks already skips on —
    it is what they see when nothing is selected at all. So one derivation turns
    off the member list, fast-search status, the plugin inventory and switches,
    plugin grants and lifecycle, shares, groups, the advanced pane, ingestion
    and the plugin runtime, all of which go through `requireWorkspaceAccess` and
    would answer `WORKSPACE_NOT_FOUND` for a pinned reader.

    **`useFileBrowser` deliberately keeps the real id.** Reading notes is the
    one thing the pin opens — `authorizeFileAccess` grants it at `member`,
    `team` — and it is the only reason to have the context in the list at all.

    One lever rather than a `pinned` argument threaded through eleven hooks: a
    hook that needs the row and was not told about the flag is a failing
    subscription nobody notices, because `usable()` turns a failed query into
    `undefined` and every one of these renders `undefined` as "still loading".
  */
  const membershipContextId: Id<"workspaces"> | null =
    selected?.pinned === true ? null : selectedContextId;
  /**
   * Whether the selected context has a model key. `undefined` until answered.
   *
   * `usable` answers `undefined` for a query that has not landed *and* for one
   * that failed, which is the right reading for both here: a console that
   * cannot ask offers no conversation rather than an offer that errors.
   */
  const modelConnected: boolean | undefined =
    selectedContextId === null
      ? undefined
      : (() => {
          const answer = usable<{ provider: string }[]>(
            results[`providers:${selectedContextId}`],
          );
          return answer === undefined ? undefined : answer.length > 0;
        })();

  const googleConnections: GoogleConnection[] = googleConnectionsFrom(selectedContextId, results);

  // Read access and write access are different grants (CLAUDE.md, "The
  // workspace model"), so a `member` gets a console with no Save button rather
  // than one whose every save is refused.
  //
  // Derived in `capabilities.ts` rather than here, and every site below reads
  // it from there. Inline, the two expressions were unreachable by any test —
  // mutating `canEdit` to accept any role, and `isOwner` to a constant `true`,
  // each passed the entire suite.
  const { canEdit, isOwner } = capabilitiesForRole(selected?.role);

  const storageActions: StorageActions | undefined = storageActionsFor(selectedContextId, isOwner, {
    reverifyStorage,
    bindStorage,
    disconnectStorage,
    observeStorageLayout,
  });

  const {
    ingestion,
    members,
    activity,
    agents,
    fastSearch,
    plugins,
    contextPlugins,
    pluginGrants,
    managedInstalls,
    pluginBrowse,
    shares,
    groups,
    advanced,
    files,
    viewer,
    pluginRuntime,
  } = useContextSurfaces({
    membershipContextId,
    selectedContextId,
    selected,
    contexts,
    canEdit,
    isOwner,
    storage,
  });

  const mirrors = useOfflineUpkeep({
    writeNoteAction,
    syncManifestAction,
    readNotesAction,
    selectedContextId,
    liveWorkspaces,
  });

  // Auto-organize for this workspace — status, suggestions, and the presses on them.
  const organizer = useOrganizer({ workspaceId: membershipContextId, slug: selected?.slug ?? "" });

  const viewerUserId = members.members.find((member) => member.isMe)?.userId;
  useEffect(() => {
    if (viewerUserId === undefined) return;
    setObservabilityUser(viewerUserId);
  }, [viewerUserId]);

  return {
    demo: false,
    viewer,
    contexts,
    invitations,
    selectedContextId,
    selectContext,
    activity,
    agents,
    organizer,
    searchableContexts,
    graph,
    ...accountActionsFor({ leaveWorkspace, deleteAccountMutation, authActions }),
    stats: consoleStats(workspaces, notes, contexts, activeGrants),
    clients,
    storage,
    storageActions,
    googleConnections,
    modelConnected,
    googleActions:
      selectedContextId === null || !isOwner || selected?.kind !== "personal"
        ? undefined
        : {
            workspaceId: selectedContextId,
            disconnect: (connectionId: string) =>
              disconnectGoogle({
                workspaceId: selectedContextId,
                connectionId: connectionId as Id<"googleConnections">,
              }),
          },
    endpoint: MCP_ENDPOINT,
    ingestionAddress:
      ingestion.settings?.address ?? placeholderIngestionAddress(selected?.slug ?? "you"),
    ingestion,
    files,
    members,
    shares,
    groups,
    advanced,
    plugins,
    contextPlugins,
    pluginInstalls: managedInstalls,
    pluginGrants,
    pluginBrowse,
    pluginRuntime,
    fastSearch,
    mirrors,
    // A query that threw is not "still loading". Leaving the console spinning
    // forever on an answer that already arrived — and is an error — is the
    // quieter version of the blank page this replaced.
    loading: workspaces === undefined && failure === null,
    failure,
  };
}
