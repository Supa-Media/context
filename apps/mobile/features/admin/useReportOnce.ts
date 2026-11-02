import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useConvex } from "convex/react";
import { getFunctionName, type FunctionArgs, type FunctionReference, type FunctionReturnType } from "convex/server";

/**
 * An admin report, read once rather than subscribed to.
 *
 * `censusReport` and `usageReport` read whole tables. Held as live queries
 * they re-ran on every sign-up, grant stamp and usage row for as long as the
 * admin page stayed open: about 25 GB of Convex database reads in eighteen
 * days, for numbers nobody needs to the second (Convex invoice, owner
 * 2026-10-30). Read when the section opens, when its arguments change, and
 * when the app comes back to the front, and the page still shows today.
 *
 * `undefined` until the first answer, like `useQuery`, and a failure throws
 * at render as `useQuery`'s does, so the admin page's boundary still shows it.
 */
export function useReportOnce<Query extends FunctionReference<"query">>(
  query: Query,
  args: FunctionArgs<Query>,
): FunctionReturnType<Query> | undefined {
  const convex = useConvex();
  // `api.x.y` is a proxy, a new one each read: keyed by its name, so a render
  // never reads again just because it spelled the reference afresh.
  const key = JSON.stringify([getFunctionName(query), args]);
  const latest = useRef(query);
  latest.current = query;
  const [answer, setAnswer] = useState<{ key: string; value: FunctionReturnType<Query> } | undefined>();
  const [failure, setFailure] = useState<unknown>(undefined);
  const [round, setRound] = useState(0);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setRound((value) => value + 1);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    let current = true;
    convex.query(latest.current, JSON.parse(key)[1]).then(
      (value) => {
        if (current) setAnswer({ key, value });
      },
      (error: unknown) => {
        if (current) setFailure(error ?? new Error("report failed"));
      },
    );
    return () => {
      current = false;
    };
  }, [convex, key, round]);

  if (failure !== undefined) throw failure;
  // Another window's answer is not this one's: loading, as `useQuery` shows it.
  return answer?.key === key ? answer.value : undefined;
}
