import * as ExpoRouter from "expo-router";

type SearchParams = Record<string, string | string[] | undefined>;
type SearchParamsHook = <T extends SearchParams = SearchParams>() => T;

const emptySearchParams: SearchParamsHook = <T extends SearchParams>() => ({} as T);

/*
 * App layouts are also rendered by small native/test hosts that provide only
 * the router APIs the surface uses.  Keep a query-only enhancement optional in
 * those hosts while calling one stable hook unconditionally in React.
 */
const useSearchParams: SearchParamsHook =
  (ExpoRouter as Partial<{ useLocalSearchParams: SearchParamsHook }>).useLocalSearchParams ??
  emptySearchParams;

export function useOptionalLocalSearchParams<T extends SearchParams = SearchParams>(): T {
  return useSearchParams<T>();
}
