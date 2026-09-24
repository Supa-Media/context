/**
 * Loading folder listings — from the bucket, or the device when it cannot be
 * reached — resetting them when the context changes, and the tree and search
 * built on them.
 *
 * Part of `useFileBrowser`, moved out of that file verbatim. The facade calls
 * each part in the order the code used to run, so every hook is still called
 * in the same order with the same dependency lists; what a part reads from an
 * earlier one arrives in `deps`, and is the same value the code closed over
 * before.
 */
/* eslint-disable react-hooks/exhaustive-deps -- Every dependency list in this
   file was moved unchanged from `useFileBrowser.ts`, where the rule accepted
   it. What it reports here is refs, state setters and `dispatch` that now
   arrive through `deps` instead of from a `useRef`, `useState` or `useReducer`
   in the same function, so the rule can no longer see they are stable. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { isServerRefusal, toFileError } from "../browser";
import { onMirrorListed, requestMirrorRefresh } from "../../../offline/mirrorEvents";
import type { MirroredTree } from "../../../offline/mirror";
import type { FolderListing } from "../types";
import type { Listings } from "./types";
import type { BrowserStateValues } from "./useBrowserState";
import type { FileActionsValues } from "./useFileActions";
import type { OfflineQueueValues } from "./useOfflineQueue";

type ListingsDeps =
  & Pick<FileActionsValues, "listFiles" | "notePathsAction" | "searchContext" | "workspaceId">
  & Pick<
    BrowserStateValues,
    | "dispatch"
    | "listedAtRef"
    | "openRun"
    | "setClipboard"
    | "setExpanded"
    | "setIndexedPaths"
    | "setListings"
    | "setLoading"
    | "setNotice"
    | "setOpening"
    | "setSelectedPath"
  >
  & Pick<OfflineQueueValues, "listings" | "offlineRef">;

export function useListings(deps: ListingsDeps) {
  const {
    dispatch, listFiles, listedAtRef, listings, notePathsAction, offlineRef, openRun,
    searchContext, setClipboard, setExpanded, setIndexedPaths, setListings, setLoading, setNotice,
    setOpening, setSelectedPath, workspaceId,
  } = deps;

  /**
   * Reload folders, from the bucket where it can be reached and from the device
   * where it cannot.
   *
   * **It answers whether anything came off the device, and callers have to use
   * that.** A tree redrawn from a cached listing is not a reloaded tree: it is
   * the same picture as before, and if an operation has just changed the bucket
   * it is a picture that is now wrong. `run` turns that into the same "the file
   * list did not reload" line a failed refresh has always produced, because it
   * is the same fact. Swallowing it would put the console back in the state it
   * already learned not to be in — showing somebody a listing it has no reason
   * to believe.
   */
  const refresh = useCallback(
    async (
      folders: readonly string[],
    ): Promise<{ servedFromCache: boolean; pages: Listings }> => {
      if (workspaceId === null) return { servedFromCache: false, pages: {} };
      const offline = offlineRef.current;
      let servedFromCache = false;
      /*
        EACH FOLDER LANDS ON ITS OWN, RATHER THAN ALL OF THEM AT THE END.

        This used to collect every page with `Promise.all` and write them in
        one `setListings` after the slowest one settled. For the two folders a
        note's rename touches that is the same thing; for the subtree a
        *folder* move cascades over it is not, and it is most of why the
        console felt like it was catching up rather than keeping up. Twelve
        folders meant twelve requests in flight and one repaint gated on the
        worst of them — so a tree that could have filled in from the top down
        sat still and then appeared.

        Writing each page as it arrives costs one render per folder instead of
        one per operation, which is what React batches for. The failure
        handling below is unchanged and still decides the *call's* answer: a
        page already committed is not un-committed by a later refusal, because
        it is the server's own answer for that folder and correct whatever
        happened to its neighbour.
      */
      /*
        The pages are kept as well as drawn, for the one caller that has to
        *read* what it just fetched: `createUntitled` picks a name against the
        destination's listing, and `setListings` is a state update — so
        `listingsRef` is still the pre-fetch map when this promise resolves.
        Every other caller wants the render and ignores this.

        A folder that came back gone is recorded as `undefined` rather than left
        out, so a caller spreading this over the map it already had drops the
        stale entry instead of keeping it.
      */
      const fetched: Listings = {};
      const started = Date.now();
      const commit = (folder: string, page: FolderListing | null, live = false) => {
        fetched[folder] = page ?? undefined;
        if (live) listedAtRef.current.set(folder, started);
        setListings((current) => {
          const next = { ...current };
          if (page === null) delete next[folder];
          else next[folder] = page;
          return next;
        });
      };
      await Promise.all(
        folders.map(async (folder) => {
          if (offline.reachability === "offline") {
            // Deliberately not "call it and see". `listFiles` is a Convex
            // action and `ConvexReactClient.action()` has no client-side
            // timeout, so with no connection the promise never settles at all
            // — the tree would sit empty forever rather than showing what is
            // on the device.
            const cached = await offline.cachedListing(folder);
            servedFromCache = true;
            commit(folder, cached?.value ?? null);
            return;
          }
          try {
            const page = await listFiles({ workspaceId, path: folder });
            offline.rememberListing(page);
            commit(folder, page, true);
            return;
          } catch (error) {
            const failure = toFileError(error);
            // A folder that has become invisible (its visibility changed, or
            // it was moved) is not an error worth shouting about — it is a
            // listing that should stop existing.
            if (failure.code === "FILE_NOT_FOUND") return commit(folder, null, true);
            // Every *other* refusal ends here rather than in the cache. The
            // line above is one too, and keeps its own answer — a folder that
            // is gone should stop existing rather than be redrawn from the
            // device. The rest have to reach the caller: a listing is a list of
            // somebody's note names, and repainting it after a refusal
            // discloses exactly what the refusal withheld. Only a transport
            // failure may fall back. And a listing already on screen — drawn
            // from the device's tree before anybody asked — goes with it, for
            // the same reason.
            if (isServerRefusal(error)) {
              commit(folder, null, true);
              throw error;
            }
            const cached = await offline.cachedListing(folder);
            if (cached !== null) {
              servedFromCache = true;
              return commit(folder, cached.value);
            }
            throw error;
          }
        }),
      );
      return { servedFromCache, pages: fetched };
    },
    [listFiles, workspaceId],
  );

  /**
   * Report a refresh nobody was waiting for.
   *
   * Four call sites fire `refresh` with `void` — expanding a folder, selecting
   * one, reloading a parent after a save, and opening the tree down to a
   * selection. None of them awaits it, so before this a refusal there was an
   * unhandled rejection and a folder that simply stayed empty: no listing, no
   * notice, nothing at all on screen to say the server had answered.
   *
   * That gap is not new, but it stopped being rare. `refresh` used to absorb a
   * refusal whenever it had something cached, so the throw only escaped for a
   * folder nobody had opened before; it now throws on **every** refusal,
   * because a listing repainted from the device after a refusal discloses
   * exactly what the refusal withheld. Making that guarantee stronger without
   * catching here would have made the silence the common case.
   *
   * The server's own sentence is what goes on screen rather than `run`'s
   * `STALE_LISTING_MESSAGE`: these are not operations whose result needs
   * qualifying, they *are* the thing that failed, and "the file list did not
   * reload" says less than the refusal it is standing in for.
   */
  const reportRefreshFailure = useCallback((error: unknown) => {
    setNotice(toFileError(error).message);
  }, []);

  /**
   * `ensureListing` on `FileBrowser`: fetch a folder's listing into the cache
   * without selecting it — see `browser.ts`. A no-op once it is there, and
   * fire-and-forget like every other background refresh in this file: the
   * result lands in `listings` on its own next render.
   */
  const ensureListing = useCallback(
    (path: string) => {
      if (workspaceId === null) return;
      if (listings[path] !== undefined) return;
      void refresh([path]).catch(reportRefreshFailure);
    },
    [listings, refresh, reportRefreshFailure, workspaceId],
  );

  /**
   * The context the state below actually belongs to.
   *
   * Published as `contextId` so a caller acting on a URL can wait for the
   * reset beneath to have happened — see the field's own comment in
   * `browser.ts` for the team link this existed to lose. It is set *inside*
   * the reset rather than derived from `workspaceId`, because the whole point
   * is that it moves one commit later than the prop does.
   */
  const [contextId, setContextId] = useState<string | null>(null);

  /**
   * Lay a tree read off the device over the listings — every folder at once.
   *
   * `fromDevice` is the tree as it was when this context was opened: it fills
   * only folders nothing has listed yet, because anything already here came
   * from the bucket this session. Otherwise the tree is a walk the mirror just
   * committed, and it replaces each folder whose own live listing started
   * before that walk did; when the walk was complete it also drops folders it
   * no longer names — deleted, moved, or no longer visible — unless a newer
   * live listing says otherwise.
   */
  const adoptTree = useCallback(
    (tree: MirroredTree, options: { fromDevice: boolean }) => {
      const listedAt = listedAtRef.current;
      const newer = (folder: string) => (listedAt.get(folder) ?? -Infinity) >= tree.listedAt;
      setListings((current) => {
        const next: Listings = { ...current };
        for (const [folder, listing] of tree.value) {
          // From the device: only where the bucket has said nothing yet — no
          // listing, and no refusal either.
          const skip = options.fromDevice
            ? current[folder] !== undefined || listedAt.has(folder)
            : newer(folder);
          if (skip) continue;
          next[folder] = listing;
        }
        if (!options.fromDevice && tree.complete) {
          for (const folder of Object.keys(current)) {
            if (!tree.value.has(folder) && !newer(folder)) delete next[folder];
          }
        }
        return next;
      });
    },
    [],
  );

  /**
   * Take the root's own listing without disturbing anything else in the map.
   *
   * **This used to be `setListings({ "": page })`, and the wholesale replace
   * was a bug with a witness.** `select` fetches a folder's own listing when it
   * does not have one — which is exactly what following a team link to a folder
   * does — and that fetch is started *after* this one and can land *before* it,
   * because a folder's listing is the smaller request. The root then replaced a
   * map holding a listing it was never told about, the folder page sat on
   * "Loading…", and nothing retried: the only way back was expanding that
   * folder in the side panel, which asks again.
   *
   * Merging is safe rather than merely lenient. Forgetting the previous context
   * is done by the reset at the top of the effect below, which runs before any
   * request goes out — so by the time a page comes back, the map holds only
   * listings for the context being loaded.
   */
  const takeRootListing = useCallback((page: FolderListing) => {
    setListings((current) => ({ ...current, "": page }));
  }, []);

  /** Load the root whenever the context changes, and forget the old one. */
  useEffect(() => {
    // Invalidates a read still in flight for the *previous* context before
    // anything else in this effect runs — see `openRun`. Without this, a read
    // started under the old `workspaceId` and answering after this effect has
    // already reset everything below would dispatch straight into the new
    // context's editor.
    openRun.current += 1;
    setListings({});
    listedAtRef.current = new Map();
    setExpanded(new Set());
    setSelectedPath(null);
    // Nothing is on its way in a context nothing has asked for yet. A read
    // still in flight for the *previous* context settles onto its own path and
    // finds this `null`, which is the state it would have left anyway.
    setOpening(null);
    setClipboard(null);
    setNotice(null);
    dispatch({ type: "closed" });
    setContextId(workspaceId);
    if (workspaceId === null) return;

    let cancelled = false;
    setLoading(true);
    /*
      The tree this device already holds, drawn at once — before, and
      independently of, the root request below. Every folder the mirror knows
      opens from it without a request; the live root listing and the refresh
      asked for here replace it as they land. It never paints over a listing
      that is already here, so a slower read of the device cannot put an older
      answer on top of a live one.
    */
    const root = { refused: false };
    void (async () => {
      const tree = await offlineRef.current.cachedTree(workspaceId).catch(() => null);
      if (cancelled || tree === null || root.refused) return;
      adoptTree(tree, { fromDevice: true });
      setLoading(false);
    })();
    if (offlineRef.current.reachability !== "offline") requestMirrorRefresh(workspaceId);
    void (async () => {
      const offline = offlineRef.current;
      try {
        /*
          Offline, the root is read off the device rather than asked for. Not a
          fallback after a failure: `listFiles` is a Convex action with no
          client-side timeout, so with no connection nothing ever rejects and
          the console would sit on a spinner for as long as the tab was open.
        */
        if (offline.reachability === "offline") {
          const cached = await offline.cachedListing("");
          if (cancelled) return;
          if (cached === null) {
            setNotice(
              "You are offline and nothing from this context is on this device yet. Open it once with a connection.",
            );
            return;
          }
          takeRootListing(cached.value);
          return;
        }
        const started = Date.now();
        const page = await listFiles({ workspaceId, path: "" });
        if (cancelled) return;
        listedAtRef.current.set("", started);
        offline.rememberListing(page);
        takeRootListing(page);
      } catch (error: unknown) {
        if (cancelled) return;
        // A refusal is an answer, and the tree is not repainted from the
        // device over one — see `isServerRefusal`. The person gets the
        // server's own sentence instead of a root listing it just declined
        // to give them, and whatever the device's tree had already drawn is
        // taken down with it.
        if (isServerRefusal(error)) {
          root.refused = true;
          setListings({});
        }
        const cached = isServerRefusal(error) ? null : await offline.cachedListing("");
        if (cancelled) return;
        if (cached !== null) {
          takeRootListing(cached.value);
          return;
        }
        setNotice(toFileError(error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adoptTree, listFiles, takeRootListing, workspaceId]);

  /*
    Redraw from the device's tree whenever the mirror commits a new listing of
    this context — its own five-minute pass, or the refresh the effect above
    asked for. That is how a folder another person or an agent created appears
    without anybody reloading.
  */
  useEffect(() => {
    if (workspaceId === null) return;
    let latest = 0;
    return onMirrorListed((listed) => {
      if (listed !== workspaceId) return;
      const ticket = (latest += 1);
      void offlineRef.current
        .cachedTree(workspaceId)
        .then((tree) => {
          if (tree !== null && ticket === latest) adoptTree(tree, { fromDevice: false });
        })
        .catch(() => {});
    });
  }, [adoptTree, workspaceId]);

  /*
    The hint that somebody changed this context's tree — a colleague, an agent,
    a meeting, an import — pushed over the Convex connection the console
    already holds (`functions/treeSignals.ts`). It carries a timestamp and
    nothing else, filtered to the audiences this person belongs to, so a new
    value means only "walk again": the walk is `syncManifest`, and what it
    commits is what redraws the tree above. The first value is not a change —
    the entry effect already asked for a walk — so only a value that differs
    from one this context already answered is.
  */
  const treeSignal = useQuery(
    api.functions.treeSignals.treeSignal,
    workspaceId !== null ? { workspaceId } : "skip",
  );
  const seenSignal = useRef<{ workspaceId: string | null; value: number | null | undefined }>({
    workspaceId: null,
    value: undefined,
  });
  useEffect(() => {
    if (workspaceId === null || treeSignal === undefined) return;
    const seen = seenSignal.current;
    seenSignal.current = { workspaceId, value: treeSignal };
    if (seen.workspaceId !== workspaceId || seen.value === undefined || seen.value === treeSignal) return;
    if (offlineRef.current.reachability !== "offline") requestMirrorRefresh(workspaceId);
  }, [treeSignal, workspaceId]);

  /**
   * The note-path index, fetched once per context — best-effort, and never
   * blocking the editor on it.
   *
   * A separate effect from the root listing above rather than folded into
   * it: this is decoration for link resolution, not something a note or
   * folder needs on screen, so a slow or failed answer here must not touch
   * `loading` or `notice`. Offline is skipped outright — `notePaths` is a
   * Convex action with no client-side timeout, so calling it with no
   * connection would never settle rather than answering `null` quickly the
   * way the honest "not indexed yet" state does.
   */
  useEffect(() => {
    setIndexedPaths(null);
    if (workspaceId === null) return;
    if (offlineRef.current.reachability === "offline") return;
    let cancelled = false;
    void (async () => {
      try {
        const found = await notePathsAction({ workspaceId });
        if (!cancelled) setIndexedPaths(found.paths);
      } catch {
        // Best-effort: a failed or refused fetch leaves link resolution at
        // whatever the file tree already knows, which is exactly what this
        // surface did before the index existed.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notePathsAction, workspaceId]);

  const toggleFolder = useCallback(
    (path: string) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      if (listings[path] === undefined) void refresh([path]).catch(reportRefreshFailure);
    },
    [listings, refresh, reportRefreshFailure],
  );

  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  /**
   * Ask the bucket, through the control plane's `searchContext`.
   *
   * Not routed through `run`: that is the mutation pipeline — it refuses when
   * `canEdit` is false, sets `busy`, and writes to `notice`. A search changes
   * nothing, a `member` must be able to run one, and a failure belongs to the
   * palette that asked rather than to the console's notice bar.
   */
  const search = useCallback(
    async (query: string) => {
      const found = await searchContext({
        workspaceId: workspaceId as Id<"workspaces">,
        query,
      });
      return {
        hits: found.hits,
        indexMissing: found.indexMissing,
        indexIncomplete: found.indexIncomplete,
        reducedRecall: found.reducedRecall,
        reducedRecallNotes: found.reducedRecallNotes,
      };
    },
    [searchContext, workspaceId],
  );

  return {
    refresh, reportRefreshFailure, ensureListing, contextId, toggleFolder, collapseAll, search,
  };
}

export type ListingsValues = ReturnType<typeof useListings>;
