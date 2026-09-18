import { useEffect, useRef, useState } from "react";
import {
  forgetContextRow,
  recallContexts,
  rememberContexts,
  type RememberedContext,
} from "./cache";
import { currentEpoch } from "./epoch";
import { useReachability } from "./reachability";
import { openStore } from "./store";

/**
 * The context list a cold start with no network is allowed to draw.
 *
 * ## The gap this closes
 *
 * Everything else in `features/offline` — the cache, the drafts, the queue,
 * the conflict resolver — is reachable only once the console knows which
 * context is open and what this person's role in it is. Both come from
 * `listMyWorkspaces`, a Convex subscription, so with no network neither ever
 * arrives: `visibilityTierForRole` answers `unknown`, `useOfflineNotes` sets
 * its scope to `null`, and the cache correctly refuses to serve a byte. The
 * whole feature therefore worked only while the process was already warm and
 * the list had already landed once — which is not the state a phone is in when
 * it comes out of a pocket on a train, and is never the state a relaunched app
 * is in.
 *
 * So the list is written down as it lands and read back when it has not.
 *
 * ## The three conditions, and why each one is load-bearing
 *
 * A remembered list is served only when **all** of these hold:
 *
 * 1. **The live list has not landed.** Not "is slow" — `undefined`. The moment
 *    the server answers, the server wins, for a rename, a new context, a
 *    membership that ended, anything. There is no merging and no preferring
 *    the fresher of two: one of them is a fact and the other is a memory.
 * 2. **The device says it is offline.** Online, a list that has not arrived is
 *    a list that is *about to*, and waiting for it is what the console already
 *    does. Substituting a memory for a round trip that is going to complete
 *    would put a stale rail on screen for the half second before the real one,
 *    which is the flicker `landingStep` exists to prevent. Reachability is only
 *    trusted in the direction it is reliable — see `reachability.web.ts` — and
 *    this is that direction: an explicit `false`.
 * 3. **Something was remembered.** Which is the security property, and it is
 *    worth being explicit about why it is enough. Sign-out calls
 *    `forgetLocalCopies`, which clears this namespace along with the note
 *    bodies; a signed-out device therefore remembers no contexts, serves no
 *    fallback, and shows exactly what it shows today. **The presence of an
 *    envelope is the evidence that a session got far enough to have one**, so
 *    this hook cannot manufacture reach that a sign-out took away.
 *
 * ## What a stale memory can and cannot be
 *
 * It can be **out of date**: a context renamed, a context joined, a promotion
 * from `member` to `editor` — none are seen until the next successful load,
 * and all of them correct themselves on it.
 *
 * It cannot be **wider than the truth**, which is the only direction that
 * discloses anything. The clearance a cached copy is served under is
 * `private` for `owner` and `team` for everybody else, and the owner role
 * cannot be taken away — `setMemberRole`, `removeMember` and `leaveWorkspace`
 * each refuse it by name, and ownership transfer is not built. A remembered
 * `owner` was true when it was written and is still true now; every other role
 * remembers a clearance that is already the narrow one. The argument lives
 * next to the key in `keys.ts` and the premise is pinned, in the app that owns
 * it, by `apps/convex/__tests__/ownerRoleIsPermanent.test.ts`.
 *
 * It also cannot reach a context whose membership ended, because the notes and
 * the row go together: `forgetDepartedContexts` takes a departed context's
 * cached bodies *and* its remembered row on the first load that sees it gone,
 * and `keysForWorkspace` takes both when somebody presses Leave.
 */
export function useRememberedContexts(
  live: readonly RememberedContext[] | undefined,
): readonly RememberedContext[] | undefined {
  const reachability = useReachability();

  // One store for the life of the app, for the reason `useOfflineNotes` opens
  // exactly one: `openStore` probes the platform with a real write.
  const storeRef = useRef<ReturnType<typeof openStore> | null>(null);
  if (storeRef.current === null) storeRef.current = openStore();
  const store = storeRef.current;

  /*
    The session this mount belongs to. Same barrier as every other writer in
    this folder: a read issued before sign-out can resolve after the clear has
    walked past the key, and a write behind it would land on a device whose
    session is over. `epoch.ts` carries the full account.
  */
  const epochRef = useRef(currentEpoch());
  const mine = () => epochRef.current === currentEpoch();

  const [recalled, setRecalled] = useState<readonly RememberedContext[] | null>(null);

  /*
    Read once on mount, unconditionally — not only when offline.

    Reachability can flip to `offline` at any moment, and a read started then
    would answer a render or two later, which on a cold launch is exactly the
    window where the console has already decided it has no contexts and
    redirected. Paying one store read per app start to have the answer in hand
    is the cheaper side of that trade by a wide margin.
  */
  useEffect(() => {
    let cancelled = false;
    void recallContexts(store, { now: Date.now() })
      .then((contexts) => {
        if (cancelled || !mine()) return;
        setRecalled(contexts);
      })
      .catch(() => {
        // A store that will not answer is a device with no memory of its
        // contexts, which is the behaviour that existed before this hook. It
        // is never a reason to fail the render that draws somebody's console.
        if (!cancelled) setRecalled([]);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount.
  }, []);

  /*
    Write it down whenever the live list says something different.

    Keyed on the encoded rows rather than on the array's identity, which
    changes on every tick of any field on any row — the same reason
    `useLiveConsoleData` keys its purge on the joined ids rather than on
    `workspaces`. Here the key is the whole row because a *rename* is a change
    this wants to record, where a purge only cares about which ids exist.
  */
  const encoded = live === undefined ? null : JSON.stringify(live);
  useEffect(() => {
    if (encoded === null) return;
    const contexts = JSON.parse(encoded) as RememberedContext[];
    if (contexts.length === 0) return;
    if (!mine()) return;
    void rememberContexts(store, contexts, Date.now())
      .then(() => {
        /*
          Checked again, *after* the write, which no other writer in this
          folder does and which this one needs.

          `forgetLocalCopies` bumps the epoch and then removes the keys that
          exist while it runs, so a write already in flight can land behind the
          clear. For a cached note that leaves a stale body the next sweep
          takes; for a context row it leaves the one thing the boot gate reads
          as evidence of a session, so a signed-out device would draw an empty
          console offline instead of the sign-in screen. Deleting what this
          write just made is the narrow, obviously-correct repair: it removes
          only the rows this mount wrote, and only once its session is over.
        */
        if (mine()) return;
        return Promise.all(contexts.map((context) => forgetContextRow(store, context.workspaceId)));
      })
      .catch(() => {
        // Fire-and-forget, like every other writer here: a device that cannot
        // remember its context list still has a working console with a network.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `encoded` is the value.
  }, [encoded]);

  if (live !== undefined) return live;
  if (reachability !== "offline") return undefined;
  if (recalled === null || recalled.length === 0) return undefined;
  return recalled;
}
