import type { BatchRead } from "./mirrorSync";

/**
 * A note whose collaboration document will not open is still a note.
 *
 * `readNotes` opens each note's collaboration document, and a document the
 * server cannot load safely answers `STORAGE_UNSAFE`. Some of those never
 * clear on their own (a head with no state, a materialization conflict), so
 * the mirror asked for the same notes on every pass, counted them missing
 * forever, and held the download pill at "2,828 / 2,831" (Dev2, 2026-10-16).
 *
 * Those paths are asked for once more as the Markdown the bucket holds
 * (`plain`), which is what a folder List already reads. Its version is the
 * object's, the same one the listing names, so the copy settles. It is the
 * last flushed Markdown; the editor still refuses the note as it did.
 */
export async function readForMirror(
  read: (paths: string[], plain: boolean) => Promise<BatchRead[]>,
  paths: string[],
): Promise<BatchRead[]> {
  const results = await read(paths, false);
  const unsafe = results
    .filter((result) => result.outcome === "error" && result.code === "STORAGE_UNSAFE")
    .map((result) => result.path);
  if (unsafe.length === 0) return results;
  let plain: BatchRead[];
  try {
    plain = await read(unsafe, true);
  } catch {
    return results; // The first answer stands; the next pass asks again.
  }
  const byPath = new Map(plain.map((result) => [result.path, result]));
  return results.map((result) => (unsafe.includes(result.path) ? (byPath.get(result.path) ?? result) : result));
}
