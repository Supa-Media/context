/**
 * The text-level vocabulary of the credential-reachability analyzer: what a
 * registered Convex function is, how a module's source is split into the
 * block belonging to each export, and the patterns that count as a call, a
 * schedule or a decrypt. Moved out of `fixtures.helpers.ts` unchanged when the
 * analyzer learned to follow imports (see `imports.helpers.ts`); the three patterns at
 * the bottom are exported now because the import follower applies them to
 * helper bodies too.
 */

/** What Convex records on a registered function. */
export interface Classification {
  isPublic: boolean;
  isInternal: boolean;
  kind: "query" | "mutation" | "action" | "http";
}

export interface AnalyzedModule {
  /** Dotted reference path, e.g. `functions.storage`. */
  reference: string;
  /** Human-readable path for failure messages. */
  path: string;
  source: string;
  exports: Record<string, Classification>;
}

export interface Violation {
  node: string;
  reason: string;
}

/** `../../functions/lib/crypto.ts` → `functions.lib.crypto`. The leading `../..` reflects this fixture module living at `__tests__/structure/fixtures.helpers.ts`, two directories below `apps/convex`. */
export function referencePath(globKey: string): string {
  return globKey
    .replace(/^(\.\.?\/)+/, "")
    .replace(/\.ts$/, "")
    .split("/")
    .join(".");
}

export function classify(value: unknown): Classification | null {
  const fn = value as {
    isQuery?: boolean;
    isMutation?: boolean;
    isAction?: boolean;
    isHttp?: boolean;
    isPublic?: boolean;
    isInternal?: boolean;
  } | null;
  // A registered Convex function is a *callable* carrying these flags, not a
  // plain object — checking only for "object" here silently classified
  // nothing, which is how a guard ends up passing vacuously.
  if (fn === null || (typeof fn !== "object" && typeof fn !== "function")) {
    return null;
  }

  /**
   * An `httpAction` carries neither `isPublic` nor `isInternal`, because
   * Convex does not route it through the `api`/`internal` object at all — it
   * routes it by **path**, from the public internet, with no argument
   * validator and no function-name gate in front of it.
   *
   * Classified `isPublic: true` here for exactly that reason. It was the hole
   * this whole file exists to close, hiding in plain sight: until this branch
   * existed, `classify` returned `null` for every route in `http.ts`, so the
   * nine control-plane routes were not nodes in the graph, and one of them
   * reaching a decrypted storage credential produced no violation and no
   * failure. An `httpAction` that can open a customer's bucket key is a
   * *more* exposed thing than a public `action`, not a less exposed one.
   *
   * The `kind` is kept distinct so the rules that follow can say something
   * sharper than "public": see `CREDENTIAL_HTTP_ROUTES`.
   */
  if (fn.isHttp === true) {
    return { kind: "http", isPublic: true, isInternal: false };
  }

  const kind = fn.isQuery
    ? "query"
    : fn.isMutation
      ? "mutation"
      : fn.isAction
        ? "action"
        : null;
  if (kind === null) return null;
  return {
    kind,
    isPublic: fn.isPublic === true,
    isInternal: fn.isInternal === true,
  };
}

/**
 * Split a module's source into the block belonging to each `export const`.
 *
 * A block runs from its own declaration to the next one, so anything defined
 * between two exports is attributed to the earlier of the two. That is
 * deliberate: it over-attributes rather than under-attributes, and
 * over-attribution only ever produces a failing test.
 */
export function exportBlocks(source: string): {
  preamble: string;
  blocks: Map<string, string>;
} {
  const declaration = /^export const (\w+)\s*=/gm;
  const found: { name: string; index: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(source)) !== null) {
    found.push({ name: match[1], index: match.index });
  }

  const preamble =
    found.length === 0 ? source : source.slice(0, found[0].index);
  const blocks = new Map<string, string>();
  for (let i = 0; i < found.length; i += 1) {
    const end = i + 1 < found.length ? found[i + 1].index : source.length;
    blocks.set(found[i].name, source.slice(found[i].index, end));
  }
  return { preamble, blocks };
}

/** Strip `import { … } from "…"` lines: importing a symbol is not calling it. */
export function withoutImports(source: string): string {
  return source.replace(/^import[\s\S]*?from\s+["'][^"']+["'];?$/gm, "");
}

export const DECRYPT_CALL = /\bdecryptSecret\s*\(/;

export const CONVEX_REFERENCE = /\b(?:internal|api)((?:\.[A-Za-z_$][\w$]*)+)/g;
export const RUN_CALL = /\.run(?:Query|Mutation|Action)\(\s*([^,)\s]*)/g;
/**
 * `ctx.scheduler.runAfter(delay, internal.x.y, …)` / `runAt(when, …)`.
 *
 * The delay expression is matched as "everything up to the first comma", so a
 * delay that itself contains a comma (`Math.max(0, n)`) will not match here.
 * That is a fail-closed miss, not a hole: with no scheduler span recorded, the
 * reference that follows is counted as an ordinary call edge and propagates
 * taint exactly as before.
 */
export const SCHEDULE_CALL = /\.scheduler\.run(?:After|At)\(\s*[^,]*,\s*([^,)\s]*)/g;
