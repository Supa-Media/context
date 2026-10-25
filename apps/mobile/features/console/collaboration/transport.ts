import type { CollaborationResponse, CollaborationTransport } from "./durable";

/** Long enough for a large note on a slow link; short enough to not strand the queue. */
const COLLABORATION_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The gateway's `/collaboration` route at `origin`, with `mint` for its bearer.
 * Shared by an open note's controller and the closed-note sender.
 */
export function collaborationTransport(origin: string, mint: (rejected?: string) => Promise<string>): CollaborationTransport {
  return {
    mint,
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
}
