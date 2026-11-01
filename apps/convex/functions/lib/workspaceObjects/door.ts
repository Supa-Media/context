/**
 * The control plane's client for one workspace's object (decided by the owner,
 * 2026-11-01; `docs/decisions/storage-and-credentials/workspace-objects.md`).
 *
 * Only the gateway holds the `WORKSPACE_STORE` binding, so the copy and
 * compare actions reach the object through its door
 * (`apps/mcp/src/workspaceStore/door.js`): the gateway secret, and a ticket
 * minted here for this workspace. The door opens the ticket's workspace and
 * rewrites every `ws.*` call to name it, so a caller cannot reach another's.
 *
 * The client itself is the gateway's (`workspaceClient`), given a stand-in for
 * the binding whose one stub forwards each call to the door: one client shape,
 * not a second one that could drift.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { workspaceClient } from "../../../../mcp/src/workspaceStore/api.js";
import { TEX_STORE_TICKET_TTL_MS } from "../../texStoreTickets";
import { hashToken } from "../crypto";
import { GATEWAY_SECRET_ENV_VAR, randomOpaqueToken } from "../gatewayAuth";
import { storageMoverOrigin } from "../storageMover";

const DOOR_PATH = "/internal/workspace-store";
/** One call, as long as a large note's write may take. */
const CALL_TIMEOUT_MS = 30_000;
/** A ticket is re-minted this long before it would expire, so a long copy never sends a stale one. */
const TICKET_MARGIN_MS = 60_000;

export type WorkspaceObjectClient = NonNullable<ReturnType<typeof workspaceClient>>;

type Options = { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> };

/** The client for `workspaceId`'s object, or `null` when this deployment cannot reach the gateway. */
export function consoleWorkspaceClient(ctx: ActionCtx, workspaceId: Id<"workspaces">, options: Options = {}): WorkspaceObjectClient | null {
  const env = options.env ?? process.env;
  const origin = storageMoverOrigin(env);
  const secret = env[GATEWAY_SECRET_ENV_VAR];
  if (origin === null || !secret) return null;
  const doFetch = options.fetchImpl ?? fetch;
  let ticket: { value: Promise<string>; until: number } | null = null;
  const ticketNow = async (): Promise<string> => {
    const now = Date.now();
    if (ticket === null || now >= ticket.until) {
      const until = now + TEX_STORE_TICKET_TTL_MS - TICKET_MARGIN_MS;
      ticket = {
        until,
        value: (async () => {
          const minted = randomOpaqueToken();
          await ctx.runMutation(internal.functions.texStoreTickets.mint, {
            hashedTicket: await hashToken(minted),
            workspaceId,
            owners: [`person:${workspaceId}`],
            now,
          });
          return minted;
        })(),
      };
    }
    return await ticket.value;
  };
  const stub = {
    async fetch(request: Request): Promise<Response> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
      try {
        return await doFetch(`${origin}${DOOR_PATH}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${secret}`,
            "x-workspace-ticket": await ticketNow(),
            "x-tex-call": request.headers.get("x-tex-call") ?? "",
          },
          body: await request.arrayBuffer(),
          signal: controller.signal,
          redirect: "manual",
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
  // The binding's stand-in: every name opens the one stub above, which the door pins to `workspaceId`.
  const binding = { idFromName: (name: string) => name, get: () => stub };
  return workspaceClient({ WORKSPACE_STORE: binding }, String(workspaceId)) as WorkspaceObjectClient;
}
