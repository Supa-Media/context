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

/*
 * The same tolerance, one level up.
 *
 * A layout sits *above* the route that owns the URL's parameters, and
 * `useLocalSearchParams` is scoped to the focused route — so a layout reading
 * a query parameter needs the global hook. The fallbacks are the point:
 * `useGlobalSearchParams` first, the local hook where a host provides only
 * that, and an empty object where a host provides neither. That last case is
 * every console test in this repo, each of which mocks `expo-router` with the
 * handful of APIs its own screen uses; without the fallback, adding one read
 * here would fail a dozen suites that have nothing to do with the parameter.
 */
const useGlobalParams: SearchParamsHook =
  (ExpoRouter as Partial<{ useGlobalSearchParams: SearchParamsHook }>)
    .useGlobalSearchParams ??
  (ExpoRouter as Partial<{ useLocalSearchParams: SearchParamsHook }>).useLocalSearchParams ??
  emptySearchParams;

export function useOptionalGlobalSearchParams<T extends SearchParams = SearchParams>(): T {
  return useGlobalParams<T>();
}
