/**
 * @shared's rows, with each note's title as its workspace object reads it now (decided by the owner, 2026-11-02;
 * `docs/decisions/storage-and-credentials/facts-in-objects.md`).
 *
 * The list is the live `shares.listSharedWithMe` query; a query cannot ask an object, so the titles of notes that
 * live in one come from `sharedTitles.now`, asked when the list's notes change. The rows wait for that first
 * answer, or `TITLE_WAIT_MS`, so a title does not flick from a file name to a heading under the reader's eye; a
 * failed ask leaves the list's own titles.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { withObjectTitles, type ObjectTitle, type SharedItem } from "./sharedInbox";

/** Longest the rows wait for their titles before showing the list's own. */
export const TITLE_WAIT_MS = 2_000;

export function useSharedWithMe(): SharedItem[] | undefined {
  const items = useQuery(api.functions.shares.listSharedWithMe) as SharedItem[] | undefined;
  // Held in a ref so the ask follows the notes listed, not the identity of the function handed back.
  const ask = useRef(useAction(api.functions.sharedTitles.now));
  const [titles, setTitles] = useState<ObjectTitle[]>([]);
  const [settled, setSettled] = useState(false);
  const notes = items === undefined ? null : items.map((item) => `${item.workspaceId}\u0000${item.entryPath}`).sort().join("\u0001");

  useEffect(() => {
    if (notes === null) return;
    let current = true;
    const wait = setTimeout(() => current && setSettled(true), TITLE_WAIT_MS);
    ask.current({})
      .then((answer) => {
        if (current) setTitles(answer as ObjectTitle[]);
      })
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(wait);
        if (current) setSettled(true);
      });
    return () => {
      current = false;
      clearTimeout(wait);
    };
  }, [notes]);

  return useMemo(() => (items === undefined || !settled ? undefined : withObjectTitles(items, titles)), [items, settled, titles]);
}
