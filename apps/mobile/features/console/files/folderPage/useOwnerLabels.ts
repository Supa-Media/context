/**
 * How a folder page shows owner lines written before handles.
 *
 * `owner: seyi@example.com` was what the picker wrote before it wrote handles,
 * and a project page should say `@seyi`, not an email address. Nothing is
 * rewritten: the page asks the server which member each of its owner words
 * names (`owners.resolveOwners`) and shows that member's handle instead. A
 * word that names nobody, or already reads as a handle, is shown as written.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { OwnerResolve } from "../owners";

export function useOwnerLabels(resolve: OwnerResolve | undefined, words: readonly string[]): (value: string) => string {
  // One ask per distinct set of words, however often the notes redraw.
  const key = useMemo(() => [...new Set(words.map((word) => word.trim()).filter((word) => word !== ""))].sort().join("\n"), [words]);
  const [labels, setLabels] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => {
    if (resolve === undefined || key === "") return;
    let live = true;
    // Asked inside a promise, so a resolver that throws at once is a page that cannot ask, not a crash.
    Promise.resolve()
      .then(() => resolve(key.split("\n")))
      .then((found) => {
        if (live) setLabels(new Map(found.map((row) => [row.word.trim().toLowerCase(), row.value])));
      })
      // A page that cannot ask shows the words as written, which is what it did before.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [resolve, key]);
  return useCallback((value: string) => labels.get(value.trim().toLowerCase()) ?? value, [labels]);
}
