/**
 * The repository files a job can actually execute, followed from its entry
 * points through imports.
 *
 * Package-level scoping treats an app as one unit: touch any file in
 * `apps/convex` and every job that uses a Convex helper runs. A job whose
 * subject is a few entry points (the collaboration browser run mounts one
 * fixture screen and one test Worker) can be scoped by the files those entries
 * reach instead.
 *
 * It fails open in three ways, because a skipped job that should have run is
 * the expensive mistake:
 *
 * - importing a workspace package by name claims the whole package and its
 *   workspace dependencies, not just the files reached inside it;
 * - inside an app the walk entered, every file that is not source (configs,
 *   assets, `wrangler*.toml`, `app.json`) and every top-level file (build
 *   configs like `metro.config.js` that nothing imports) stays watched;
 * - a specifier it cannot resolve is ignored only when it names no workspace
 *   file, which is the case for every npm dependency.
 *
 * What it cannot see is code loaded by computed path (`require(variable)`);
 * the app has none, and `check-ci-path-gates.mjs` pins the entry list.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { workspacePaths } from "./check-ci-path-gates.mjs";

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];
const PLATFORMS = ["web", "native", "ios", "android"];
const INDEXES = ["index.ts", "index.tsx", "index.js", "index.mjs"];
const SPECIFIERS = [
  /(?:^|\n)\s*(?:import|export)\b[^'"]{0,400}?\bfrom\s*["']([^"']+)["']/g,
  /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];

const isFile = (root, path) => existsSync(join(root, path)) && statSync(join(root, path)).isFile();

function candidates(root, base) {
  const found = [];
  for (const suffix of SUFFIXES) found.push(base + suffix);
  for (const platform of PLATFORMS) for (const ext of [".ts", ".tsx", ".js", ".jsx"]) found.push(`${base}.${platform}${ext}`);
  for (const index of INDEXES) found.push(`${base}/${index}`);
  return found.filter((path) => isFile(root, path));
}

/** `apps/mobile/features/x.tsx` → `apps/mobile`, the unit the fail-open rules apply to. */
export const appOf = (file) => (file.startsWith("apps/") ? file.split("/").slice(0, 2).join("/") : null);

/** `@context/convex` → `apps/convex`: apps imported by name are followed file by file too. */
function appPackages(root) {
  const byName = new Map();
  for (const entry of readdirSync(join(root, "apps"), { withFileTypes: true })) {
    const manifest = join(root, "apps", entry.name, "package.json");
    if (entry.isDirectory() && existsSync(manifest)) {
      const { name, main } = JSON.parse(readFileSync(manifest, "utf8"));
      if (name) byName.set(name, { dir: `apps/${entry.name}`, main });
    }
  }
  return byName;
}

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export function reach(entries, root = process.cwd()) {
  const appsByName = appPackages(root);
  const packages = new Set();
  const files = new Set();
  const apps = new Set();
  const queue = [];
  for (const entry of entries) {
    if (!isFile(root, entry)) throw new Error(`Scope entry ${entry} does not exist`);
    queue.push(entry);
  }

  while (queue.length > 0) {
    const file = queue.pop();
    if (files.has(file)) continue;
    files.add(file);
    const app = appOf(file);
    if (app) apps.add(app);
    if (!SOURCE.test(file)) continue;
    const source = readFileSync(join(root, file), "utf8");
    for (const pattern of SPECIFIERS) {
      for (const [, specifier] of source.matchAll(pattern)) {
        if (specifier.startsWith(".")) {
          const base = relative(root, resolve(root, dirname(file), specifier)).replaceAll("\\", "/");
          if (!base.startsWith("..")) queue.push(...candidates(root, base));
        } else if (specifier.startsWith("@context/") || specifier.startsWith("@supa-media/")) {
          const name = packageName(specifier);
          const target = appsByName.get(name);
          if (!target) {
            packages.add(name);
            continue;
          }
          // A subpath with only a `.d.ts` resolves to nothing: types do not run.
          const sub = specifier.slice(name.length + 1);
          const base = sub ? `${target.dir}/${sub}` : target.main && !target.main.includes("/entry") ? `${target.dir}/${target.main}` : null;
          if (base) queue.push(...candidates(root, base.replace(/\.(js|ts|mjs)$/, "")));
          else packages.add(name);
        }
      }
    }
  }

  const packagePaths = new Set();
  for (const name of packages) {
    try {
      for (const path of workspacePaths([name], root)) packagePaths.add(path);
    } catch {
      // A published @supa-media package that is not a workspace member.
    }
  }
  // An app reached by file is scoped by file; its whole-package pattern would undo that.
  for (const app of apps) packagePaths.delete(`${app}/**`);
  return { files, apps, packagePaths };
}

/**
 * Is a changed file one the reached code depends on? Tests and docs inside an
 * app are not, unless an entry imports them (the browser harness is a test).
 */
export function reached(file, scope) {
  if (scope.files.has(file)) return true;
  if ([...scope.packagePaths].some((pattern) => file.startsWith(pattern.slice(0, -2)))) return true;
  const app = appOf(file);
  if (!app || !scope.apps.has(app)) return false;
  const inside = file.slice(app.length + 1);
  if (!inside.includes("/")) return !/\.md$/.test(inside);
  if (SOURCE.test(file)) return false;
  return !/(^|\/)(__tests__|test|tests|e2e)\//.test(inside) && !/\.md$/.test(inside);
}
