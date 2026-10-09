import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Id } from "@context/convex/_generated/dataModel";
import type { GrantRefresh } from "../agent/consoleGrantCache";
import { useConsoleGrant } from "../agent/useConsoleGrant";
import { decisionNotice } from "./copy";
import {
  GONE_SENTENCE,
  UNREACHABLE_SENTENCE,
  approvalsEndpoint,
  decisionRequest,
  readDecision,
  readListing,
  type Approval,
  type DecisionAction,
} from "./gateway";

/** What the approvals surface draws, and the two things a person can do. */
export interface ApprovalsView {
  /** Whether this console can ask at all. False means the tab is not shown. */
  available: boolean;
  /** `idle` before the first answer, `listed` once one came back, `failed` when the last try did not. */
  phase: "idle" | "listed" | "failed";
  /** True while a listing is in flight. */
  loading: boolean;
  /** What is waiting, as the gateway last listed it, minus anything decided here. */
  items: Approval[];
  /** The sentence for a failed listing, `null` otherwise. */
  error: string | null;
  /** The approval a decision is in flight for. Its row is held until it settles. */
  busyId: string | null;
  /** What happened after the last decision, or `null`. */
  notice: { tone: "ok" | "warn"; text: string } | null;
  refresh: () => void;
  decide: (id: string, action: DecisionAction) => void;
}

interface State {
  phase: ApprovalsView["phase"];
  loading: boolean;
  items: Approval[];
  error: string | null;
  busyId: string | null;
  notice: ApprovalsView["notice"];
}

const EMPTY: State = { phase: "idle", loading: false, items: [], error: null, busyId: null, notice: null };

/**
 * The approvals this person has waiting, and their yes or no.
 *
 * ## The same grant as the agent, and the same rule about it
 *
 * The gateway authenticates with an OAuth token, so this asks for one through
 * `useConsoleGrant` — the grant cache the agent, the editor and presence share
 * for this workspace. It is held in memory and never written anywhere, and a
 * refused token is replaced **once**, never in a loop. The reasoning is in
 * `useAgentEngine.ts`; this follows it exactly.
 *
 * ## Why it lists on mount
 *
 * The tab carries a count, and a count that is only known after somebody opens
 * the tab says nothing is waiting when something is. So it lists as soon as it
 * is enabled, and again whenever the person asks.
 *
 * ## Stale answers are dropped
 *
 * Each workspace and each mount is an epoch. An answer that comes back for an
 * earlier one — the context changed, the console closed — is discarded, so a
 * list for one context never shows on another, and a decision made in one
 * never settles a row in the next.
 */
export function useApprovals(options: {
  /** The workspace the console is showing, or `null` before one is chosen. */
  workspaceId: string | null;
  /** The MCP endpoint the console already shows. */
  endpoint: string | null;
  /** False where there is no panel to show this in, or nothing to ask about. */
  enabled: boolean;
}): ApprovalsView {
  const mint = useConsoleGrant();
  const route = options.endpoint === null ? null : approvalsEndpoint(options.endpoint);
  const workspaceId = options.workspaceId;
  const live = options.enabled && route !== null && workspaceId !== null;
  const [state, setState] = useState<State>(EMPTY);

  const epoch = useRef(0);
  const listing = useRef(0);
  const busy = useRef<string | null>(null);
  /**
   * Approvals this scope has settled. A listing asked for before a decision can
   * answer after it, and its copy is older than the decision: it must not put
   * the settled approval back on the list as if it were still waiting.
   */
  const settled = useRef(new Set<string>());

  /**
   * One request, with the grant. Returns `null` when no answer came back at
   * all — a mint refused, a network failure — which the callers read as
   * "unreachable". The reason is dropped for the same reason `useAgentEngine`
   * drops it: a thrown error here can carry a URL or a code for an operator.
   */
  const send = useCallback(
    async (method: "GET" | "POST", body?: unknown): Promise<{ status: number; body: unknown } | null> => {
      if (route === null || workspaceId === null) return null;
      const grant = (refresh: GrantRefresh) =>
        mint({ workspaceId: workspaceId as Id<"workspaces"> }, refresh).then((minted) => minted.accessToken);
      const request = (accessToken: string) =>
        fetch(route, {
          method,
          headers:
            body === undefined
              ? { Authorization: `Bearer ${accessToken}` }
              : { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      try {
        const token = await grant(false);
        let response = await request(token);
        // One re-mint, never a loop. See `useAgentEngine`.
        if (response.status === 401 || response.status === 403) {
          response = await request(await grant({ rejected: token }));
        }
        let parsed: unknown = null;
        try {
          parsed = await response.json();
        } catch {
          parsed = null;
        }
        return { status: response.status, body: parsed };
      } catch {
        return null;
      }
    },
    [mint, route, workspaceId],
  );

  const list = useCallback(async () => {
    const mark = epoch.current;
    const mine = ++listing.current;
    setState((s) => ({ ...s, loading: true }));
    const answer = await send("GET");
    // A listing that a newer one has overtaken, or that belongs to a context
    // already left, is not what the screen should show.
    if (mark !== epoch.current || mine !== listing.current) return;
    const read =
      answer === null
        ? { kind: "failed" as const, sentence: UNREACHABLE_SENTENCE }
        : readListing(answer.status, answer.body);
    setState((s) =>
      read.kind === "listed"
        ? {
            ...s,
            phase: "listed",
            loading: false,
            items: read.approvals.filter((item) => !settled.current.has(item.id)),
            error: null,
          }
        : { ...s, phase: "failed", loading: false, items: [], error: read.sentence },
    );
  }, [send]);

  // The scope effect calls the latest `list` without re-running on every change
  // of the grant's identity, which would list again for no reason.
  const listRef = useRef(list);
  useEffect(() => {
    listRef.current = list;
  }, [list]);

  const scope = live ? `${workspaceId}\n${route}` : null;
  useEffect(() => {
    epoch.current += 1;
    busy.current = null;
    settled.current = new Set();
    setState(EMPTY);
    if (scope !== null) void listRef.current();
    return () => {
      epoch.current += 1;
    };
  }, [scope]);

  const decide = useCallback(
    async (id: string, action: DecisionAction) => {
      if (busy.current !== null) return;
      busy.current = id;
      const mark = epoch.current;
      setState((s) => ({ ...s, busyId: id, notice: null }));
      const answer = await send("POST", decisionRequest(id, action));
      if (mark !== epoch.current) return;
      busy.current = null;
      const read =
        answer === null
          ? { kind: "failed" as const, sentence: UNREACHABLE_SENTENCE }
          : readDecision(answer.status, answer.body);
      if (read.kind === "decided" || read.kind === "gone") settled.current.add(id);
      if (read.kind === "decided") {
        setState((s) => ({
          ...s,
          busyId: null,
          items: s.items.filter((item) => item.id !== id),
          notice: decisionNotice(read.decision),
        }));
      } else if (read.kind === "gone") {
        // Settled elsewhere or expired: it is no longer waiting, so it leaves.
        setState((s) => ({
          ...s,
          busyId: null,
          items: s.items.filter((item) => item.id !== id),
          notice: { tone: "warn", text: GONE_SENTENCE },
        }));
      } else {
        setState((s) => ({ ...s, busyId: null, notice: { tone: "warn", text: read.sentence } }));
      }
    },
    [send],
  );

  return useMemo<ApprovalsView>(
    () => ({
      available: live,
      phase: state.phase,
      loading: state.loading,
      items: state.items,
      error: state.error,
      busyId: state.busyId,
      notice: state.notice,
      refresh: () => {
        if (live) void listRef.current();
      },
      decide: (id, action) => {
        if (live) void decide(id, action);
      },
    }),
    [decide, live, state],
  );
}
