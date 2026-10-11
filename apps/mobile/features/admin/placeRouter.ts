/**
 * The staff console's navigator: one screen, with a Back history of places.
 *
 * Every admin address is the one `[...section]` route with different params,
 * and neither of the stock routers gives that a Back step. `setParams` on a
 * Stack is a `replaceState` (the browser's history length does not change),
 * and a Stack `push` mounts a whole second console behind the first — every
 * tab clicked would leave another copy of the page, with its live queries,
 * stacked out of sight.
 *
 * This router keeps exactly one route on screen and remembers the places
 * before it in `history`, the field the tab and drawer routers already use
 * for the same job. Expo Router's browser integration reads its length: when
 * it grows the address is pushed, when it shrinks the browser goes back, and
 * when it stays put the address is replaced. So:
 *
 *  - `router.push` / `router.navigate` to another place swaps the params in
 *    place (no remount, so the window, the admin check and any cached query
 *    stay) and adds a Back step;
 *  - `router.replace` and `setParams` swap them without one;
 *  - Back (the browser's, Android's, or `router.back()`) restores the place
 *    before; with none left it is not handled here and goes to whatever
 *    opened the console.
 *
 * The browser's own Back and Forward buttons do not come through here at all:
 * Expo Router restores the whole navigation state it stored with that history
 * entry, `history` included.
 */

type Params = object | undefined;

type Route = { key: string; name: string; params?: Params; path?: string };

type Visit = { key: string; name: string; params?: Params };

export type PlaceState = {
  stale: false;
  type: "stack";
  key: string;
  index: number;
  routeNames: string[];
  routes: Route[];
  history: Visit[];
  preloadedRoutes: Route[];
};

/** What React Navigation may hand back to rehydrate: anything from a stored full state to a bare route list. */
type Rehydrating = {
  key?: string;
  index?: number;
  stale?: boolean;
  history?: unknown[];
  routes?: readonly { key?: string; name?: string; params?: object; path?: string }[];
};

type Action = {
  type: string;
  source?: string;
  target?: string;
  payload?: { name?: string; params?: Params } & Record<string, unknown>;
};

type Options = {
  routeNames: string[];
  routeParamList: Record<string, Params>;
  routeKeyChanges?: string[];
};

let counter = 0;
function freshKey(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}${counter.toString(36)}`;
}

function sameParams(a: Params, b: Params): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

function routeFor(current: Route, name: string, params: Params): Route {
  // Same screen: keep its key, so React keeps the mounted page and only its
  // params change. `path` is dropped — it described the old address.
  if (current.name === name) return { key: current.key, name, params };
  return { key: freshKey(name), name, params };
}

function withRoute(state: PlaceState, route: Route, history: Visit[]): PlaceState {
  return { ...state, index: 0, routes: [route], history };
}

/** A React Navigation router factory; see the header. */
export function PlaceRouter(_options: unknown) {
  const router = {
    type: "stack" as const,

    getInitialState({ routeNames, routeParamList }: Options): PlaceState {
      const name = routeNames[0]!;
      return {
        stale: false,
        type: "stack",
        key: freshKey("admin"),
        index: 0,
        routeNames,
        routes: [{ key: freshKey(name), name, params: routeParamList[name] }],
        history: [],
        preloadedRoutes: [],
      };
    },

    getRehydratedState(partial: Rehydrating, options: Options): PlaceState {
      if (partial.stale === false && partial.history) return partial as unknown as PlaceState;
      const focused = partial.routes?.[partial.index ?? (partial.routes?.length ?? 1) - 1];
      const name =
        focused?.name && options.routeNames.includes(focused.name) ? focused.name : options.routeNames[0]!;
      return {
        stale: false,
        type: "stack",
        key: partial.key ?? freshKey("admin"),
        index: 0,
        routeNames: options.routeNames,
        routes: [
          {
            key: focused?.key ?? freshKey(name),
            name,
            params: focused?.params ?? options.routeParamList[name],
            ...(focused?.path ? { path: focused.path } : {}),
          },
        ],
        history: ((partial.history ?? []) as Visit[]).filter((visit) => options.routeNames.includes(visit?.name)),
        preloadedRoutes: [],
      };
    },

    getStateForRouteNamesChange(state: PlaceState, options: Options): PlaceState {
      const current = state.routes[state.index]!;
      if (options.routeNames.includes(current.name)) {
        return { ...state, routeNames: options.routeNames };
      }
      const name = options.routeNames[0]!;
      return {
        ...state,
        routeNames: options.routeNames,
        routes: [{ key: freshKey(name), name, params: options.routeParamList[name] }],
        index: 0,
        history: [],
      };
    },

    /** There is only ever the one route, and it is already focused. */
    getStateForRouteFocus(state: PlaceState): PlaceState {
      return state;
    },

    getStateForAction(state: PlaceState, action: Action, options: Options): PlaceState | null {
      const current = state.routes[state.index]!;
      switch (action.type) {
        case "PUSH":
        case "NAVIGATE":
        case "NAVIGATE_DEPRECATED":
        case "REPLACE": {
          const name = action.payload?.name;
          if (name === undefined || !state.routeNames.includes(name)) return null;
          const params = action.payload?.params ?? options.routeParamList[name];
          if (current.name === name && sameParams(current.params, params)) {
            // Already here: a second click on the open tab is not a Back step.
            return state;
          }
          const route = routeFor(current, name, params);
          const history =
            action.type === "REPLACE"
              ? state.history
              : [...state.history, { key: current.key, name: current.name, params: current.params }];
          return withRoute(state, route, history);
        }
        case "SET_PARAMS":
        case "REPLACE_PARAMS": {
          if (action.source !== undefined && action.source !== current.key) return null;
          const incoming = action.payload?.params;
          const params =
            action.type === "REPLACE_PARAMS" ? incoming : { ...(current.params ?? {}), ...(incoming ?? {}) };
          return withRoute(state, { key: current.key, name: current.name, params }, state.history);
        }
        case "GO_BACK":
        case "POP":
        case "POP_TO_TOP": {
          if (state.history.length === 0) return null;
          const steps =
            action.type === "POP_TO_TOP"
              ? state.history.length
              : Math.min(state.history.length, Math.max(1, Number(action.payload?.count ?? 1)));
          const back = state.history[state.history.length - steps]!;
          const route =
            back.key === current.key
              ? { key: current.key, name: back.name, params: back.params }
              : { key: back.key, name: back.name, params: back.params };
          return withRoute(state, route, state.history.slice(0, state.history.length - steps));
        }
        case "RESET": {
          const next = action.payload as Rehydrating | undefined;
          if (!next?.routes || next.routes.length === 0) return null;
          if (next.routes.some((route) => !state.routeNames.includes(route.name ?? ""))) return null;
          return router.getRehydratedState(next, options);
        }
        default:
          return null;
      }
    },

    shouldActionChangeFocus(action: Action): boolean {
      return action.type === "NAVIGATE" || action.type === "PUSH";
    },

    actionCreators: {},
  };
  return router;
}
