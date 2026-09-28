/**
 * Connected clients that are integrations, not agents: never offered as owners.
 *
 * An owner picker's agents are the AI clients connected to a workspace, the
 * ones that could pick a project up. Some connections are not that. The Sentry
 * incident inbox (`infra/sentry-worker`) signs in over the same OAuth road to
 * file one note per new error, and nobody can hand it a project; offering it
 * beside Claude is noise (Dev2, 2026-09-28).
 *
 * An integration says so when it registers, with a `software_id` starting
 * `context-integration` (`context-integration:sentry-inbox`). The Sentry
 * Worker's client was registered before that convention, under the name
 * below, so it is recognised by that name as well.
 *
 * Both signals are client-asserted, and that is fine here: all this decides
 * is that a client is **left out** of a list of suggestions. Claiming to be an
 * integration hides a client from its own owner's picker and grants nothing.
 */

export const INTEGRATION_SOFTWARE_PREFIX = "context-integration";

/** Clients registered before `software_id` said so, by the name they registered with. */
const KNOWN_INTEGRATION_NAMES: readonly string[] = ["context sentry incident inbox"];

export function isIntegrationClient(client: { clientName?: string; softwareId?: string } | null): boolean {
  if (client === null) return false;
  if (client.softwareId?.startsWith(INTEGRATION_SOFTWARE_PREFIX)) return true;
  const name = client.clientName?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
  return KNOWN_INTEGRATION_NAMES.includes(name);
}
