/**
 * Creating and deleting one workspace's meaning index (a Cloudflare Vectorize
 * index), over Cloudflare's REST API.
 *
 * The control plane's half of search by meaning, shaped exactly like
 * `lib/d1.ts` is for fast search: it makes the index and deletes it, and never
 * reads a note. What goes *into* the index is decided in the gateway
 * (`apps/mcp/src/search/meaning/`), beside the search it serves.
 *
 * ## The credential
 *
 * The same token and account as fast search (`SEARCH_D1_API_TOKEN`,
 * `SEARCH_D1_ACCOUNT_ID`), which needs Vectorize:Edit and Workers AI:Read on
 * top of D1:Edit. One token for the account that holds customers' derived
 * search data, rather than a second one to configure, rotate and forget.
 *
 * ## Errors
 *
 * Our codes, from the same closed set as `lib/d1.ts`, never the provider's
 * text on a row: a provider message can name the account, the index or the
 * token. Cloudflare's own account of a failure travels as `detail` for the
 * structured log, beside the workspace id and nothing else.
 */

import { CLOUDFLARE_API_BASE } from "./d1";

export type MeaningErrorCode =
  | "NOT_CONFIGURED"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "REFUSED";

export class MeaningIndexError extends Error {
  readonly code: MeaningErrorCode;
  /** Cloudflare's own words, for the log only. Never a row, never a screen. */
  readonly detail: string;
  constructor(code: MeaningErrorCode, message: string, detail = "") {
    super(message);
    this.name = "MeaningIndexError";
    this.code = code;
    this.detail = detail;
  }
}

export interface MeaningConfig {
  accountId: string;
  apiToken: string;
  fetchImpl?: typeof globalThis.fetch;
}

interface Envelope<T> {
  success: boolean;
  result?: T;
  errors?: { code?: number; message?: string }[];
}

function providerDetail(status: number, body: Envelope<unknown> | null): string {
  const said = (body?.errors ?? [])
    .map((entry) => [entry.code, entry.message].filter((part) => part !== undefined).join(" "))
    .filter((part) => part.length > 0);
  return said.length === 0 ? `HTTP ${status}` : `HTTP ${status}: ${said.join("; ")}`;
}

function classify(status: number, body: Envelope<unknown> | null): MeaningIndexError {
  const detail = providerDetail(status, body);
  if (status === 401 || status === 403) {
    return new MeaningIndexError("UNAUTHORIZED", "The search credential was refused.", detail);
  }
  if (status === 404) {
    return new MeaningIndexError("NOT_FOUND", "That meaning index does not exist.", detail);
  }
  if (status === 429) {
    return new MeaningIndexError("RATE_LIMITED", "Cloudflare is rate limiting this account.", detail);
  }
  if (status >= 500) {
    return new MeaningIndexError("UNAVAILABLE", "Cloudflare did not answer. Retry.", detail);
  }
  return new MeaningIndexError("REFUSED", `Cloudflare refused the request (${status}).`, detail);
}

async function call<T>(
  config: MeaningConfig,
  path: string,
  init: { method: string; body?: unknown },
): Promise<T> {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${CLOUDFLARE_API_BASE}${path}`, {
      method: init.method,
      headers: {
        // The token appears here and nowhere else.
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "manual",
    });
  } catch {
    // The caught error can quote the request, headers included. Dropped.
    throw new MeaningIndexError("UNAVAILABLE", "Cloudflare could not be reached.");
  }
  let body: Envelope<T> | null = null;
  try {
    body = (await response.json()) as Envelope<T>;
  } catch {
    body = null;
  }
  if (!response.ok || body?.success !== true) throw classify(response.status, body);
  return body.result as T;
}

/** The model's fingerprint size. Must match `apps/mcp/src/search/meaning/embed.js`. */
export const MEANING_DIMENSIONS = 1024;

/** Vectorize's cap on an index name. */
const MEANING_INDEX_NAME_MAX = 64;

/**
 * The index's name: a fixed prefix and the immutable workspace id.
 *
 * Never truncated, for `databaseNameFor`'s reason: adoption below treats an
 * index of this name as this workspace's, which is only true while two
 * workspaces cannot produce one name.
 */
export function meaningIndexNameFor(workspaceId: string): string {
  if (!workspaceId) throw new Error("a meaning index needs a workspace id to be named after");
  // Not lowercased to fit: Vectorize names are lowercase, and folding an id's
  // case could give two workspaces one name. Convex ids are lowercase today;
  // an id format that is not fails here loudly rather than merging tenants.
  const name = `context-meaning-${workspaceId}`;
  if (!/^[a-z][a-z0-9-]*$/.test(name) || name.length > MEANING_INDEX_NAME_MAX) {
    throw new Error(
      `a meaning index name must be lowercase letters, digits and dashes, at most ${MEANING_INDEX_NAME_MAX} long; ` +
        "this workspace id does not fit, and reshaping it could let two workspaces share an index",
    );
  }
  return name;
}

export interface MeaningIndexInfo {
  name: string;
}

async function createIndex(config: MeaningConfig, name: string): Promise<MeaningIndexInfo> {
  return await call<MeaningIndexInfo>(config, `/accounts/${config.accountId}/vectorize/v2/indexes`, {
    method: "POST",
    body: {
      name,
      description: "Context: search by meaning for one workspace",
      config: { dimensions: MEANING_DIMENSIONS, metric: "cosine" },
    },
  });
}

async function getIndex(config: MeaningConfig, name: string): Promise<MeaningIndexInfo | null> {
  try {
    const found = await call<MeaningIndexInfo>(
      config,
      `/accounts/${config.accountId}/vectorize/v2/indexes/${encodeURIComponent(name)}`,
      { method: "GET" },
    );
    return found && found.name === name ? found : null;
  } catch (error) {
    if (error instanceof MeaningIndexError && error.code === "NOT_FOUND") return null;
    throw error;
  }
}

/**
 * The index for this workspace: created, or adopted if it already exists.
 *
 * Adopting is right for `ensureDatabase`'s reason: the name is a prefix and an
 * immutable, unguessable workspace id, and only this deployment makes indexes
 * in that account, so an index of that name **is** this workspace's — a create
 * whose answer was lost, or a release that forgot the row first. The lookup
 * runs only after a create fails, and a failed lookup rethrows the create's
 * error, which is what the caller was doing.
 */
export async function ensureMeaningIndex(
  config: MeaningConfig,
  name: string,
): Promise<{ index: MeaningIndexInfo; adopted: boolean }> {
  try {
    const index = await createIndex(config, name);
    return { index: { name: index?.name ?? name }, adopted: false };
  } catch (error) {
    if (!(error instanceof MeaningIndexError)) throw error;
    let existing: MeaningIndexInfo | null = null;
    try {
      existing = await getIndex(config, name);
    } catch {
      throw error;
    }
    if (existing === null) throw error;
    return { index: existing, adopted: true };
  }
}

/**
 * Make `tier` filterable. Vectorize only indexes metadata written *after* the
 * metadata index exists, so this runs before the first vector does. Already
 * there is success.
 */
export async function ensureTierFilter(config: MeaningConfig, name: string): Promise<void> {
  const base = `/accounts/${config.accountId}/vectorize/v2/indexes/${encodeURIComponent(name)}/metadata_index`;
  const listed = await call<{ metadataIndexes?: { propertyName?: string }[] }>(config, `${base}/list`, {
    method: "GET",
  });
  if ((listed?.metadataIndexes ?? []).some((entry) => entry?.propertyName === "tier")) return;
  await call<unknown>(config, `${base}/create`, {
    method: "POST",
    body: { propertyName: "tier", indexType: "string" },
  });
}

/** Delete the index. Already gone is a successful delete; anything else rethrows. */
export async function deleteMeaningIndex(config: MeaningConfig, name: string): Promise<void> {
  try {
    await call<unknown>(
      config,
      `/accounts/${config.accountId}/vectorize/v2/indexes/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
  } catch (error) {
    if (error instanceof MeaningIndexError && error.code === "NOT_FOUND") return;
    throw error;
  }
}

export const MEANING_MESSAGES: Readonly<Record<MeaningErrorCode, string>> = {
  NOT_CONFIGURED:
    "Search by meaning is not configured on this deployment yet. An administrator needs to set SEARCH_D1_API_TOKEN and SEARCH_D1_ACCOUNT_ID.",
  UNAUTHORIZED:
    "The configured Cloudflare token was refused. It needs Vectorize:Edit and Workers AI:Read on the account in SEARCH_D1_ACCOUNT_ID.",
  NOT_FOUND: "The meaning index could not be found.",
  RATE_LIMITED: "Cloudflare is rate limiting this account. Context tries again on its own.",
  UNAVAILABLE: "Cloudflare could not be reached. Context tries again on its own.",
  REFUSED: "Cloudflare refused the meaning index request.",
};

const TERMINAL: ReadonlySet<string> = new Set(["UNAUTHORIZED", "REFUSED", "NOT_CONFIGURED"]);

/** Will waiting fix this? Same rule as `isRetryableD1Error`. */
export function isRetryableMeaningError(code: string | undefined): boolean {
  return code !== undefined && !TERMINAL.has(code);
}

export function meaningMessageFor(code: string): string {
  return MEANING_MESSAGES[code as MeaningErrorCode] ?? MEANING_MESSAGES.REFUSED;
}
