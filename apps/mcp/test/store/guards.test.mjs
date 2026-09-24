/**
 * Runaway-pagination guards against the worker, R2/S3 onlyIf validation parity,
 * and folder paths that keep their trailing slash through the tool layer.
 *
 * Split out of store.test.mjs; see fixtures.mjs for the shared S3/R2/Dropbox stubs.
 *
 * @param {(label: string, ok: boolean) => void} check
 * @param {{ env: object, ownerToken: string }} gateway a live control-plane-backed
 *   environment from the main suite, so the worker checks below authenticate the
 *   same way every other request does — there is no other way in.
 */

import { worker, R2Store } from "./fixtures.mjs";

export async function runStoreGuardChecks(check, gateway) {
  /* --------------------------- pagination guard ---------------------------- */

  // The listing loops in src/index.js are driven by a customer-configured
  // endpoint. A backend that always answers "truncated" — or replays one
  // continuation token — used to spin until the Workers subrequest limit killed
  // the request with an opaque error. Both shapes must stop and say why.
  // The hostile bucket is reached the only way any bucket is reached: through a
  // live grant on the harness's control plane. It is bound natively so the
  // pagination guard is tested without a second S3 backend in the way.
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
  const hostileCall = async (list, args, tool = "search_notes") => {
    const response = await worker.fetch(
      new Request("https://x/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${gateway.ownerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: tool, arguments: args },
        }),
      }),
      hostileEnv(list),
      { waitUntil() {} }
    );
    const parsed = await response.json();
    if (process.env.DEBUG_STORE) console.error("HOSTILE", response.status, JSON.stringify(parsed));
    return parsed;
  };

  const repeatedCursor = await hostileCall(
    async () => ({ objects: [], truncated: true, cursor: "same-token" }),
    { query: "anything", prefix: "1-projects" }
  );
  check(
    "a backend replaying one continuation token stops the listing instead of looping",
    /repeated a pagination cursor/.test(repeatedCursor.error?.message || "")
  );

  // A third shape, and the one the two above do not cover: the backend says
  // there IS another page and then hands over no continuation token. `truncated`
  // and `cursor` are read from independent tags in `store/s3.js` — `IsTruncated`
  // from one element, `NextContinuationToken` from another, with nothing
  // checking they agree — so this pair is what a slightly-wrong endpoint
  // actually produces. `nextListCursor` folded it in with a finished listing,
  // so `listAllKeys` returned a SHORT key set that read exactly like a complete
  // one, and its own doc comment ("throws rather than truncate, which is right
  // for a search or a move — a partial answer there is a wrong answer") was
  // false on precisely this store. `move_folder` and `set_folder_visibility`
  // build their key sets from it.
  const noContinuation = await hostileCall(
    async () => ({ objects: [], truncated: true }),
    { query: "anything", prefix: "1-projects" }
  );
  check(
    "a backend that reports another page but offers no cursor stops the listing",
    /did not finish|incomplete listing/i.test(noContinuation.error?.message || "")
  );

  let advancing = 0;
  const runawayPages = await hostileCall(
    async () => ({ objects: [], truncated: true, cursor: `page-${++advancing}` }),
    { query: "anything", prefix: "1-projects" }
  );
  check(
    "an endlessly truncated listing is capped rather than exhausting subrequests",
    /exceeded \d+ pages/.test(runawayPages.error?.message || "") && advancing <= 200
  );

  let delimitedPages = 0;
  const runawayLayout = await hostileCall(
    async () => ({
      objects: [],
      delimitedPrefixes: [],
      truncated: true,
      cursor: `layout-${++delimitedPages}`,
    }),
    { query: "anything" }
  );
  check(
    "the delimited layout walk is capped too, not just the flat key walk",
    /exceeded \d+ pages/.test(runawayLayout.error?.message || "") && delimitedPages <= 200
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
