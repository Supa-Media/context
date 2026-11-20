/**
 * The node log of one background job's object (`texJob.js`): the last 50 node entries the job's graph runs wrote, kept in
 * the object's own storage under `jobnodes` and read at `GET /job-nodes`. The entries are the runner's, as the ledger
 * writes them (`ledger.js` `nodeEntry`). Each entry also logs one line with the node's name and whether it went, never
 * its words.
 */

/** The storage key of the kept entries (a list, oldest first). */
export const JOB_NODES_KEY = "jobnodes";
/** How many node entries a job's object keeps. */
export const JOB_NODES_KEPT = 50;

/** The entries a job's object keeps, oldest first. */
export async function readJobNodes(storage) {
  const nodes = await storage.get(JOB_NODES_KEY);
  return Array.isArray(nodes) ? nodes : [];
}

/** Flushes to one storage run one at a time, so two passes never read the same list and drop one another's entries. */
const chains = new WeakMap();

/**
 * A writer for the graph's `writer` (`{ write(entry), flush() }`): `write` holds an entry and logs its line; `flush`
 * appends what is held and trims the list to the last 50. Never throws out of `write`.
 */
export function jobNodeWriter(storage, jobId) {
  let held = [];
  return {
    write(entry) {
      held.push(entry);
      try {
        console.log(JSON.stringify({ event: "job_node", job: jobId, ok: entry.ok, name: entry.name }));
      } catch {
        /* a log line never stops a pass */
      }
    },
    async flush() {
      if (held.length === 0) return;
      const batch = held;
      held = [];
      const previous = chains.get(storage) ?? Promise.resolve();
      const next = previous.catch(() => {}).then(async () => {
        const kept = [...(await readJobNodes(storage)), ...batch].slice(-JOB_NODES_KEPT);
        await storage.put(JOB_NODES_KEY, kept);
      });
      chains.set(storage, next);
      await next;
    },
  };
}
