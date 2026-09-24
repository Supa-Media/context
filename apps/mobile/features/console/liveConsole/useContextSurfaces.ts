import { useCallback, useMemo } from "react";
import type { Id } from "@context/convex/_generated/dataModel";
import { MCP_ENDPOINT } from "../placeholderData";
import { useFileBrowser } from "../files/useFileBrowser";
import { ingestionAvailabilityFor } from "../ingestion/settings";
import { visibilityTierForRole } from "../visibility";
import { useIngestionSettings } from "../ingestion/useIngestionSettings";
import { useMembers } from "../members/useMembers";
import { useActivity } from "../activity/useActivity";
import { useAgentActivity } from "../agents/useAgentActivity";
import { useFastSearch } from "../search/useFastSearch";
import { useGroups } from "../groups/useGroups";
import { useShares } from "../shares/useShares";
import { useAdvanced } from "../advanced/useAdvanced";
import { usePlugins } from "../plugins/usePlugins";
import { useContextPlugins } from "../plugins/useContextPlugins";
import { useManagedInstalls } from "../plugins/useManagedInstalls";
import { useGrants } from "../plugins/useGrants";
import { useLifecycle } from "../plugins/useLifecycle";
import { useRuntime } from "../plugins/useRuntime";
import { atName } from "../format";
import { ownPersonalContext, viewerIdentity } from "../identity";
import type { ConsoleContext, ConsoleStorage } from "../types";

/**
 * Everything the live console shows about the selected context: its
 * per-context subscriptions, the file browser, the viewer, and the plugin
 * runtime, in the order `useLiveConsoleData` has always called them.
 *
 * A contiguous run of that hook's body, moved verbatim and called at the same
 * point, so the hooks it calls run in the same order with the same
 * dependency lists. Called only from `useLiveConsoleData`.
 */
export function useContextSurfaces({
  membershipContextId,
  selectedContextId,
  selected,
  contexts,
  canEdit,
  isOwner,
  storage,
}: {
  membershipContextId: Id<"workspaces"> | null;
  selectedContextId: Id<"workspaces"> | null;
  selected: ConsoleContext | null;
  contexts: ConsoleContext[];
  canEdit: boolean;
  isOwner: boolean;
  storage: ConsoleStorage | null | undefined;
}) {
  // Same owner-only rule as the storage binding, and one rule beyond it: only a
  // personal context has a capture address at all, so a shared one is handed a
  // state that says so rather than a form for an inbox it does not have.
  const ingestion = useIngestionSettings({
    workspaceId: membershipContextId,
    availability: ingestionAvailabilityFor(selected?.kind),
    canEdit: isOwner,
  });

  const members = useMembers({
    workspaceId: membershipContextId,
    role: selected?.role,
  });

  /*
    What has changed in this context, from `activity.md`.

    The same `membershipContextId` every other per-context subscription here
    takes, so switching contexts switches this with them rather than leaving
    one surface a frame behind — the frame where the paths on screen belong to
    the context somebody just left.
  */
  /** The viewer's own `@name`, or null for an account with no personal context. */
  const ownSlug = ownPersonalContext(contexts)?.slug ?? null;
  const ownName = ownSlug === null ? null : `@${ownSlug}`;
  const activity = useActivity(
    membershipContextId ?? null,
    // The viewer's own name, from their own personal context — the same
    // `@name` the gateway stamps on what their clients do, which is what makes
    // "was this me?" answerable at all.
    ownName,
  );

  /*
    Which notes agents are reading and writing, for the tree's squares and the
    foot's "N agents active". The same per-context id as the rest, so a
    context switch never draws one workspace's marks on another's tree.
  */
  const agents = useAgentActivity(membershipContextId ?? null, MCP_ENDPOINT);

  // Read for every member — how a context's search is served is not privileged
  // — and the switch attached only where the server said `canChange`. That is
  // the hook's own rule rather than this file's, so `isOwner` is deliberately
  // not passed: `status` answers the authorization question with the server's
  // answer, and a second one derived here could disagree with it.
  const fastSearch = useFastSearch({ workspaceId: membershipContextId });
  /*
    Owner-only, and a scan rather than a subscription — see `usePlugins`. The
    read itself takes no path argument, because the gateway's own read takes
    none: `list_plugins` cannot be aimed, which is what keeps a tool reading
    outside the privacy manifest's reach from becoming a way to read around it.
  */
  const plugins = usePlugins({ workspaceId: membershipContextId, role: selected?.role });
  /*
    The built-ins, which are not a scan and not owner-only. No `role` is passed:
    every member may see which features their context has — a member who cannot
    is a member who files "the form isn't there" as a bug — and whether they may
    work the switches comes back from the server as `canManage` rather than
    being decided twice. See `useContextPlugins`.
  */
  const contextPlugins = useContextPlugins({ workspaceId: membershipContextId });
  // A live subscription, unlike the inventory above — a Revoke pressed here has
  // to stop reading as "Approved" in the same frame. See `useGrants`.
  const pluginGrants = useGrants({ workspaceId: membershipContextId, role: selected?.role });
  /*
    `onChanged` is the inventory's own re-read. Installing or removing a plugin
    leaves the list on screen describing a bucket that no longer exists, and the
    scan is the only thing that knows the new one — so the lifecycle asks it
    rather than trying to patch rows itself.
  */
  // `withheld` and `loading` are the two states with no `read` to call: one is
  // a viewer who may not scan, the other is a scan already running.
  const rereadPlugins =
    plugins.state === "loading" || plugins.state === "withheld"
      ? undefined
      : plugins.actions?.read;
  /*
    What Context installed, read on arrival rather than on a press — see
    `useManagedInstalls` for why that is a different cost from the scan above,
    and for what the missing answer cost.
  */
  const managedInstalls = useManagedInstalls({
    workspaceId: selectedContextId,
    role: selected?.role,
  });
  /*
    Both reads follow an install, and both are needed.

    The scan is the only thing that knows whether the new plugin runs; the
    pointer read is the only one that answers at all when no scan has been run,
    which is the state a first visit is in. Refreshing only the scan would leave
    the registry still offering Install for what was just installed — the bug
    this pair exists to close.
  */
  const rereadInstalls = managedInstalls.state === "withheld" ? undefined : managedInstalls.read;
  const afterLifecycleChange = useCallback(async () => {
    await Promise.all([rereadInstalls?.(), rereadPlugins?.()]);
  }, [rereadInstalls, rereadPlugins]);
  const pluginBrowse = useLifecycle({
    workspaceId: membershipContextId,
    role: selected?.role,
    onChanged: afterLifecycleChange,
  });

  // Shared links — owner-only on the backend (`listShares`/`revokeShare`), so
  // this hook decides for itself, from `role`, whether to subscribe at all.
  // See `useShares` for why that is stricter than `useMembers`'s own gate.
  const shares = useShares({ workspaceId: membershipContextId, role: selected?.role });
  const groups = useGroups({ workspaceId: membershipContextId, role: selected?.role });

  // Both halves are owner-only in the console — see `useAdvanced` for why the
  // audit trail is stricter here than `listEvents` allows on the backend.
  const advanced = useAdvanced({
    workspaceId: membershipContextId,
    role: selected?.role,
    // For the deletion card only: a personal workspace is not deletable from a settings
    // panel, and the name is what confirms the deletion.
    kind: selected?.kind,
    slug: selected?.slug,
  });

  /*
    THE CONTEXTS SOMETHING COULD BE MOVED INTO.

    Built from the list the rail already draws rather than from a query of its
    own, and filtered on the *destination* half of the rule: a move lands as an
    ordinary write, so `editor` or `owner` there. The **source** half — owning
    the context it is leaving — is applied inside `useFileBrowser`, which is
    the one place that knows which context this browser is standing in.

    The pinned context is excluded by the role filter and would be by intent
    anyway: it is somebody else's docs, read-only, and nobody put this person
    in it.
  */
  const moveDestinations = useMemo(
    () =>
      contexts
        .filter((context) => context.role === "owner" || context.role === "editor")
        .map((context) => ({
          id: context.id,
          label: atName(context.slug),
          displayName: context.displayName,
        })),
    [contexts],
  );

  const files = useFileBrowser({
    destinations: moveDestinations,
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
    /*
      Two read-only sentences, because there are two reasons and the advice
      differs. "Ask an owner for editor access" is right for a context somebody
      put you in and wrong for the pinned one — nobody put you in it, there is
      no owner of it you know, and asking us for write access to our own docs is
      not a thing the product does.

      So the pinned context says what it *is* instead, and names the thing a
      viewer can do rather than the thing they cannot: the bug form is the whole
      reason the context is in their rail. `participatesInForms` in the gateway
      carves out exactly that write for a `member`, explicitly so that a
      view-only workspace is not "useless for collecting a bug report".
    */
    readOnlyReason:
      selected === null
        ? undefined
        : selected.pinned === true
          ? "This is Context's own workspace, not yours — read anything here, and " +
            "use a form to file a bug or a request. Your own notes are never in it."
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

  /*
    Below `useFileBrowser` on purpose, and the order is the point: the runtime
    hands every loaded plugin the note this console has open, so it has to be
    able to see it. `editor.path` and `editor.etag` are the whole of what
    crosses — never the text, which a plugin reads through the audited RPC like
    any other file.

    The etag also carries the console's own saves: the same path coming back
    with a different version is a write, and it is the only part of "a change
    Context made" that this hook cannot be told about directly.
  */
  const activeFile = useMemo(
    () => (files.editor.path === null
      ? null
      : { path: files.editor.path, etag: files.editor.etag }),
    [files.editor.etag, files.editor.path],
  );
  const pluginRuntime = useRuntime({
    workspaceId: membershipContextId,
    role: selected?.role,
    activeFile,
    // Who may be told a path at all. See `maySeePaths`: a plugin approved for
    // nothing but its own settings is told nothing, and an unanswered query is
    // treated as nobody rather than everybody.
    grants: pluginGrants.grants,
    onNoteWrite: files.applyPluginNoteWrite,
  });

  return {
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
  };
}
