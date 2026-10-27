/**
 * The Convex tree, read for the agent tools (`../tree/served.js`).
 *
 * Spends the same two proofs `/gateway/site` does: the gateway secret, and the
 * person's own access token. The control plane chooses the workspace from the
 * token's grant and the clearance from the person's role in it, so nothing
 * this gateway concludes about either can widen what comes back.
 */
import { ControlPlaneError } from "./client.js";

/** A manifest page is a few thousand names; a slow one costs the tool its answer, and it says so. */
export const TREE_MANIFEST_TIMEOUT_MS = 6_000;

/**
 * Bytes one tree answer may be. A manifest page is up to 10,000 names
 * (`GATEWAY_PAGE_ENTRIES`) and a props answer up to 100 notes' front matter;
 * the 256 KB every other control-plane answer is held to refused any
 * workspace past about three thousand notes, which then listed the bucket.
 */
export const TREE_RESPONSE_BYTE_CAP = 16_000_000;

export function createTreeMethods({ post }) {
  return {
    /**
     * One page of the keys this grant may see in the workspace, from the
     * Convex tree: `{ served: true, entries, cursor }`, or `{ served: false }`
     * where the tree does not serve it (and for every refusal), when the
     * bucket answers instead.
     *
     * @param {string} accessToken
     * @param {string} expectedWorkspaceId
     * @param {{cursor?: string, folder?: string}} page
     */
    async readTreeManifest(accessToken, expectedWorkspaceId, page = {}) {
      const parsed = await post(
        "/gateway/tree/manifest",
        {
          accessToken,
          expectedWorkspaceId,
          ...(typeof page.cursor === "string" ? { cursor: page.cursor } : {}),
          ...(typeof page.folder === "string" ? { folder: page.folder } : {}),
        },
        { timeoutMs: TREE_MANIFEST_TIMEOUT_MS, maxBytes: TREE_RESPONSE_BYTE_CAP }
      );
      if (!parsed || parsed.served !== true) return { served: false };
      if (!Array.isArray(parsed.entries) || !(parsed.cursor === null || typeof parsed.cursor === "string")) {
        throw new ControlPlaneError("malformed tree manifest");
      }
      return { served: true, entries: parsed.entries, cursor: parsed.cursor };
    },

    /**
     * The tree's facts for this grant (`/gateway/tree/facts`): a move's link
     * candidates (`{ ask: "links", sources, names }`) or the chaos score's
     * extras and history (`{ ask: "chaos", today? }`), notes' props
     * (`{ ask: "props", paths }`), one note's links and backlinks
     * (`{ ask: "neighbors", path }`, `../tools/related.js`), or, for a writer, which names are taken
     * and how many notes there are (`{ ask: "names", paths?, count? }`,
     * `../tree/names.js`). `{ served: false }`
     * where the tree does not serve it, and for every refusal.
     *
     * @param {string} accessToken
     * @param {string} expectedWorkspaceId
     * @param {{ask: "links", sources: string[], names: string[]} | {ask: "chaos", today?: {all: number, team: number}} | {ask: "props", paths: string[]} | {ask: "names", paths?: string[], count?: boolean}} request
     */
    async readTreeFacts(accessToken, expectedWorkspaceId, request) {
      const parsed = await post(
        "/gateway/tree/facts",
        {
          ask: request?.ask,
          ...(Array.isArray(request?.sources) ? { sources: request.sources } : {}),
          ...(Array.isArray(request?.names) ? { names: request.names } : {}),
          ...(Array.isArray(request?.paths) ? { paths: request.paths } : {}),
          ...(typeof request?.path === "string" ? { path: request.path } : {}),
          ...(request?.today ? { today: request.today } : {}),
          ...(request?.count === true ? { count: true } : {}),
          // Last, so nothing in the request can stand in for the person's token.
          accessToken,
          expectedWorkspaceId,
        },
        { timeoutMs: TREE_MANIFEST_TIMEOUT_MS, maxBytes: TREE_RESPONSE_BYTE_CAP }
      );
      if (!parsed || parsed.served !== true) return { served: false };
      return parsed;
    },

    /**
     * The whole forwarding ledger for a queued move, proved by its job ticket
     * while the job holds its lease (`/gateway/tree/facts`, `ask:
     * "forwarding"`). The job runs at `private` clearance, so nothing is held
     * back; `{ served: false }` for every refusal.
     *
     * @param {string} ticket
     * @param {string} expectedWorkspaceId
     */
    async readJobLedger(ticket, expectedWorkspaceId) {
      const parsed = await post(
        "/gateway/tree/facts",
        { ask: "forwarding", ticket, expectedWorkspaceId },
        { timeoutMs: TREE_MANIFEST_TIMEOUT_MS, maxBytes: TREE_RESPONSE_BYTE_CAP }
      );
      if (!parsed || parsed.served !== true) return { served: false };
      return parsed;
    },

    /**
     * A move's forwarding addresses (`{ from, to, kind }`) or the icons it
     * carries (`{ from, to }`), recorded in the control plane's rows
     * (`/gateway/tree/touch`, `apps/convex/functions/smallData.ts`), which
     * write `.context/forwarding.json` and `.context/folder-icons.json`
     * behind them. Awaited, unlike the rest of a touch, so the next read
     * follows the move. Paths only; at most `SMALL_DATA_BATCH` a request.
     *
     * @param {string} workspaceId
     * @param {{forwarding?: {from: string, to: string, kind: "note"|"folder"}[], icons?: {from: string, to: string}[]}} moved
     */
    async recordMoved(workspaceId, moved) {
      if (typeof workspaceId !== "string" || !workspaceId) return null;
      for (const field of ["forwarding", "icons"]) {
        const list = Array.isArray(moved?.[field]) ? moved[field] : [];
        for (let at = 0; at < list.length; at += SMALL_DATA_BATCH) {
          await post("/gateway/tree/touch", { workspaceId, [field]: list.slice(at, at + SMALL_DATA_BATCH) });
        }
      }
      return true;
    },

    /**
     * The cover just drawn of a `.page.md` note (`draw_visual` template
     * `page`), kept in the person's bucket so a linked page's card shows it
     * (`/gateway/page-cover`). True once kept; false for every refusal.
     *
     * @param {string} accessToken
     * @param {string} expectedWorkspaceId
     * @param {string} path
     * @param {string} png base64
     */
    async recordPageCover(accessToken, expectedWorkspaceId, path, png) {
      if (typeof png !== "string" || png.length > MAX_COVER_CHARS) return false;
      const parsed = await post("/gateway/page-cover", { path, png, accessToken, expectedWorkspaceId }, { timeoutMs: PAGE_COVER_TIMEOUT_MS });
      return parsed?.recorded === true;
    },
  };
}

/** A cover's base64, at most: the control plane takes up to 2 MB of picture (`MAX_COVER_BYTES`). */
export const MAX_COVER_CHARS = 2_666_668;
/** Writing a cover is a bucket write; it never holds up the turn for long. */
export const PAGE_COVER_TIMEOUT_MS = 8_000;

/** Forwarding addresses or icon moves one request carries: the control plane's `TOUCH_SMALL_DATA`. */
export const SMALL_DATA_BATCH = 100;
