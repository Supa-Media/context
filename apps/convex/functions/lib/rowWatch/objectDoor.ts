/**
 * One `ws.*` call to a workspace's object from the control plane, through the gateway's door
 * (`apps/mcp/src/workspaceStore/door.js`): the gateway secret, and a ticket minted here for this workspace. The
 * door opens the ticket's workspace's object, never one the caller names, and rewrites the call to name it.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { GATEWAY_SECRET_ENV_VAR, randomOpaqueToken } from "../gatewayAuth";
import { storageMoverOrigin } from "../storageMover";

export const WORKSPACE_STORE_PATH = "/internal/workspace-store";
const CALL_TIMEOUT_MS = 30_000;

export class ObjectUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectUnreachable";
  }
}

type Options = { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> };

/**
 * A stub-shaped way to one workspace's object (`fetch(request)`, as a Durable Object stub answers), through the
 * door, one ticket for the lot; `null` without the gateway's origin or secret.
 */
export function doorStub(ctx: ActionCtx, workspaceId: Id<"workspaces">, options: Options = {}): { fetch: (request: Request) => Promise<Response> } | null {
  const env = options.env ?? process.env;
  const origin = storageMoverOrigin(env);
  const secret = env[GATEWAY_SECRET_ENV_VAR];
  if (origin === null || !secret) return null;
  const doFetch = options.fetchImpl ?? fetch;
  let ticket: Promise<string> | null = null;
  const ticketNow = () =>
    (ticket ??= (async () => {
      const minted = randomOpaqueToken();
      await ctx.runMutation(internal.functions.texStoreTickets.mint, {
        hashedTicket: await hashToken(minted),
        workspaceId,
        // The door reads only the ticket's workspace; the owner list is the Tex door's, held to this workspace's own.
        owners: [`person:${workspaceId}`],
        now: Date.now(),
      });
      return minted;
    })());
  return {
    async fetch(request: Request) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
      try {
        return await doFetch(`${origin}${WORKSPACE_STORE_PATH}`, {
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
}

/** `call(op, fields)` for one workspace's object; throws `ObjectUnreachable` on any failure. */
export function objectDoor(ctx: ActionCtx, workspaceId: Id<"workspaces">, options: Options = {}) {
  const stub = doorStub(ctx, workspaceId, options);
  return async function call<T = unknown>(op: string, fields: Record<string, unknown> = {}): Promise<T> {
    if (stub === null) throw new ObjectUnreachable("this deployment has no way to the gateway");
    let response: Response;
    try {
      response = await stub.fetch(
        new Request("https://workspace-store.internal/call", {
          method: "POST",
          headers: { "x-tex-call": encodeURIComponent(JSON.stringify({ op })) },
          body: JSON.stringify(fields),
        }),
      );
    } catch (error) {
      throw new ObjectUnreachable(`${op}: ${error instanceof Error ? error.name : "failed"}`);
    }
    if (!response.ok) throw new ObjectUnreachable(`${op}: ${response.status}`);
    return (await response.json()) as T;
  };
}
