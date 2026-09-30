/**
 * A note is written to the search database in one request, not five.
 *
 * Every note is at least five statements (three deletes, the `notes` row, a
 * row per chunk), and each was its own HTTPS request to Cloudflare's API,
 * which allows about 1,200 requests per five minutes per token. A 17,000-note
 * context sat at "53% indexed" for hours of rate limiting. D1 takes
 * `{batch: [...]}` and runs it as one transaction.
 *
 * Sabotage, as measured: `runAll` never batching reddens "one request" and
 * "falls back to one statement per request" (the count includes the batch);
 * a refused batch thrown instead of falling back takes down the whole
 * projection suite with REFUSED; dropping the result-count check reddens
 * "answered short".
 */

import {
  DESCRIPTOR,
  createD1Backend,
  createD1Client,
} from "./fixtures.mjs";
import { projectNote, upsertStatements } from "../../src/search/d1/project.js";

function noteStatements(path, content) {
  return upsertStatements(
    path,
    projectNote(path, { version: "v1", uploaded: null, visibility: "team", content }),
  );
}

export async function runBatchingChecks(check) {
  {
    const backend = createD1Backend();
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    const statements = noteStatements("1-projects/batched.md", "# Batched\n\nkoala ledger\n");
    const before = backend.requests.length;
    const { applied } = await client.runAll(statements);
    const sent = backend.requests.slice(before);
    check("a note's statements go out as one request", sent.length === 1 && sent[0].batch === statements.length);
    check("and every one of them applied", applied === statements.length);
    const rows = backend.rows("SELECT path FROM notes WHERE path = ?", ["1-projects/batched.md"]);
    check("and the note is really there", rows.length === 1);
    backend.close();
  }

  {
    // A D1 that will not take a batch gets what it always got: one statement
    // per request, and only one refused batch per client, not one per note.
    const backend = createD1Backend();
    backend.state.refuseBatch = true;
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    const first = noteStatements("1-projects/one.md", "# One\n\nwombat\n");
    const second = noteStatements("1-projects/two.md", "# Two\n\nwombat\n");
    await client.runAll(first);
    const afterFirst = backend.requests.length;
    await client.runAll(second);
    const secondRequests = backend.requests.slice(afterFirst);
    check("a refused batch falls back to one statement per request", afterFirst === 1 + first.length);
    check(
      "and is not tried again by the same client",
      secondRequests.length === second.length && secondRequests.every((r) => r.batch === 0),
    );
    const rows = backend.rows("SELECT path FROM notes ORDER BY path");
    check("and both notes still land", rows.length === 2);
    backend.close();
  }

  {
    // An answer that does not account for every statement is not trusted.
    const backend = createD1Backend();
    const client = createD1Client(DESCRIPTOR, {
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        if (Array.isArray(body.batch)) {
          return new Response(JSON.stringify({ success: true, result: [{ results: [], success: true }] }), {
            status: 200,
          });
        }
        return backend.handle(url, init);
      },
    });
    const statements = noteStatements("1-projects/short.md", "# Short\n\nquoll\n");
    const { applied } = await client.runAll(statements);
    const rows = backend.rows("SELECT path FROM notes WHERE path = ?", ["1-projects/short.md"]);
    check("a batch answered short is redone statement by statement", applied === statements.length && rows.length === 1);
    backend.close();
  }

  {
    // A wait-and-retry failure is still that failure, not a reason to stop batching.
    const backend = createD1Backend();
    backend.state.fail = 429;
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    let code = null;
    try {
      await client.runAll(noteStatements("1-projects/limited.md", "# Limited\n\nnumbat\n"));
    } catch (error) {
      code = error.code;
    }
    check("a rate-limited batch is reported as rate limited", code === "RATE_LIMITED");
    backend.close();
  }
}
