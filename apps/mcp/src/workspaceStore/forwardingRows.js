/**
 * The forwarding ledger (`forwarding.js`), held in the workspace object so a read that misses asks the object it is
 * already talking to, never the control plane (`docs/decisions/storage-and-credentials/forwarding-in-objects.md`).
 *
 * Production on 2026-11-06: about 40% of ChatGPT's `fetch` calls named a path that was not there, and each then
 * waited about 720 ms on `/gateway/tree/facts` (`ask: "forwarding"`) for the ledger, which put ChatGPT's fetch
 * median at 855 ms against Claude's 255.
 *
 * **A copy the control plane writes, whole, with its version.** Every change to the ledger still lands in the control
 * plane's rows first (`forwardingEntries`, recorded by the same `addForwarding` rules, and the source of the export's
 * `.context/forwarding.json`), and each change sends the whole ledger here behind it with the version it moved to
 * (`apps/convex/functions/lib/smallData/objectLedger.ts`). A copy is kept only when its version is at least the one
 * held, so two sends that land out of order leave the newer one. The first send is the migration: a workspace whose
 * object holds no ledger yet is not served here, the control plane answers as before, and asks for a send then.
 *
 * Nothing here is the only copy of anything: drop the table and every read falls back to the control plane until
 * the next send. A ledger is at most `FORWARDING_ENTRY_CAP` entries, a few tens of kilobytes, so it is one row.
 */

import { parseForwarding } from "../forwarding.js";
import { WorkspaceRowRefused } from "./rows.js";

const SCHEMA = [`CREATE TABLE IF NOT EXISTS ws_forwarding (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, entries TEXT NOT NULL)`];

const NOT_SERVED = Object.freeze({ served: false });

/** The ledger half of a workspace object. `sql` is the object's SQLite. */
export function workspaceForwarding(sql) {
  for (const statement of SCHEMA) sql.exec(statement);

  /** `{version, entries}` as held, or `null` before the first send. */
  function held() {
    const [row] = sql.exec("SELECT version, entries FROM ws_forwarding WHERE id = 1").toArray();
    if (row === undefined) return null;
    // Checked again on the way out, as the file is: what is stored is data.
    return { version: Number(row.version), entries: parseForwarding(String(row.entries)).entries };
  }

  return {
    held,

    /**
     * `ws.forwarding.put` `{version, entries}`: the whole ledger as the control plane holds it at `version`. Kept when
     * nothing is held or `version` is at least the held one; an older send changes nothing. Entries are cleaned by
     * the engine's own parse (a bad path or a self-forward is dropped, the cap applied).
     */
    put({ version, entries }) {
      if (!Number.isSafeInteger(version) || version < 0) throw new WorkspaceRowRefused("a ledger names its version");
      if (!Array.isArray(entries)) throw new WorkspaceRowRefused("a ledger is a list of entries");
      const now = held();
      if (now !== null && now.version > version) return { kept: false, version: now.version };
      const clean = parseForwarding(JSON.stringify({ version: 1, entries })).entries;
      sql.exec(
        `INSERT INTO ws_forwarding (id, version, entries) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET version = excluded.version, entries = excluded.entries`,
        version,
        JSON.stringify({ version: 1, entries: clean }),
      );
      return { kept: true, version };
    },

    /**
     * `{ask: "forwarding"}` for one reader, in the control plane's `/gateway/tree/facts` shape: an entry whose old
     * path the reader may not see is left out, and one whose new path it may not see comes back `to: null` ("moved
     * somewhere you cannot see"). A folder entry is judged as the listing shows the folder (`folderSees`), a note's as
     * a read (`sees`). Not served before the first send, so the control plane answers then.
     */
    answer(_fields, sees, folderSees) {
      const ledger = held();
      if (ledger === null) return NOT_SERVED;
      const seen = (path, kind) => (kind === "folder" ? folderSees(path) : sees(path));
      const forwarding = [];
      for (const entry of ledger.entries) {
        if (!seen(entry.from, entry.kind)) continue;
        forwarding.push({ ...entry, to: seen(entry.to, entry.kind) ? entry.to : null });
      }
      return { served: true, forwarding };
    },
  };
}
