import type ts from "typescript";
import { emptyFacts, type Facts, mergeFacts, textFacts } from "./facts.helpers";
import {
  type Binding,
  indexModule,
  type ModuleIndex,
  type Unit,
} from "./moduleIndex.helpers";
import type { AnalyzedModule } from "./source.helpers";

/**
 * FOLLOWING A REGISTERED FUNCTION INTO THE HELPERS IT CALLS.
 *
 * The graph's nodes are registered Convex functions, and its edges used to be
 * read only from the text of each one's own export block. A helper module
 * under `functions/lib/` registers nothing, so a `ctx.runAction(internal.…)`
 * or a `decryptSecret(` written there belonged to no node, and a public
 * function that imported the helper passed. `helperImports.test.ts` is that
 * attack; this is what closes it.
 *
 * For every registered function, the reach is walked from its own statement,
 * through every name it uses:
 *
 *  - a name imported from another module resolves to that module's
 *    declaration of it (through `export { … } from` and `export *`), and that
 *    declaration's calls, schedules and decrypts become this function's — as
 *    do those of everything *it* uses, recursively, with each statement visited
 *    once so a cycle ends;
 *  - a name that is a registered function is an edge to that node, because
 *    Convex runs a registered function you call directly (it warns and calls
 *    the handler) — no `ctx.run…`, and before this, no edge;
 *  - a name that is a package, or `_generated/`, is not walked: neither can
 *    hold a reference into this app's `internal` object, and a reference
 *    passed *into* one is read where it is written.
 *
 * Granularity is one declaration: a function reaches the top-level
 * statements it names, what those name, and so on — plus the load-time
 * statements of every module it enters — and not its neighbours. That is what
 * lets a large module be split into helpers at all; the module-wide rule
 * `graph.helpers.ts` applies to unattributed *text* still stands beside it, so this
 * can only add edges to what the text rules find, never remove one. A
 * module-level `let`, or a `const` holding a fresh container, pulls in every
 * statement of its module that names it, because what it holds is decided by
 * whoever writes to it. Local names are scoped: a `const session` inside a
 * handler is not the `import * as session` above it.
 *
 * What cannot be followed fails closed as a violation on every registered
 * function whose reach includes it: `import()` of anything but a package
 * name, `require()`, a namespace import indexed with `[…]` or passed around as
 * a value, a relative import naming no module, an imported name its module
 * does not export, and any touch of `_handler` / `invoke*`.
 */

type Target =
  | { kind: "node"; node: string }
  | { kind: "unit"; unit: Unit }
  | { kind: "external" }
  | { kind: "missing"; why: string };

export interface HelperFollower {
  /** Everything the registered function `exportName` of `module` reaches. */
  reach(module: AnalyzedModule, exportName: string): Facts;
}

/**
 * Every relative import in `modules` that leaves `apps/convex`, so a test can
 * read what it lands in. See the `outside` binding in `moduleIndex.helpers.ts`.
 */
export function outsideImports(
  modules: AnalyzedModule[],
): { from: string; specifier: string; repoPath: string }[] {
  const paths = new Set(modules.map((module) => module.path));
  const found: { from: string; specifier: string; repoPath: string }[] = [];
  for (const module of modules) {
    for (const target of indexModule(module, paths).outside) {
      found.push({ from: module.path, ...target });
    }
  }
  return found;
}

export function followHelpers(
  modules: AnalyzedModule[],
  knownNodes: ReadonlySet<string>,
): HelperFollower {
  const byPath = new Map(modules.map((module) => [module.path, module]));
  const paths = new Set(byPath.keys());
  const indexes = new Map<string, ModuleIndex>();
  const indexOf = (path: string): ModuleIndex => {
    let index = indexes.get(path);
    if (index === undefined) {
      index = indexModule(byPath.get(path)!, paths);
      indexes.set(path, index);
    }
    return index;
  };
  const directMemo = new Map<ts.Statement, Facts>();
  const direct = (index: ModuleIndex, statement: ts.Statement): Facts => {
    let facts = directMemo.get(statement);
    if (facts === undefined) {
      facts = textFacts(statement.getText(index.sourceFile), knownNodes);
      directMemo.set(statement, facts);
    }
    return facts;
  };

  function resolveExport(
    path: string,
    name: string,
    seen: Set<string>,
  ): Target {
    const key = `${path}#${name}`;
    if (seen.has(key)) return { kind: "missing", why: `${key} re-exports itself` };
    seen.add(key);
    const index = indexOf(path);
    // Own keys only: `"valueOf" in exports` is true for every module.
    if (Object.hasOwn(index.module.exports, name)) {
      return { kind: "node", node: `${index.module.reference}.${name}` };
    }
    const route = index.exported.get(name);
    if (route?.kind === "local") {
      return (
        resolveLocal(index, route.local, seen) ?? {
          kind: "missing",
          why: `${path} exports ${name} from a declaration the analyzer cannot find`,
        }
      );
    }
    if (route?.kind === "from") return resolveBinding(route.binding, null, seen);
    let external = false;
    for (const star of index.starFrom) {
      if (star === null) {
        external = true;
        continue;
      }
      const target = resolveExport(star, name, seen);
      if (target.kind !== "missing") return target;
    }
    return external
      ? { kind: "external" }
      : { kind: "missing", why: `${path} does not export ${name}` };
  }

  function resolveBinding(
    binding: Binding,
    member: string | null,
    seen: Set<string>,
  ): Target {
    switch (binding.kind) {
      case "external":
      case "outside":
        return { kind: "external" };
      case "unresolved":
        return {
          kind: "missing",
          why: `the relative import "${binding.specifier}" names no module the analyzer can read`,
        };
      case "named":
        return resolveExport(binding.path, binding.name, seen);
      case "namespace":
        return member === null
          ? {
              kind: "missing",
              why: `a namespace re-export of ${binding.path} cannot be resolved to one declaration`,
            }
          : resolveExport(binding.path, member, seen);
    }
  }

  /** A name used in `index`'s module: a local declaration, or an import. */
  function resolveLocal(
    index: ModuleIndex,
    name: string,
    seen: Set<string> = new Set(),
  ): Target | null {
    const node = index.registeredLocals.get(name);
    if (node !== undefined) return { kind: "node", node };
    const unit = index.byName.get(name);
    if (unit !== undefined) return { kind: "unit", unit };
    const binding = index.imports.get(name);
    if (binding !== undefined) return resolveBinding(binding, null, seen);
    // A parameter, a block-scoped local or a global: nothing to follow.
    return null;
  }

  /** Every statement in `index` naming one of `names` — a container's writers. */
  function writersOf(index: ModuleIndex, names: string[]): Unit[] {
    return index.units.filter((unit) =>
      index.references(unit.statement).locals.some((local) =>
        names.includes(local),
      ),
    );
  }

  function reach(module: AnalyzedModule, exportName: string): Facts {
    const facts = emptyFacts();
    const root = indexOf(module.path);
    const route = root.exported.get(exportName);
    const own =
      route?.kind === "local" ? root.byName.get(route.local) : undefined;

    type Item = { index: ModuleIndex; statement: ts.Statement; label: string };
    const stack: Item[] = [];
    const visited = new Set<ts.Statement>();
    const entered = new Set<string>();
    const push = (index: ModuleIndex, statement: ts.Statement, label: string) => {
      if (!visited.has(statement)) stack.push({ index, statement, label });
    };
    // A module the reach passes into — for a declaration, or only through a
    // re-export on the way to one — runs its load-time statements, and its
    // import-level refusals apply.
    const enter = (path: string) => {
      if (entered.has(path)) return;
      entered.add(path);
      const index = indexOf(path);
      for (const statement of index.loose) push(index, statement, path);
      for (const problem of index.problems) {
        facts.problems.add(`${problem} (in ${path})`);
      }
    };
    const resolved = (resolve: (seen: Set<string>) => Target | null) => {
      const seen = new Set<string>();
      const target = resolve(seen);
      for (const key of seen) enter(key.slice(0, key.lastIndexOf("#")));
      return target;
    };

    // The function's own statement and its module's load-time statements;
    // everything else is reached by name. An export whose declaration cannot
    // be found gets every statement in its module, as in `graph.helpers.ts`.
    if (own === undefined) {
      for (const unit of root.units) push(root, unit.statement, unit.label);
    } else {
      push(root, own.statement, own.label);
    }
    enter(module.path);

    const follow = (from: Item, target: Target | null, routeOnly = false) => {
      if (target === null || target.kind === "external") return;
      if (target.kind === "missing") {
        facts.problems.add(`cannot follow a name used in ${from.label}: ${target.why}`);
        return;
      }
      if (target.kind === "node") {
        if (!routeOnly) facts.calls.add(target.node);
        return;
      }
      const index = indexOf(target.unit.path);
      push(index, target.unit.statement, target.unit.label);
      if (target.unit.container) {
        for (const writer of writersOf(index, target.unit.names)) {
          push(index, writer.statement, writer.label);
        }
      }
      enter(target.unit.path);
    };

    while (stack.length > 0) {
      const item = stack.pop()!;
      if (visited.has(item.statement)) continue;
      visited.add(item.statement);
      const suffix =
        item.statement === own?.statement ? "" : ` (in ${item.label})`;
      mergeFacts(facts, direct(item.index, item.statement), suffix);

      const used = item.index.references(item.statement);
      for (const problem of used.problems) {
        facts.problems.add(`${problem} (in ${item.label})`);
      }
      for (const { chain, where } of used.convexReferences) {
        if (!knownNodes.has(chain)) {
          facts.problems.add(
            `names ${chain === "" ? "the generated api object itself" : `a reference ending at "${chain}"`} at ${where} (in ${item.label}), which is not one registered function — a partial reference is a table a caller can index at run time`,
          );
        }
      }
      for (const name of used.locals) {
        follow(item, resolved((seen) => resolveLocal(item.index, name, seen)));
      }
      for (const name of used.routeHandlers) {
        follow(
          item,
          resolved((seen) => resolveLocal(item.index, name, seen)),
          true,
        );
      }
      for (const { namespace, member } of used.members) {
        const binding = item.index.imports.get(namespace)!;
        follow(item, resolved((seen) => resolveBinding(binding, member, seen)));
      }
    }
    return facts;
  }

  return { reach };
}
