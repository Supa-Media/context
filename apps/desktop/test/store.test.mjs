/**
 * Writes to one JSON file that overlap still all land, in order.
 *
 * The outbox is written by the page's meeting writes, the drain and the
 * capture controller without any of them waiting for the others. With one
 * fixed temporary name, two overlapping writes shared it: the second rename
 * threw `ENOENT`, and that error was the answer the page got to its finalize
 * (2026-10-28, two meetings left "Not in your bucket yet").
 *
 * ## Sabotage record
 *
 * Run as a temporary local edit and reverted:
 *
 *   `writeJson` back to one fixed `${path}.tmp` and no queue      1 (24 of 25 writes threw ENOENT)
 */

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopStore } from "../src/main/store.ts";

export async function runStoreChecks(check) {
  const dir = await mkdtemp(join(tmpdir(), "context-desktop-store-"));
  try {
    const store = new DesktopStore(dir);
    const writes = Array.from({ length: 25 }, (_, n) => store.writeOutbox({ version: 1, entries: [], n }));
    const outcomes = await Promise.allSettled(writes);
    const failed = outcomes.filter((outcome) => outcome.status === "rejected");
    check(
      `twenty-five overlapping outbox writes all land (${failed.map((f) => f.reason?.code ?? f.reason).join(", ") || "none failed"})`,
      failed.length === 0,
    );
    const onDisk = JSON.parse(await readFile(store.outboxPath, "utf8"));
    check("the last write asked for is the one on disk", onDisk.n === 24);
    const left = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
    check("no temporary file is left behind", left.length === 0);

    // A write that follows a failed one still runs.
    const blocked = new DesktopStore(join(dir, "outbox.json", "not-a-dir"));
    const refused = await blocked.writeOutbox({ n: "refused" }).then(() => false, () => true);
    check("a write that cannot land is refused, not swallowed", refused);
    await store.writeOutbox({ version: 1, entries: [], n: "after" });
    const after = JSON.parse(await readFile(store.outboxPath, "utf8"));
    check("the next write after a refused one still lands", after.n === "after");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
