export interface ConsoleGrant {
  accessToken: string;
  expiresAt: number;
  scopes: string[];
}

/**
 * How a caller asks for a grant.
 *
 * `false` takes the held one while it is fresh. `true` mints regardless.
 * `{ rejected }` is what a consumer passes after the gateway refused a token:
 * it mints only if that token is still the one held, so the editor, presence
 * and the agent reacting to the same rotation cause one mint rather than three
 * — and a consumer that was told about a token another consumer already
 * replaced simply receives the replacement. Minting for an instance revokes
 * that instance's previous token on the server, which is why this matters.
 */
export type GrantRefresh = boolean | { rejected: string };

/**
 * How long a mint may take before every caller waiting on it is told it failed.
 *
 * Without it one mint that never settles is returned to every consumer, for
 * every note, for as long as the tab is open: the pending promise is shared,
 * so a timeout in any one caller could not release it.
 */
export const GRANT_MINT_TIMEOUT_MS = 15_000;

/** A mint that did not answer in time. Retryable: nothing was refused. */
export class GrantTimeoutError extends Error {
  constructor() {
    super("Console grant timed out");
    this.name = "GrantTimeoutError";
  }
}

/**
 * The control plane's own "no": the workspace is not this person's any more,
 * or their role grants nothing. Unlike a socket close or a gateway 401 — which
 * a rotated or expired token also produces — this is an answer about
 * membership, and retrying or refreshing cannot change it. `NOT_AUTHENTICATED`
 * is deliberately absent: a Convex session between token refreshes says it
 * too, and signing out unmounts every consumer anyway.
 */
const DEFINITIVE_REFUSALS = new Set(["WORKSPACE_NOT_FOUND", "NO_SCOPES_GRANTED"]);

export function isDefinitiveGrantRefusal(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object") return false;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" && DEFINITIVE_REFUSALS.has(code);
}

/** One in-memory grant per workspace, shared by editor, presence and agent. */
export class ConsoleGrantCache {
  private grants = new Map<string, ConsoleGrant>();
  private pending = new Map<string, { ticket: number; promise: Promise<ConsoleGrant> }>();
  private tickets = 0;

  constructor(readonly instanceId: string, private readonly timeoutMs = GRANT_MINT_TIMEOUT_MS) {}

  get(workspaceId: string, mint: () => Promise<ConsoleGrant>, refresh: GrantRefresh = false): Promise<ConsoleGrant> {
    const pending = this.pending.get(workspaceId);
    if (pending) return pending.promise;
    const held = this.grants.get(workspaceId);
    const force = refresh === true ||
      (typeof refresh === "object" && held !== undefined && held.accessToken === refresh.rejected);
    if (!force && held && held.expiresAt - Date.now() > 60_000) return Promise.resolve(held);

    const ticket = ++this.tickets;
    const release = () => {
      if (this.pending.get(workspaceId)?.ticket === ticket) this.pending.delete(workspaceId);
    };
    const promise = new Promise<ConsoleGrant>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        release();
        reject(new GrantTimeoutError());
      }, this.timeoutMs);
      mint().then((grant) => {
        clearTimeout(timer);
        // A mint answering after its deadline is discarded, never cached: a
        // newer mint may already be held, and the callers have moved on.
        if (settled) return;
        settled = true;
        this.grants.set(workspaceId, grant);
        release();
        resolve(grant);
      }, (error: unknown) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        release();
        reject(error);
      });
    });
    this.pending.set(workspaceId, { ticket, promise });
    return promise;
  }
}
