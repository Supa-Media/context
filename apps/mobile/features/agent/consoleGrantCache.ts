export interface ConsoleGrant {
  accessToken: string;
  expiresAt: number;
  scopes: string[];
}

/** One in-memory grant per workspace, shared by editor, presence and agent. */
export class ConsoleGrantCache {
  private grants = new Map<string, ConsoleGrant>();
  private pending = new Map<string, Promise<ConsoleGrant>>();

  constructor(readonly instanceId: string) {}

  get(workspaceId: string, mint: () => Promise<ConsoleGrant>, force = false): Promise<ConsoleGrant> {
    const pending = this.pending.get(workspaceId);
    if (pending) return pending;
    const held = this.grants.get(workspaceId);
    if (!force && held && held.expiresAt - Date.now() > 60_000) return Promise.resolve(held);
    const request = mint().then(grant => {
      this.grants.set(workspaceId, grant);
      return grant;
    }).finally(() => this.pending.delete(workspaceId));
    this.pending.set(workspaceId, request);
    return request;
  }
}
