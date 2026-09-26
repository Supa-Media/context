import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvex, useQueries, type RequestForQueries } from "convex/react";
import type { Id } from "@context/convex/_generated/dataModel";
import type { ToastSpec } from "../design/components/Toast";
import { offerAction, undoFailed } from "./copy";
import { organizerApi } from "./organizerApi";
import {
  isOrganizerEntry,
  organizerState,
  resolveToast,
  type OrganizerState,
  type OrganizerToast,
} from "./rules";
import type {
  OrganizerDecision,
  OrganizerKind,
  OrganizerStatus,
  OrganizerSuggestion,
  UndoToken,
} from "./types";

export interface OrganizerSuggestions {
  /** `null` until they have been asked for. */
  list: OrganizerSuggestion[] | null;
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

const EMPTY: OrganizerSuggestions = { list: null, loading: false, failed: false, busy: new Set() };

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
    void call((functions, workspace) => convex.action(functions.suggestions, { workspaceId: workspace }))
      .then((answer) => {
        if (ticket !== asking.current) return;
        setSuggestions((current) => ({
          ...current,
          list: answer?.suggestions ?? [],
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
    setEnabled,
    setAutopilot,
    acknowledgeNotice,
    sweepNow,
    openSettings: () => {},
    toasts,
    dismissToast,
    undoFor,
  };
}
