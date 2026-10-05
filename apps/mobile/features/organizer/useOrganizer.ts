import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvex, useQueries, type RequestForQueries } from "convex/react";
import type { Id } from "@context/convex/_generated/dataModel";
import type { ToastSpec } from "../design/components/Toast";
import { offerAction, undoFailed } from "./copy";
import { changesCopy } from "./changeCopy";
import { organizerApi, routesApi } from "./organizerApi";
import { teamsCopy } from "./teamCopy";
import {
  isOrganizerEntry,
  organizerState,
  resolveToast,
  type OrganizerState,
  type OrganizerToast,
} from "./rules";
import type {
  ChangeCard,
  OrganizerDecision,
  OrganizerKind,
  OrganizerStatus,
  OrganizerSuggestion,
  RouteCard,
  RouteTeam,
  UndoToken,
} from "./types";

export interface OrganizerSuggestions {
  /** `null` until they have been asked for. */
  list: OrganizerSuggestion[] | null;
  /** What changed cards, read with the list; `null` until then. */
  changes: ChangeCard[] | null;
  /** Notes for the owner's teams (a personal workspace only); `null` until asked. */
  routes: RouteCard[] | null;
  /** The owner's teams, and whether notes are written for each. */
  teams: readonly RouteTeam[];
  /** What the owner keeps to themselves, in their own words. */
  keep: string;
  loading: boolean;
  failed: boolean;
  /** Rows with a press in flight, so ✓ and ✕ cannot be pressed twice. */
  busy: ReadonlySet<string>;
}

/** Auto-organize for the workspace on screen: what it says, and what can be pressed. */
export interface OrganizerView {
  state: OrganizerState;
  /** The status once it has answered, `null` while loading or unavailable. */
  status: OrganizerStatus | null;
  /** The workspace's slug, for "Tidying up @seyi". */
  slug: string;
  suggestions: OrganizerSuggestions;
  loadSuggestions: () => void;
  reviewOpen: boolean;
  /** `closeSettings` when opened from Settings, which is drawn over the list. */
  openReview: (options?: { closeSettings?: boolean }) => void;
  closeReview: () => void;
  resolve: (suggestion: OrganizerSuggestion, decision: OrganizerDecision) => void;
  /** The What changed page is on screen (`?changes=1`); the layout routes these. */
  pageOpen: boolean;
  openPage: () => void;
  closePage: () => void;
  /** Apply a What changed card's ticked steps, or say it is wrong. */
  resolveChange: (card: ChangeCard, decision: OrganizerDecision, steps: readonly string[]) => void;
  /** Add a team note, as edited on its preview. Resolves true once it is in the team. */
  sendRoute: (card: RouteCard, title: string, body: string) => Promise<boolean>;
  /** "Keep it here": the note is not written, and the card goes away. */
  dismissRoute: (card: RouteCard) => void;
  setTeamOn: (team: string, on: boolean) => void;
  setKeep: (keep: string) => void;
  setEnabled: (on: boolean) => void;
  setAutopilot: (kind: OrganizerKind, on: boolean) => void;
  acknowledgeNotice: (turnOff: boolean) => void;
  sweepNow: () => void;
  /** Settings › Premium, where the switches are. */
  openSettings: () => void;
  toasts: readonly ToastSpec[];
  dismissToast: (id: string) => void;
  /** The Undo on an Activity row auto-organize wrote, or `undefined` for any other row. */
  undoFor: (entry: ActivityRow) => (() => void) | undefined;
}

type ActivityRow = { at: string; kind: string; paths: string[]; by: string | null; via: string | null };

const EMPTY: OrganizerSuggestions = {
  list: null,
  changes: null,
  routes: null,
  teams: [],
  keep: "",
  loading: false,
  failed: false,
  busy: new Set(),
};
const NO_ROUTES = { routes: [] as RouteCard[], teams: [] as RouteTeam[], keep: "" };

/** Toast ids carry this, so the console's one host can hand a dismiss back to its owner. */
export const ORGANIZER_TOAST_PREFIX = "organizer-";

/**
 * Auto-organize, wired to the control plane — `usePremium`'s shape.
 *
 * `useQueries` rather than `useQuery`, for the reason `usePremium` gives: a
 * query that throws must not take the console down. Here it matters twice,
 * because the functions may not be deployed where this build runs, and the
 * answer to that is an error from the status query — read as "unavailable",
 * which every surface draws as nothing at all.
 *
 * Called from `useLiveConsoleData`, the one place the console layout reaches
 * the control plane. `workspaceId` is `null` before a workspace is selected
 * and for a pinned context nobody joined; the spec is then empty and nothing
 * is asked.
 *
 * ## Undo
 *
 * `resolve` hands back an opaque token when an accept can be taken back, and
 * the toast's Undo spends it through `organizer.undo`. An automatic change has
 * no token on this device — it happened on the server — so its Activity row
 * names itself by `{ at, kind, paths }` instead. `undo` is the one function
 * this uses that the v1 contract's table does not list.
 */
export function useOrganizer({
  workspaceId,
  slug,
}: {
  workspaceId: string | null;
  slug: string;
}): OrganizerView {
  const convex = useConvex();
  const id = workspaceId as Id<"workspaces"> | null;

  // `organizerApi()` is read inside the memo and never in its dependencies —
  // `api` mints a fresh object on every access. See `usePremium`.
  const spec = useMemo<RequestForQueries>(() => {
    const functions = organizerApi();
    const requests: RequestForQueries = {};
    if (id !== null && functions !== undefined) {
      requests.status = { query: functions.status, args: { workspaceId: id } };
    }
    return requests;
  }, [id]);
  const results = useQueries(spec);
  const state = id === null ? ({ kind: "unavailable" } as const) : organizerState(results.status);
  const status = state.kind === "ready" ? state.status : null;

  const [suggestions, setSuggestions] = useState<OrganizerSuggestions>(EMPTY);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [toasts, setToasts] = useState<readonly ToastSpec[]>([]);
  const toastSeq = useRef(0);
  const asking = useRef(0);

  // Another workspace is another set of suggestions, and nothing of this one's carries over.
  useEffect(() => {
    setSuggestions(EMPTY);
    setReviewOpen(false);
    setToasts([]);
  }, [id]);

  const say = useCallback((spec: Omit<ToastSpec, "id">) => {
    toastSeq.current += 1;
    // One at a time: the newest press is the one somebody is reading about.
    setToasts([{ ...spec, id: `${ORGANIZER_TOAST_PREFIX}${toastSeq.current}` }]);
  }, []);
  const dismissToast = useCallback(
    (toastId: string) => setToasts((current) => current.filter((toast) => toast.id !== toastId)),
    [],
  );

  const call = useCallback(
    async <T,>(run: (functions: NonNullable<ReturnType<typeof organizerApi>>, workspace: Id<"workspaces">) => Promise<T>) => {
      const functions = organizerApi();
      if (id === null || functions === undefined || convex === undefined) return undefined;
      return run(functions, id);
    },
    [convex, id],
  );

  const loadSuggestions = useCallback(() => {
    const ticket = ++asking.current;
    setSuggestions((current) => ({ ...current, loading: true, failed: false }));
    void call((functions, workspace) =>
      Promise.all([
        convex.action(functions.suggestions, { workspaceId: workspace }),
        // A deployment without What changed answers nothing here; the list still shows.
        convex.action(functions.changes, { workspaceId: workspace }).catch(() => ({ changes: [] as ChangeCard[] })),
        loadRoutes(convex, workspace),
      ]),
    )
      .then((answer) => {
        if (ticket !== asking.current) return;
        setSuggestions((current) => ({
          ...current,
          list: answer?.[0].suggestions ?? [],
          changes: answer?.[1].changes ?? [],
          routes: answer?.[2].routes ?? [],
          teams: answer?.[2].teams ?? [],
          keep: answer?.[2].keep ?? "",
          loading: false,
          failed: answer === undefined,
        }));
      })
      .catch(() => {
        if (ticket !== asking.current) return;
        setSuggestions((current) => ({ ...current, loading: false, failed: true }));
      });
  }, [call, convex]);

  // Routing — closing Settings over the list, opening Settings from it — is
  // the layout's, which wraps these; see `routeOrganizer`.
  const openReview = useCallback(() => {
    setReviewOpen(true);
    loadSuggestions();
  }, [loadSuggestions]);
  const closeReview = useCallback(() => setReviewOpen(false), []);

  const warn = useCallback((message: string) => say({ message, tone: "warn" }), [say]);

  const spendUndo = useCallback(
    (args: { token?: UndoToken; entry?: { at: string; kind: string; paths: string[] } }) => {
      void call((functions, workspace) => convex.action(functions.undo, { workspaceId: workspace, ...args }))
        .then((answer) => {
          if (answer === undefined || !answer.applied) warn(undoFailed);
        })
        .catch(() => warn(undoFailed));
    },
    [call, convex, warn],
  );

  const setAutopilot = useCallback(
    (kind: OrganizerKind, on: boolean) => {
      void call((functions, workspace) => convex.mutation(functions.setAutopilot, { workspaceId: workspace, kind, on })).catch(
        () => warn("That setting did not save. Check your connection and try again."),
      );
    },
    [call, convex, warn],
  );

  const resolve = useCallback(
    (suggestion: OrganizerSuggestion, decision: OrganizerDecision) => {
      setSuggestions((current) => ({ ...current, busy: new Set([...current.busy, suggestion.id]) }));
      const settle = (removed: boolean) =>
        setSuggestions((current) => {
          const busy = new Set(current.busy);
          busy.delete(suggestion.id);
          const list = removed && current.list !== null ? current.list.filter((s) => s.id !== suggestion.id) : current.list;
          return { ...current, busy, list };
        });
      void call((functions, workspace) =>
        convex.action(functions.resolve, { workspaceId: workspace, id: suggestion.id, decision }),
      )
        .then((result) => {
          const answer = result ?? { applied: false, offer: null, undo: null };
          settle(answer.applied);
          const toast: OrganizerToast | null = resolveToast(suggestion, decision, answer, {
            undo: () => spendUndo({ token: answer.undo }),
          });
          if (toast === null) return;
          const offer = toast.offer;
          say({
            message: toast.message,
            tone: toast.tone,
            undo: toast.undo,
            action: offer === undefined ? undefined : { label: offerAction, run: () => setAutopilot(offer, true) },
          });
        })
        .catch(() => {
          settle(false);
          const toast = resolveToast(suggestion, decision, { applied: false, offer: null, undo: null }, { undo: () => {} });
          if (toast !== null) warn(toast.message);
        });
    },
    [call, convex, say, setAutopilot, spendUndo, warn],
  );

  const resolveChange = useCallback(
    (card: ChangeCard, decision: OrganizerDecision, steps: readonly string[]) => {
      setSuggestions((current) => ({ ...current, busy: new Set([...current.busy, card.id]) }));
      const settle = (removed: boolean) =>
        setSuggestions((current) => {
          const busy = new Set(current.busy);
          busy.delete(card.id);
          const changes = removed && current.changes !== null ? current.changes.filter((c) => c.id !== card.id) : current.changes;
          return { ...current, busy, changes };
        });
      void call((functions, workspace) =>
        convex.action(functions.resolve, {
          workspaceId: workspace,
          id: card.id,
          decision,
          ...(decision === "accept" ? { steps: [...steps] } : {}),
        }),
      )
        .then((result) => {
          if (decision === "dismiss") {
            settle(true);
            say({ message: changesCopy.dismissed });
            return;
          }
          if (!result?.applied) {
            settle(false);
            warn(changesCopy.failed);
            return;
          }
          settle(true);
          const token = result.undo;
          say({ message: changesCopy.applied(card), undo: token ? () => spendUndo({ token }) : undefined });
        })
        .catch(() => {
          settle(false);
          warn(changesCopy.failed);
        });
    },
    [call, convex, say, spendUndo, warn],
  );

  const settleRoute = useCallback(
    (card: RouteCard, removed: boolean) =>
      setSuggestions((current) => {
        const busy = new Set(current.busy);
        busy.delete(card.id);
        const routes = removed && current.routes !== null ? current.routes.filter((r) => r.id !== card.id) : current.routes;
        return { ...current, busy, routes };
      }),
    [],
  );

  const sendRoute = useCallback(
    async (card: RouteCard, title: string, body: string) => {
      const functions = routesApi();
      if (id === null || functions === undefined) return false;
      setSuggestions((current) => ({ ...current, busy: new Set([...current.busy, card.id]) }));
      try {
        const result = await convex.action(functions.sendRoute, { workspaceId: id, id: card.id, title, body });
        if (!result.applied) {
          settleRoute(card, false);
          warn(result.error ?? teamsCopy.failed(card.team));
          return false;
        }
        settleRoute(card, true);
        const token = result.undo;
        say({ message: teamsCopy.sent(card.team), undo: token ? () => spendUndo({ token }) : undefined });
        return true;
      } catch {
        settleRoute(card, false);
        warn(teamsCopy.failed(card.team));
        return false;
      }
    },
    [convex, id, say, settleRoute, spendUndo, warn],
  );

  const dismissRoute = useCallback(
    (card: RouteCard) => {
      setSuggestions((current) => ({ ...current, busy: new Set([...current.busy, card.id]) }));
      void call((functions, workspace) => convex.action(functions.resolve, { workspaceId: workspace, id: card.id, decision: "dismiss" }))
        .then(() => {
          settleRoute(card, true);
          say({ message: teamsCopy.kept });
        })
        .catch(() => {
          settleRoute(card, false);
          warn(changesCopy.failed);
        });
    },
    [call, convex, say, settleRoute, warn],
  );

  const setRouting = useCallback(
    (args: { team?: string; on?: boolean; keep?: string }) => {
      const functions = routesApi();
      if (id === null || functions === undefined) return;
      setSuggestions((current) => ({
        ...current,
        ...(args.team !== undefined && args.on !== undefined
          ? { teams: current.teams.map((team) => (team.name === args.team ? { ...team, on: args.on! } : team)) }
          : {}),
        ...(args.keep !== undefined ? { keep: args.keep } : {}),
      }));
      void convex.action(functions.setRouting, { workspaceId: id, ...args }).catch(() =>
        warn("That setting did not save. Check your connection and try again."),
      );
    },
    [convex, id, warn],
  );
  const setTeamOn = useCallback((team: string, on: boolean) => setRouting({ team, on }), [setRouting]);
  const setKeep = useCallback((keep: string) => setRouting({ keep }), [setRouting]);

  const setEnabled = useCallback(
    (on: boolean) => {
      void call((functions, workspace) => convex.mutation(functions.setEnabled, { workspaceId: workspace, on })).catch(
        () => warn("That setting did not save. Check your connection and try again."),
      );
      if (!on) setSuggestions(EMPTY);
    },
    [call, convex, warn],
  );

  const acknowledgeNotice = useCallback(
    (turnOff: boolean) => {
      void call((functions, workspace) =>
        convex.mutation(functions.acknowledgeNotice, turnOff ? { workspaceId: workspace, turnOff } : { workspaceId: workspace }),
      ).catch(() => warn("That did not go through. Check your connection and try again."));
    },
    [call, convex, warn],
  );

  const sweepNow = useCallback(() => {
    // Quiet on failure: the payment went through either way, and the sweep
    // also runs on the server's own schedule.
    void call((functions, workspace) => convex.mutation(functions.sweepNow, { workspaceId: workspace })).catch(() => {});
  }, [call, convex]);

  const owner = status !== null && status.isOwner;
  const undoFor = useCallback(
    (entry: ActivityRow) =>
      owner && isOrganizerEntry(entry)
        ? () => spendUndo({ entry: { at: entry.at, kind: entry.kind, paths: entry.paths } })
        : undefined,
    [owner, spendUndo],
  );

  return {
    state,
    status,
    slug,
    suggestions,
    loadSuggestions,
    reviewOpen,
    openReview,
    closeReview,
    resolve,
    resolveChange,
    sendRoute,
    dismissRoute,
    setTeamOn,
    setKeep,
    setEnabled,
    setAutopilot,
    acknowledgeNotice,
    sweepNow,
    openSettings: () => {},
    pageOpen: false,
    openPage: () => {},
    closePage: () => {},
    toasts,
    dismissToast,
    undoFor,
  };
}

/** "For your teams", read beside the rest; a deployment without it answers none. */
function loadRoutes(convex: ReturnType<typeof useConvex>, workspace: Id<"workspaces">) {
  const functions = routesApi();
  if (functions === undefined) return Promise.resolve(NO_ROUTES);
  return convex.action(functions.routes, { workspaceId: workspace }).catch(() => NO_ROUTES);
}
