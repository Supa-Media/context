import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConsoleGrant } from "../../agent/useConsoleGrant";
import { gatewayOriginFrom } from "../../meetings/gateway";
import { onReturnToApp } from "../../app/returnToApp";
import type { CacheScope } from "../../offline/keys";
import {
  DurableCollaborationController,
  type DurableCollaboration,
  type DurableStatus,
  type CollaborationResponse,
  type LiveUpdate,
} from "./durable";

export interface UseCollaborationOptions {
  workspaceId: string | null;
  endpoint: string | null;
  path: string | null;
  scope: CacheScope;
  initialText: () => string;
  legacyDraft?: () => { baseline: string; desired: string; baseEtag?: string | null } | undefined;
  editable: boolean;
  enabled?: boolean;
  onText: (text: string) => void;
  onState?: (state: { text: string; etag: string | null; status: DurableStatus; pending: number; recovery?: { baseline: string; desired: string; baseEtag?: string | null }; legacyAdopted?: { path: string; text: string; baseEtag: string } }) => void;
  onOwned?: (path: string, owned: boolean) => void;
}

/** Long enough for a large note on a slow link; short enough to not strand the queue. */
const COLLABORATION_REQUEST_TIMEOUT_MS = 30_000;

const emptyState: DurableCollaboration = {
  mode: "durable",
  ready: false,
  status: "loading",
  pending: 0,
  etag: null,
  documentId: null,
  text: "",
  revision: "",
  onChange: () => {},
  onVersionedChange: () => {},
  onUpdate: () => false,
  recovery: undefined,
  legacyAdopted: undefined,
  repair: () => {},
  shared: null,
};

function statusMessage(status: DurableStatus): string | undefined {
  switch (status) {
    case "offline":
      return "Saved on this device; waiting for a connection.";
    case "storing":
      return "Saving on this device…";
    case "syncing":
      return "Syncing to your bucket…";
    case "error":
      return "Saved in memory; local storage or sync failed, so keep this note open until it recovers.";
    case "unavailable":
      return "Note unavailable; your changes are kept on this device.";
    case "revoked":
      return "Your collaboration access was revoked; local edits are kept on this device.";
    default:
      return undefined;
  }
}

/** Bind one note to the durable gateway protocol; presence remains a UI overlay. */
export function useCollaboration(options: UseCollaborationOptions): DurableCollaboration | undefined {
  const mint = useConsoleGrant();
  const controller = useRef<DurableCollaborationController | null>(null);
  const callbacks = useRef(options);
  callbacks.current = options;
  const [state, setState] = useState<DurableCollaboration>(emptyState);
  const [generation, setGeneration] = useState(0);

  const active =
    options.enabled !== false &&
    options.workspaceId !== null &&
    options.endpoint !== null &&
    options.path !== null &&
    options.path.endsWith(".md") &&
    !options.path.endsWith(".excalidraw.md");

  useEffect(() => {
    const path = options.path;
    const workspaceId = options.workspaceId;
    const endpoint = options.endpoint;
    if (!active || path === null || workspaceId === null || endpoint === null || typeof fetch !== "function") {
      controller.current?.stop();
      controller.current = null;
      if (path !== null) options.onOwned?.(path, false);
      setState(emptyState);
      return;
    }

    const origin = gatewayOriginFrom(endpoint);
    if (origin === null) return;
    let stopped = false;
    const transport = {
      mint: async (rejected?: string) => {
        const grant = await mint({ workspaceId: workspaceId as never }, rejected === undefined ? false : { rejected });
        return grant.accessToken;
      },
      request: async (token: string, body: { path: string; documentId?: string; update?: string; replacement?: { expectedEtag: string; text: string } }): Promise<CollaborationResponse> => {
        // A request with no deadline holds the controller's single flush slot
        // for as long as the connection hangs, and every later edit queues
        // behind it with "Syncing" on screen. A timeout is a network failure:
        // the queue is kept and retried.
        const abort = typeof AbortController === "function" ? new AbortController() : null;
        const deadline = setTimeout(() => abort?.abort(), COLLABORATION_REQUEST_TIMEOUT_MS);
        let response: Response;
        let value: unknown;
        try {
          response = await fetch(new URL("/collaboration", origin).toString(), {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(body),
            ...(abort === null ? {} : { signal: abort.signal }),
          });
          value = await response.json().catch(() => null);
          if (abort?.signal.aborted) throw new TypeError("Collaboration request timed out");
        } catch (error) {
          if (abort?.signal.aborted) throw new TypeError("Collaboration request timed out");
          throw error;
        } finally {
          clearTimeout(deadline);
        }
        // The status, never the body's `error` code: the controller decides
        // revoked (401/403), unavailable (404) and retryable (5xx) from it, and
        // the gateway's bodies say `invalid_token`, `not_found` and
        // `collaboration_unavailable` — which matched none of those, so a real
        // refusal or outage landed on a generic error that never retried.
        if (!response.ok) throw new Error(String(response.status));
        if (!value || typeof value !== "object") throw new Error("Malformed collaboration response");
        const row = value as Record<string, unknown>;
        if (
          typeof row.documentId !== "string" ||
          typeof row.update !== "string" ||
          typeof row.text !== "string" ||
          typeof row.etag !== "string"
        ) throw new Error("Malformed collaboration response");
        return {
          documentId: row.documentId,
          update: row.update,
          text: row.text,
          etag: row.etag,
          ...(typeof row.applied === "boolean" ? { applied: row.applied } : {}),
          ...(typeof row.pendingDependencies === "boolean" ? { pendingDependencies: row.pendingDependencies } : {}),
        };
      },
    };
    let next: DurableCollaborationController;
    next = new DurableCollaborationController({
      workspaceId,
      path,
      scope: options.scope,
      initialText: options.initialText(),
      legacyDraft: options.legacyDraft?.(),
      transport,
      online: () => typeof navigator === "undefined" || navigator.onLine !== false,
      canWrite: () => callbacks.current.editable,
      onText: (text) => {
        if (!stopped) callbacks.current.onText(text);
      },
      onState: (nextState) => {
        if (stopped) return;
        setState({
          mode: "durable",
          ready: nextState.ready,
          status: nextState.status,
          pending: nextState.pending,
          etag: nextState.etag,
          documentId: nextState.documentId,
          shared: next.state.shared,
          text: nextState.text,
          revision: next?.state.revision ?? "",
          ...(nextState.recovery === undefined ? {} : { recovery: nextState.recovery }),
          ...(nextState.legacyAdopted === undefined ? {} : { legacyAdopted: nextState.legacyAdopted }),
          onUpdate: (documentId, update) => next.applyLocalUpdate(documentId, update),
          onChange: (text) => next.changeForHook(text),
          onVersionedChange: (text, base) => next.changeVersionedForHook(text, base),
          repair: () => next.repairForHook(),
          subscribeLiveUpdates: (listener) => next.subscribeLiveUpdates(listener),
          receiveLiveUpdate: (documentId, update) => next.receiveLiveUpdate(documentId, update),
        });
        callbacks.current.onState?.({
          text: nextState.text,
          etag: nextState.etag,
          status: nextState.status,
          pending: nextState.pending,
          ...(nextState.recovery === undefined ? {} : { recovery: nextState.recovery }),
          ...(nextState.legacyAdopted === undefined ? {} : { legacyAdopted: nextState.legacyAdopted }),
        });
        setGeneration((value) => value + 1);
      },
    });
    controller.current = next;
    options.onOwned?.(path, true);
    void next.start();
    // Online again, and also focus: a rollout can briefly return 404 while
    // the gateway route is being promoted. Retry when the app becomes usable
    // again even though the presence socket is intentionally closed in
    // `unavailable` state.
    const stopRepairing = onReturnToApp(() => next.repairForHook());
    return () => {
      stopped = true;
      stopRepairing();
      options.onOwned?.(path, false);
      next.stop();
      if (controller.current === next) controller.current = null;
    };
    // The note identity is the resource. Text and callbacks are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, options.endpoint, mint, options.path, options.scope, options.workspaceId]);

  const current = controller.current;
  const subscribeLiveUpdates = useCallback((listener: (frame: LiveUpdate) => void) =>
    current?.subscribeLiveUpdates(listener) ?? (() => {}), [current]);
  const message = state.recovery === undefined ? statusMessage(state.status) : "An older offline draft needs review before it can sync.";
  return useMemo(
    () => {
      if (!active || current === null) return undefined;
      return {
        ...state,
        text: current.state.text,
        revision: current.state.revision,
        shared: current.state.shared,
        onChange: (text: string) => {
          if (callbacks.current.editable) current.changeForHook(text);
        },
        onVersionedChange: (text: string, base: string) => {
          if (callbacks.current.editable) current.changeVersionedForHook(text, base);
        },
        onUpdate: (documentId: string, update: string) => {
          if (!callbacks.current.editable) return false;
          return current.applyLocalUpdate(documentId, update);
        },
        repair: () => current.repairForHook(),
        subscribeLiveUpdates,
        receiveLiveUpdate: (documentId, update) => current.receiveLiveUpdate(documentId, update),
        ...(message === undefined ? {} : { message }),
      };
    },
    // generation makes controller state changes visible; state itself carries the public values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, current, generation, message, state, subscribeLiveUpdates],
  );
}
