import { useCallback, useEffect, useRef, useState } from "react";
import { applyMove, applyNoteCreate, rekeyPath } from "../optimistic";
import { parentPath } from "../paths";
import type { FolderListing } from "../types";
import type { Listings } from "./types";

interface PendingChange {
  id: number;
  epoch: number;
  committed: boolean;
  done: Promise<boolean>;
  resolve: (committed: boolean) => void;
  confirmed: Set<string>;
}
export interface OnlineMove extends PendingChange {
  kind: "move";
  from: string;
  to: string;
}
interface OnlineCreate extends PendingChange {
  kind: "create";
  path: string;
}
type OnlineChange = OnlineMove | OnlineCreate;

/** Local changes stay visible until an authoritative listing confirms them. */
export function useOnlineMoves(scope: { current: { epoch: number } }) {
  const changesRef = useRef(new Map<number, OnlineChange>());
  const counter = useRef(0);
  const [changes, setChanges] = useState<readonly OnlineChange[]>([]);
  const epoch = scope.current.epoch;
  const publish = useCallback(() => setChanges([...changesRef.current.values()]), []);
  useEffect(() => () => {
    // Resolve waiters as well as forgetting drawings, including A -> B -> A.
    for (const change of changesRef.current.values()) {
      if (change.epoch !== epoch) continue;
      change.resolve(false);
      changesRef.current.delete(change.id);
    }
  }, [epoch]);

  const beginChange = useCallback((target: {kind: "move"; from: string; to: string} | {kind: "create"; path: string}) => {
    let resolve!: (committed: boolean) => void;
    const done = new Promise<boolean>((settle) => { resolve = settle; });
    const change: OnlineChange = {
      ...target, id: ++counter.current, epoch: scope.current.epoch,
      committed: false, done, resolve, confirmed: new Set(),
    };
    changesRef.current.set(change.id, change);
    publish();
    return {
      commit: () => {
        if (scope.current.epoch !== change.epoch || !changesRef.current.has(change.id)) return false;
        change.committed = true;
        if (change.kind === "move") {
          // A newly created or previously renamed note can move again before
          // its earlier listing confirms. Carry that older overlay to the
          // final identity, or retiring this move would resurrect its source.
          for (const prior of changesRef.current.values()) {
            if (prior === change || !prior.committed || prior.epoch !== change.epoch) continue;
            if (prior.kind === "create") {
              const path = rekeyPath(prior.path, change.from, change.to)!;
              if (path !== prior.path) { prior.path = path; prior.confirmed.clear(); }
            } else {
              const to = rekeyPath(prior.to, change.from, change.to)!;
              if (to !== prior.to) { prior.to = to; prior.confirmed.clear(); }
              if (prior.from === prior.to) changesRef.current.delete(prior.id);
            }
          }
        }
        change.resolve(true);
        publish();
        return true;
      },
      reject: () => {
        const active = scope.current.epoch === change.epoch && changesRef.current.has(change.id);
        change.resolve(false);
        changesRef.current.delete(change.id);
        if (scope.current.epoch === change.epoch) publish();
        return active;
      },
    };
  }, [publish, scope]);
  const beginOnlineMove = useCallback((from: string, to: string) => beginChange({kind: "move", from, to}), [beginChange]);
  const beginOnlineCreate = useCallback((path: string) => beginChange({kind: "create", path}), [beginChange]);
  const pendingMoveTo = useCallback((path: string) => {
    return [...changesRef.current.values()].find((change): change is OnlineMove =>
      change.kind === "move" && change.epoch === scope.current.epoch && !change.committed &&
      rekeyPath(path, change.to, change.from) !== path,
    );
  }, [scope]);
  const pendingCreateTo = useCallback((path: string) => {
    return [...changesRef.current.values()].find((change): change is OnlineCreate =>
      change.kind === "create" && change.epoch === scope.current.epoch && !change.committed && change.path === path,
    );
  }, [scope]);

  const confirmOnlineMoves = useCallback((folder: string, page: FolderListing | null, refused = false) => {
    let changed = false;
    for (const change of changesRef.current.values()) {
      if (change.epoch !== scope.current.epoch) {
        change.resolve(false);
        changesRef.current.delete(change.id);
        changed = true;
        continue;
      }
      const parents = change.kind === "move" ? [parentPath(change.from), parentPath(change.to)] : [parentPath(change.path)];
      if (!parents.includes(folder) && !(refused && folder === "")) continue;
      // Refusals must remove an overlay too: withheld names cannot be redrawn.
      if (refused) {
        change.resolve(false);
        changesRef.current.delete(change.id);
        changed = true;
        continue;
      }
      if (!change.committed || page === null) continue;
      const paths = new Set(page.entries.map((entry) => entry.path));
      const confirmed = change.kind === "create" ? paths.has(change.path) :
        (folder !== parentPath(change.from) || !paths.has(change.from)) &&
        (folder !== parentPath(change.to) || paths.has(change.to));
      if (confirmed) change.confirmed.add(folder);
      if (parents.every((parent) => change.confirmed.has(parent))) {
        changesRef.current.delete(change.id);
        changed = true;
      }
    }
    if (changed) publish();
  }, [publish, scope]);

  const overlayOnlineMoves = useCallback((base: Listings): Listings => {
    let next = base;
    for (const change of changes) {
      if (change.epoch !== epoch || epoch !== scope.current.epoch) continue;
      next = change.kind === "move" ? applyMove(next, change.from, change.to) : applyNoteCreate(next, change.path);
    }
    return next;
  }, [changes, scope, epoch]);
  return { beginOnlineMove, beginOnlineCreate, pendingMoveTo, pendingCreateTo, confirmOnlineMoves, overlayOnlineMoves };
}
