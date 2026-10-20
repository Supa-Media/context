/**
 * `/gateway/mail-health` and `/gateway/mail-health/raised` for the stub. The
 * real routes (`apps/convex/functions/lib/mailHealth/read.ts`) clear the owner
 * of a personal workspace; the stub models that with `clearedOwner` and
 * answers the mailboxes a test set for the workspace, or none. An uncleared
 * caller gets the bare null, as the real route answers everyone who may not
 * read. Every raise is kept, as `raised`, so a test can see what a check-in
 * said it texted.
 */

export function createMailHealthRoutes(clearedOwner) {
  /** workspaceId → `[{ address, state, lastSyncedAt, tell }]` */
  const mailboxes = new Map();
  const raised = [];

  async function handle(path, body) {
    if (path === "/gateway/mail-health") {
      const cleared = await clearedOwner(body);
      if (!cleared) return { mailboxes: null };
      return { mailboxes: mailboxes.get(cleared.workspaceId) ?? [] };
    }
    if (path === "/gateway/mail-health/raised") {
      const cleared = await clearedOwner(body);
      if (!cleared) return { raised: 0 };
      const given = Array.isArray(body.mailboxes) ? body.mailboxes : [];
      raised.push({ accessToken: body.accessToken, workspaceId: cleared.workspaceId, mailboxes: given });
      return { raised: given.length };
    }
    return undefined;
  }

  return { handle, mailboxes, raised };
}
