/**
 * Runaway-pagination guards against the worker, R2/S3 onlyIf validation parity,
 * and folder paths that keep their trailing slash through the tool layer.
 *
 * Split out of store.test.mjs; see fixtures.mjs for the shared S3/R2 stubs.
 *
 * @param {(label: string, ok: boolean) => void} check
 * @param {{ env: object, ownerToken: string }} gateway a live control-plane-backed
 *   environment from the main suite, so the worker checks below authenticate the
 *   same way every other request does — there is no other way in.
 */

import { worker, R2Store } from "./fixtures.mjs";
import { TREE_UNREACHABLE } from "../../src/tree/served.js";

export async function runStoreGuardChecks(check, gateway) {
  /* --------------------------- pagination guard ---------------------------- */

  // The listing loops (`src/tree/served.js`) are driven by the control plane's
  // manifest pages. A plane that always answers "more" — or replays one
  // continuation token — used to spin until the Workers subrequest limit killed
  // the request with an opaque error. Each shape must stop and say why.
  // The hostile plane is reached the only way any plane is reached: through a
  // live grant on the harness's control plane. The bucket is bound natively so
  // the walk is tested without a second S3 backend in the way.
  const hostileEnv = (list) => ({
    ...gateway.env,
    CONTEXT_BUCKET: {
      async get() {
        return null;
      },
      async put() {
        return { etag: "x" };
      },
      async delete() {},
      list,
    },
  });
  const hostileRpc = async (list, method, params) => {
    const response = await worker.fetch(
      new Request("https://x/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${gateway.ownerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
      hostileEnv(list),
      { waitUntil() {} }
    );
    const parsed = await response.json();
    if (process.env.DEBUG_STORE) console.error("HOSTILE", response.status, JSON.stringify(parsed));
    return parsed;
  };
  const hostileCall = (list, args, tool = "search_notes") =>
    hostileRpc(list, "tools/call", { name: tool, arguments: args });

  // Every name a listing gives comes from the control plane's tree (`tree/served.js`), read a page
  // at a time through `/gateway/tree/manifest`, so that manifest is the walk these guards cover.
  // The control plane here is hostile: `pageOf(n)` answers manifest page n, and `pages` counts the
  // manifest requests the gateway made. `list_notes` reads the tree once per call, so the count is
  // that one walk's. A refusal is the tree's answer to any of them.
  const refusedAs = (answer) =>
    answer?.result?.isError === true && answer.result.content?.[0]?.text === TREE_UNREACHABLE;
  const hostileManifest = async (pageOf) => {
    const previous = globalThis.fetch;
    let pages = 0;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (!url.endsWith("/gateway/tree/manifest")) return previous(input, init);
      pages += 1;
      return new Response(JSON.stringify(pageOf(pages)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    try {
      const answer = await hostileCall(async () => ({ objects: [], truncated: false }), {}, "list_notes");
      return { answer, pages };
    } finally {
      globalThis.fetch = previous;
    }
  };

  const repeatedCursor = await hostileManifest(() => ({ served: true, entries: [], cursor: "same-token" }));
  check(
    "a control plane replaying one continuation token stops the listing instead of looping",
    refusedAs(repeatedCursor.answer) && repeatedCursor.pages === 2
  );

  // A third shape, and the one the two above do not cover: a page that carries
  // entries and no continuation at all, neither the finished `null` nor a
  // cursor. Read as finished, it would hand over a SHORT key set that looks
  // complete, and a partial answer is a wrong answer for a search or a move.
  // `control-plane/tree.js` refuses it as a malformed manifest.
  const noContinuation = await hostileManifest(() => ({
    served: true,
    entries: [{ path: "scratch/a.md" }],
  }));
  check(
    "a manifest page that names no continuation stops the listing instead of reading as complete",
    refusedAs(noContinuation.answer) && noContinuation.pages === 1
  );

  const runawayPages = await hostileManifest((page) => ({ served: true, entries: [], cursor: `page-${page}` }));
  check(
    "an endlessly truncated listing is capped rather than exhausting subrequests",
    refusedAs(runawayPages.answer) && runawayPages.pages === 50
  );

  // The connect handshake reads the root's delimited layout (`mcp/sessionInstructions.js`) and falls back to the
  // static instructions when that fails, so the cap shows as a walk that stops, and a handshake that still
  // completes. Its error is caught there, so the check reads the walk's own count.
  let delimitedPages = 0;
  const runawayLayout = await hostileRpc(
    async () => ({
      objects: [],
      delimitedPrefixes: [],
      truncated: true,
      cursor: `layout-${++delimitedPages}`,
    }),
    "initialize",
    { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } }
  );
  check(
    "the delimited layout walk is capped too, not just the flat key walk",
    Boolean(runawayLayout.result) && delimitedPages >= 1 && delimitedPages <= 200
  );

  const dotSegmentRead = await hostileCall(async () => ({ objects: [], truncated: false }), {
    query: "x",
    prefix: "1-projects/./secret",
  });
  check(
    "a tool path with a \".\" segment is refused by the tool layer, not just the adapter",
    /invalid prefix/.test(JSON.stringify(dotSegmentRead.result || dotSegmentRead))
  );


  /* ---------------- adapter parity: onlyIf validation (R2) ---------------- */

  // R2Store used to pass `onlyIf` straight through while S3Store validated it.
  // An R2Conditional with no etagMatches carries no condition, so a caller
  // asking for a conditional write would silently get last-writer-wins — the
  // failure the adapter exists to prevent. The in-memory stub shares R2's
  // blind spot (`if (expected && ...)`), so only an explicit check catches a
  // drift back.
  {
    const objects = new Map();
    const bucket = {
      async get() { return null; },
      async put() { return { etag: "e1" }; },
      async delete() {},
      async list() { return { objects: [], truncated: false }; },
    };
    const r2 = new R2Store(bucket);

    for (const [label, bad] of [
      ["an empty etag", { onlyIf: { etagMatches: "" } }],
      ["a whitespace etag", { onlyIf: { etagMatches: "   " } }],
      ["a missing etag", { onlyIf: {} }],
      ["a null onlyIf", { onlyIf: null }],
      ["a non-string etag", { onlyIf: { etagMatches: 42 } }],
    ]) {
      let rejected = false;
      try { await r2.put("1-projects/a.md", "x", bad); } catch { rejected = true; }
      check(`R2Store refuses a conditional write with ${label}`, rejected);
    }

    let injected = false;
    try {
      await r2.put("1-projects/a.md", "x", { onlyIf: { etagMatches: 'abc"\r\nx-evil: 1' } });
    } catch { injected = true; }
    check("R2Store refuses a header-injecting etag, as S3Store does", injected);

    let accepted = true;
    try { await r2.put("1-projects/a.md", "x", { onlyIf: { etagMatches: "abc123" } }); }
    catch { accepted = false; }
    check("R2Store still accepts a real conditional write", accepted);

    let unconditional = true;
    try { await r2.put("1-projects/a.md", "x"); } catch { unconditional = false; }
    check("R2Store still accepts an unconditional write", unconditional);
    void objects;
  }

  /* -------------------- folder paths keep a trailing slash ------------------- */

  // "1-projects/" is a natural way to name a folder. It used to survive
  // normalizePath, produce an empty final segment, and surface a reasonable
  // question as an internal error from the adapter.
  {
    const folderScope = await hostileCall(
      async () => ({ objects: [], truncated: false }),
      { path: "1-projects/" },
      "scope_info"
    );
    check(
      "scope_info accepts a folder path with a trailing slash",
      !/unsafe storage key|internal error/.test(JSON.stringify(folderScope))
    );

    const folderSearch = await hostileCall(async () => ({ objects: [], truncated: false }), {
      query: "anything",
      prefix: "1-projects/",
    });
    check(
      "search_notes accepts a folder prefix with a trailing slash",
      !/unsafe storage key|internal error|invalid prefix/.test(JSON.stringify(folderSearch))
    );
  }


}
