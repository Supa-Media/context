/**
 * Which benchmark folder a command reads.
 *
 * `--dir` first, then `$AI_BENCH_DIR`, then the repository's own copy beside
 * this file (`bench/ai/`), which is what the GitHub Action runs against and
 * what a checkout has with nothing to fetch. Decided 2026-10-09, when the
 * fixtures moved here from `@context-lc ai/` so a run needs no credential to
 * read them.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_BENCH_FOLDER = join(
  dirname(fileURLToPath(import.meta.url)),
  "ai",
);

export function benchFolder(options = {}, env = process.env) {
  return options.dir ?? env.AI_BENCH_DIR ?? REPO_BENCH_FOLDER;
}
