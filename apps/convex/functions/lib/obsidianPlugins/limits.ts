/**
 * How much a plugin may ask for, and how long what it is given lasts.
 * `MAX_PLUGIN_ASSET_BYTES` stays in `functions/obsidianPlugins.ts`, where the
 * gateway's plugin test reads it.
 *
 * Split out of `functions/obsidianPlugins.ts`, which keeps every registered
 * plugin function; this module registers none.
 */

export const MAX_GRANTS_RETURNED = 200;
export const MAX_CAPABILITIES = 8;
export const MAX_NETWORK_HOSTS = 12;
export const MAX_NETWORK_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_NETWORK_REDIRECTS = 3;
export const NETWORK_REQUEST_TIMEOUT_MS = 20_000;
export const COMMUNITY_REGISTRY_URL =
  "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/community-plugins.json";
export const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
export const RUNTIME_SESSION_MS = 15 * 60 * 1_000;
export const PLUGIN_EGRESS_URL_ENV = "PLUGIN_EGRESS_URL";
export const PLUGIN_EGRESS_SECRET_ENV = "PLUGIN_EGRESS_SECRET";
