/**
 * Tex's notes, from the control plane's own stores (decided by the owner,
 * 2026-10-31; `docs/decisions/texting-assistant/tex-durable-objects.md`).
 *
 * A Tex note's row keys it in a Durable Object (`tex/<owner>/notes/<id>.md`),
 * which only the gateway can reach. The stores this deployment builds for
 * Download as folders, the trash's emptying and filing a shared edit pass
 * `texStore` from here, so a Tex key among the notes they handle goes to the
 * gateway's door (`apps/mcp/src/texStore/door.js`) with the gateway secret and
 * a ticket for this workspace, and from there to the object. Without the
 * gateway's origin or the secret it answers `null`, and the store refuses a
 * Tex key rather than look for it in the bucket (`store/texRouting.js`).
 */

import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { R2Store } from "../../../mcp/src/store/r2.js";
import { texBucket } from "../../../mcp/src/texStore/wire.js";
import { hashToken } from "./crypto";
import { GATEWAY_SECRET_ENV_VAR, randomOpaqueToken } from "./gatewayAuth";
import { storageMoverOrigin } from "./storageMover";

const TEX_STORE_PATH = "/internal/tex-store";
/** One call to a Durable Object, as long as a slow note read may take. */
const CALL_TIMEOUT_MS = 30_000;

type Options = { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> };

/**
 * The `texStore` option for a console store of `workspaceId`, or `null` when
 * this deployment cannot reach the gateway. One ticket per store, minted on
 * the first Tex key it meets.
 */
export function consoleTexStore(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  options: Options = {},
): ((owner: string) => unknown) | null {
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
        owners: [`person:${workspaceId}`],
        now: Date.now(),
      });
      return minted;
    })());
  return (owner: string) =>
    new R2Store(
      texBucket({
        async fetch(request: Request) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
          try {
            return await doFetch(`${origin}${TEX_STORE_PATH}`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${secret}`,
                "x-tex-ticket": await ticketNow(),
                "x-tex-owner": owner,
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
      }),
    );
}
