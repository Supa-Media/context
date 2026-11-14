/**
 * A staff report read once and shared: every hook asking for the same query and arguments within `ttl` gets the same
 * answer from one read (review of #3291: Home, Needs you and the sidebar asked for the same turns report three times).
 * Like `useReportOnce`, it is never a live subscription, so a whole-table report does not re-run on every write; unlike
 * it, a second asker on the same page does not read again, and a window change keeps the last answer on screen until
 * the new one lands (`stale`). A failed read throws at render, so the shell names it rather than showing a gap.
 */
import { useEffect, useState } from "react";
import { useConvex } from "convex/react";
import { getFunctionName, type FunctionArgs, type FunctionReference, type FunctionReturnType } from "convex/server";

type Entry = { at: number; value?: unknown; promise?: Promise<unknown> };

const cache = new Map<string, Entry>();

/** How long one answer is shared before the next asker reads again. */
export const SHARED_TTL_MS = 60_000;

/** Forget every shared answer (tests, and signing out). */
export function clearSharedReads(): void {
  cache.clear();
}

export function useSharedReport<Q extends FunctionReference<"query">>(
  query: Q,
  args: FunctionArgs<Q>,
  ttl: number = SHARED_TTL_MS,
): { value: FunctionReturnType<Q> | undefined; stale: boolean } {
  const convex = useConvex();
  const key = JSON.stringify([getFunctionName(query), args]);
  const fresh = (e: Entry | undefined) => e !== undefined && e.value !== undefined && Date.now() - e.at < ttl;
  const [answer, setAnswer] = useState<{ key: string; value: FunctionReturnType<Q> } | undefined>(() => {
    const hit = cache.get(key);
    return fresh(hit) ? { key, value: hit!.value as FunctionReturnType<Q> } : undefined;
  });
  const [failure, setFailure] = useState<{ key: string; error: unknown } | undefined>();
  useEffect(() => {
    let live = true;
    const hit = cache.get(key);
    if (fresh(hit)) {
      setAnswer({ key, value: hit!.value as FunctionReturnType<Q> });
      return;
    }
    let promise = hit?.promise;
    if (promise === undefined) {
      promise = convex.query(query, args);
      cache.set(key, { at: Date.now(), promise });
      promise.then(
        (value) => cache.set(key, { at: Date.now(), value }),
        () => cache.delete(key),
      );
    }
    promise.then(
      (value) => live && setAnswer({ key, value: value as FunctionReturnType<Q> }),
      (error: unknown) => live && setFailure({ key, error }),
    );
    return () => {
      live = false;
    };
    // The key stands for the query and its arguments.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, convex]);
  // A failure throws at render, as `useQuery`'s does, so the console's boundary names the source that failed.
  if (failure?.key === key && answer?.key !== key) throw failure.error;
  return { value: answer?.value, stale: answer !== undefined && answer.key !== key };
}
