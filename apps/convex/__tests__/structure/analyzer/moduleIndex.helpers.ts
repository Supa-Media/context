import ts from "typescript";
import {
  bindingNames,
  collectReferences,
  type ModuleNames,
  type References,
} from "./references.helpers";
import type { AnalyzedModule } from "./source.helpers";

/**
 * One module, parsed: what it imports, what it exports and from where, and
 * each top-level statement as a unit the import follower can reach.
 *
 * This is a real TypeScript parse rather than more regexes because it has to
 * answer "which names does this function body use", and a regex answering that
 * reads comments, strings and property names as references. A parse can tell
 * `open(ctx)` from `row.open` and from `// open the envelope`.
 */

/** Where a local name bound by an `import` points. */
export type Binding =
  | { kind: "named"; path: string; name: string }
  | { kind: "namespace"; path: string }
  /** A package, or `_generated/` — code this analysis does not walk. */
  | { kind: "external"; specifier: string }
  /**
   * A relative import that leaves `apps/convex` — the gateway's own modules,
   * `packages/*`. Not walked, like a package; `helperDispatch.test.ts` reads
   * every file such an import can land in and requires that none of them can
   * dispatch into Convex or open an envelope, which is what makes not walking
   * them safe rather than hopeful.
   */
  | { kind: "outside"; specifier: string; repoPath: string }
  /** A relative import that names no module in the analyzed set. */
  | { kind: "unresolved"; specifier: string };

export type ExportRoute =
  | { kind: "local"; local: string }
  | { kind: "from"; binding: Binding };

export interface Unit {
  key: string;
  path: string;
  /** `functions/lib/x.ts#openStore`, for failure messages. */
  label: string;
  statement: ts.Statement;
  names: string[];
  /** Declares a function Convex registered for this module. */
  registered: boolean;
  /**
   * A top-level `let`/`var`, or a `const` holding a fresh `new …` or array.
   * Something written to after load, so what it holds is decided by whoever
   * writes to it rather than by its declaration.
   */
  container: boolean;
}

export interface ModuleIndex {
  module: AnalyzedModule;
  sourceFile: ts.SourceFile;
  units: Unit[];
  byName: Map<string, Unit>;
  /** Local name of a registered function → its graph node. */
  registeredLocals: Map<string, string>;
  imports: Map<string, Binding>;
  exported: Map<string, ExportRoute>;
  /** `export * from`: a module path, or null for a package. */
  starFrom: (string | null)[];
  /** Top-level statements that declare nothing: they run at load. */
  loose: ts.Statement[];
  /** Every relative import or re-export that leaves `apps/convex`. */
  outside: { specifier: string; repoPath: string }[];
  /**
   * Imports the follower cannot see through, found while indexing: the
   * generated `api`/`internal` objects bound under another name, imported
   * whole or re-exported (so a reference to them no longer reads as one), and
   * an `import x = …` alias. Each fails closed on every registered function
   * that enters this module.
   */
  problems: string[];
  references: (statement: ts.Statement) => References;
}

/** Where the analyzed modules' paths are relative to, from the repo root. */
const CONVEX_ROOT = ["apps", "convex"];

export function resolveSpecifier(
  from: string,
  specifier: string,
  known: ReadonlySet<string>,
): Binding | { kind: "module"; path: string } {
  if (!specifier.startsWith(".")) return { kind: "external", specifier };
  // Resolved from the repository root, so an import that climbs out of
  // `apps/convex` is recognised as leaving rather than as unresolvable.
  const parts = [...CONVEX_ROOT, ...from.split("/").slice(0, -1)];
  for (const segment of specifier.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment !== "..") parts.push(segment);
    else if (parts.pop() === undefined) {
      return { kind: "unresolved", specifier };
    }
  }
  if (CONVEX_ROOT.some((segment, i) => parts[i] !== segment)) {
    return { kind: "outside", specifier, repoPath: parts.join("/") };
  }
  const base = parts.slice(CONVEX_ROOT.length).join("/");
  // The generated `api`/`internal` objects and function builders. A reference
  // through them is what `CONVEX_REFERENCE` reads; there is no body to walk.
  if (base === "_generated" || base.startsWith("_generated/")) {
    return { kind: "external", specifier };
  }
  for (const candidate of [
    base,
    `${base}.ts`,
    base.replace(/\.js$/, ".ts"),
    `${base}/index.ts`,
  ]) {
    if (known.has(candidate)) return { kind: "module", path: candidate };
  }
  return { kind: "unresolved", specifier };
}

function declaredNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    const names: string[] = [];
    for (const declaration of statement.declarationList.declarations) {
      bindingNames(declaration.name, names);
    }
    return names;
  }
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isModuleDeclaration(statement)) &&
    statement.name !== undefined
  ) {
    return [statement.name.text];
  }
  if (ts.isExportAssignment(statement)) return ["default"];
  return [];
}

function modifiers(statement: ts.Statement): ts.SyntaxKind[] {
  return ts.canHaveModifiers(statement)
    ? (ts.getModifiers(statement) ?? []).map((modifier) => modifier.kind)
    : [];
}

function isContainer(statement: ts.Statement): boolean {
  if (!ts.isVariableStatement(statement)) return false;
  if (!(statement.declarationList.flags & ts.NodeFlags.Const)) return true;
  return statement.declarationList.declarations.some((declaration) => {
    const init = declaration.initializer;
    return (
      init !== undefined &&
      (ts.isNewExpression(init) || ts.isArrayLiteralExpression(init))
    );
  });
}

export function indexModule(
  module: AnalyzedModule,
  known: ReadonlySet<string>,
): ModuleIndex {
  const sourceFile = ts.createSourceFile(
    module.path,
    module.source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const units: Unit[] = [];
  const byName = new Map<string, Unit>();
  const imports = new Map<string, Binding>();
  const exported = new Map<string, ExportRoute>();
  const starFrom: (string | null)[] = [];
  const loose: ts.Statement[] = [];

  const outside: { specifier: string; repoPath: string }[] = [];
  const problems: string[] = [];
  /** Local names bound to the generated `internal` / `api` objects. */
  const generatedApi = new Set<string>();
  const isGeneratedApiSpecifier = (specifier: string) =>
    specifier.startsWith(".") &&
    /(^|\/)_generated\/api(\.js)?$/.test(specifier) &&
    resolveSpecifier(module.path, specifier, known).kind === "external";
  const where = (node: ts.Node) =>
    `line ${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`;
  const bind = (specifier: string, name: string | null): Binding => {
    const target = resolveSpecifier(module.path, specifier, known);
    if (target.kind === "outside") outside.push(target);
    if (target.kind !== "module") return target;
    return name === null
      ? { kind: "namespace", path: target.path }
      : { kind: "named", path: target.path, name };
  };

  sourceFile.statements.forEach((statement, position) => {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause === undefined || clause.isTypeOnly) return;
      const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
      if (isGeneratedApiSpecifier(specifier)) {
        // `internal.a.b` is only a reference the graph can read when it is
        // spelled `internal`. Bound under any other name, or reached through a
        // module object, it is a dispatch table under an alias.
        const named = clause.namedBindings;
        if (clause.name || (named && ts.isNamespaceImport(named))) {
          problems.push(
            `imports ${specifier} whole at ${where(statement)}; only { internal } and { api } by name are references the credential-reachability graph can read`,
          );
        } else if (named) {
          for (const element of named.elements) {
            if (element.isTypeOnly) continue;
            const imported = (element.propertyName ?? element.name).text;
            if (imported !== element.name.text) {
              problems.push(
                `imports ${imported} from ${specifier} as ${element.name.text} at ${where(statement)}; renamed, its references are invisible to the credential-reachability graph`,
              );
            } else {
              generatedApi.add(imported);
            }
          }
        }
        return;
      }
      if (clause.name) imports.set(clause.name.text, bind(specifier, "default"));
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        imports.set(named.name.text, bind(specifier, null));
      } else if (named) {
        for (const element of named.elements) {
          if (element.isTypeOnly) continue;
          const imported = (element.propertyName ?? element.name).text;
          imports.set(element.name.text, bind(specifier, imported));
        }
      }
      return;
    }
    if (ts.isImportEqualsDeclaration(statement)) {
      if (statement.isTypeOnly) return;
      const reference = statement.moduleReference;
      if (
        ts.isExternalModuleReference(reference) &&
        ts.isStringLiteralLike(reference.expression) &&
        !isGeneratedApiSpecifier(reference.expression.text)
      ) {
        // `import x = require("./y")` is a namespace import by another name.
        imports.set(statement.name.text, bind(reference.expression.text, null));
      } else {
        problems.push(
          `aliases ${statement.moduleReference.getText(sourceFile)} as ${statement.name.text} at ${where(statement)}, which the credential-reachability graph cannot follow`,
        );
      }
      return;
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) return;
      const clause = statement.exportClause;
      if (statement.moduleSpecifier !== undefined) {
        const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
        if (isGeneratedApiSpecifier(specifier)) {
          // Still bound below, so the name resolves; the refusal applies to
          // every reach that passes through this module.
          problems.push(
            `re-exports ${specifier} at ${where(statement)}; an importer could rename what it re-exports and the credential-reachability graph would lose every reference through it`,
          );
        }
        if (clause === undefined) {
          const target = bind(specifier, null);
          starFrom.push(target.kind === "namespace" ? target.path : null);
        } else if (ts.isNamespaceExport(clause)) {
          exported.set(clause.name.text, {
            kind: "from",
            binding: bind(specifier, null),
          });
        } else {
          for (const element of clause.elements) {
            if (element.isTypeOnly) continue;
            const imported = (element.propertyName ?? element.name).text;
            exported.set(element.name.text, {
              kind: "from",
              binding: bind(specifier, imported),
            });
          }
        }
      } else if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          if (element.isTypeOnly) continue;
          exported.set(element.name.text, {
            kind: "local",
            local: (element.propertyName ?? element.name).text,
          });
        }
      }
      return;
    }
    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      modifiers(statement).includes(ts.SyntaxKind.DeclareKeyword)
    ) {
      return;
    }
    const names = declaredNames(statement);
    if (names.length === 0) {
      loose.push(statement);
      return;
    }
    const unit: Unit = {
      key: `${module.path}#${position}`,
      path: module.path,
      label: `${module.path}#${names.join(",")}`,
      statement,
      names,
      registered: false,
      container: isContainer(statement),
    };
    units.push(unit);
    for (const name of names) byName.set(name, unit);
    const kinds = modifiers(statement);
    if (ts.isExportAssignment(statement)) {
      exported.set("default", { kind: "local", local: "default" });
    } else if (kinds.includes(ts.SyntaxKind.ExportKeyword)) {
      for (const name of names) exported.set(name, { kind: "local", local: name });
      if (kinds.includes(ts.SyntaxKind.DefaultKeyword)) {
        exported.set("default", { kind: "local", local: names[0]! });
      }
    }
  });

  const registeredLocals = new Map<string, string>();
  for (const exportName of Object.keys(module.exports)) {
    const route = exported.get(exportName);
    if (route?.kind !== "local") continue;
    registeredLocals.set(route.local, `${module.reference}.${exportName}`);
    const unit = byName.get(route.local);
    if (unit) unit.registered = true;
  }

  // `const http = httpRouter()`, with `httpRouter` from Convex itself. Only a
  // real router's `.route({ handler })` is registration rather than a call.
  const routers = new Set<string>();
  for (const unit of units) {
    if (!ts.isVariableStatement(unit.statement)) continue;
    for (const declaration of unit.statement.declarationList.declarations) {
      const init = declaration.initializer;
      const binding =
        init && ts.isCallExpression(init) && ts.isIdentifier(init.expression)
          ? imports.get(init.expression.text)
          : undefined;
      if (
        ts.isIdentifier(declaration.name) &&
        binding?.kind === "external" &&
        binding.specifier === "convex/server" &&
        (init as ts.CallExpression).expression.getText(sourceFile) ===
          "httpRouter"
      ) {
        routers.add(declaration.name.text);
      }
    }
  }

  const names: ModuleNames = {
    isNamespace: (name) => imports.get(name)?.kind === "namespace",
    isGeneratedApi: (name) => generatedApi.has(name),
  };
  const memo = new Map<ts.Statement, References>();
  const references = (statement: ts.Statement): References => {
    const cached = memo.get(statement);
    if (cached) return cached;
    const found = collectReferences(statement, names, routers, sourceFile);
    memo.set(statement, found);
    return found;
  };

  return {
    module,
    sourceFile,
    units,
    byName,
    registeredLocals,
    imports,
    exported,
    starFrom,
    loose,
    outside,
    problems,
    references,
  };
}
