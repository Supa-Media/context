/**
 * The three ingest routes, and the one decision they exist to enforce.
 *
 * ============================================================================
 * MAIL LANDS IN A PERSONAL CONTEXT AND NOWHERE ELSE
 * ============================================================================
 *
 * That is the product decision, and everything in this file is downstream of
 * it. `describe("a shared context cannot receive mail")` is the load-bearing
 * block: it asserts not merely that a shared context is refused, but that its
 * refusal is **byte-identical** to the refusal for a name nobody has ever
 * claimed. Anything less publishes, to anyone with a mail client, which names on
 * this domain are teams.
 *
 * The fingerprint comparison is the same discipline `controlPlane.test.ts`
 * applies to `{"binding":null}`: status, every header, and the body — because
 * "that property dies the moment one path sets a different header".
 *
 * ============================================================================
 * WHAT THE ROUTES MAY AND MAY NOT DO
 * ============================================================================
 *
 *  - `/gateway/ingest/resolve` is behind the **email worker's** secret, not the
 *    gateway's. Both directions are asserted: neither secret opens the other's
 *    routes.
 *  - It hands back a policy and a ticket, and never a credential. A message
 *    that is going to be refused for policy causes no decrypt at all.
 *  - `/gateway/ingest/binding` takes only a ticket. Nothing a caller sends can
 *    name a context, and the ticket is single-use and short-lived.
 *
 * Every value here is obviously fake. This repository is public.
 */

import type { Id } from "../../_generated/dataModel";
import {
  type TestConvex,
  createUser,
  createWorkspace,
  ingestPost,
  seedStorageBinding,
  setupTest,
} from "../fixtures.helpers";

export const OWNER_EMAIL = "owner@example.test";

export const RESOLVE = "/gateway/ingest/resolve";
export const BINDING = "/gateway/ingest/binding";
export const RECORD = "/gateway/ingest/record";

/**
 * A person with a personal context whose storage is connected — everything an
 * inbound message needs in order to be captured.
 */
export async function ready(slug = "seyi"): Promise<{
  t: TestConvex;
  ownerId: Id<"users">;
  workspaceId: Id<"workspaces">;
}> {
  const t = setupTest();
  const ownerId = await createUser(t, OWNER_EMAIL);
  const workspaceId = await createWorkspace(t, ownerId, slug, { kind: "personal" });
  await seedStorageBinding(t, { workspaceId, boundBy: ownerId, status: "connected" });
  return { t, ownerId, workspaceId };
}

export async function resolve(t: TestConvex, name: string, sizeBytes = 4096) {
  return await ingestPost(t, RESOLVE, { username: name, sizeBytes, envelopeFrom: "sender@example.test" });
}

export async function resolvedTicket(t: TestConvex, name: string): Promise<string> {
  const body = await (await resolve(t, name)).json();
  return body.ingestion.ticket as string;
}
