/**
 * The gateway's source, read as text, for the checks that assert something no
 * fixture can enumerate: "there is exactly one place a tool is dispatched
 * from", "the addressing argument is stripped before a tool sees it".
 *
 * Those checks were written when the gateway was one file and read
 * `src/index.js` alone. Now that it is split into modules, a check that reads
 * one file by name goes quiet the moment its code moves — or, worse, keeps
 * passing on a stale copy while a second one grows elsewhere. So a check names
 * the file that holds the code AND asserts, over every module under `src/`,
 * that no other file holds it too. Moving the code without moving the check
 * fails; so does duplicating it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** Every `.js` module under `src/`, as `{ path, text }` with a `/`-separated path. */
export function gatewaySourceFiles(dir = SRC) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...gatewaySourceFiles(full));
    else if (entry.endsWith(".js")) {
      out.push({ path: relative(SRC, full).split(sep).join("/"), text: readFileSync(full, "utf8") });
    }
  }
  return out;
}

/** The paths of the files whose text matches `pattern` (a RegExp or a literal string). */
export function filesMatching(files, pattern) {
  const test = typeof pattern === "string" ? (text) => text.includes(pattern) : (text) => pattern.test(text);
  return files.filter((file) => test(file.text)).map((file) => file.path);
}

/**
 * The text of `expected`, if and only if it is the ONE file under `src/` that
 * matches `pattern`; otherwise `""`, so every check built on it fails rather
 * than reading a stale or second copy. `where` says what was found instead.
 */
export function soleSource(files, pattern, expected) {
  const found = filesMatching(files, pattern);
  const ok = found.length === 1 && found[0] === expected;
  return {
    ok,
    text: ok ? files.find((file) => file.path === expected).text : "",
    where: found.join(", ") || "nowhere",
  };
}
