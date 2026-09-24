import ts from "typescript";
import type { AnalyzedModule } from "./source";

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
   * `packages/*`. Not walked, like a package; `helperImports.test.ts` reads
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

/** The names one statement uses, and what it did that cannot be followed. */
export interface References {
  /** Identifiers in value position. */
  locals: string[];
  /** `ns.member` through a namespace import. */
  members: { namespace: string; member: string }[];
  /**
   * `http.route({ handler: x })` on a Convex `httpRouter()` — registering a
   * route, not calling it. Followed if it names a helper, never an edge if it
   * names a registered function.
   */
  routeHandlers: Set<string>;
  problems: string[];
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
  references: (statement: ts.Statement) => References;
}

/**
 * The names that invoke a registered function without `ctx.run…`. Convex puts
 * `_handler` and `invoke*` on every registered function, and calling one of
 * those runs the handler inline — the decrypt with it — with no function
 * reference for the graph to see. Nothing in production code has a reason to
 * touch them, so any use fails closed.
 */
const DIRECT_INVOCATION = new Set([
  "_handler",
  "invokeQuery",
  "invokeMutation",
  "invokeAction",
  "invokeHttpAction",
]);

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

function bindingNames(name: ts.BindingName, into: string[]): void {
  if (ts.isIdentifier(name)) {
    into.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) bindingNames(element.name, into);
  }
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
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) return;
      const clause = statement.exportClause;
      if (statement.moduleSpecifier !== undefined) {
        const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
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

  const memo = new Map<ts.Statement, References>();
  const references = (statement: ts.Statement): References => {
    const cached = memo.get(statement);
    if (cached) return cached;
    const found = collectReferences(statement, imports, routers, sourceFile);
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
    references,
  };
}

/**
 * The names a node declares for its own body: a function's parameters, a
 * block's `const`/`let`/`function`/`class`, a loop's or a `catch`'s variable.
 * A use of one of these inside the node is that local, not the import of the
 * same name — `const session = …` in a handler is not `import * as session`.
 * A `var` is scoped to its block rather than hoisted, which can only make a
 * local look like the import, never the reverse.
 */
function scopeOf(node: ts.Node): Set<string> | null {
  const names: string[] = [];
  if (ts.isFunctionLike(node)) {
    for (const parameter of node.parameters) bindingNames(parameter.name, names);
    if (ts.isFunctionExpression(node) && node.name) names.push(node.name.text);
  }
  if (ts.isBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
    for (const statement of node.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          bindingNames(declaration.name, names);
        }
      } else if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement)) &&
        statement.name
      ) {
        names.push(statement.name.text);
      }
    }
  }
  if (
    (ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node)) &&
    node.initializer &&
    ts.isVariableDeclarationList(node.initializer)
  ) {
    for (const declaration of node.initializer.declarations) {
      bindingNames(declaration.name, names);
    }
  }
  if (ts.isCatchClause(node) && node.variableDeclaration) {
    bindingNames(node.variableDeclaration.name, names);
  }
  return names.length > 0 ? new Set(names) : null;
}

function collectReferences(
  statement: ts.Statement,
  imports: Map<string, Binding>,
  routers: ReadonlySet<string>,
  sourceFile: ts.SourceFile,
): References {
  const found: References = {
    locals: [],
    members: [],
    routeHandlers: new Set(),
    problems: [],
  };
  const registrations = new Set<ts.Node>();
  const scopes: Set<string>[] = [];
  const shadowed = (name: string) => scopes.some((scope) => scope.has(name));
  const isNamespace = (name: string) =>
    imports.get(name)?.kind === "namespace" && !shadowed(name);
  const where = (node: ts.Node) =>
    `line ${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`;

  const visit = (node: ts.Node): void => {
    const scope = scopeOf(node);
    if (scope) scopes.push(scope);
    try {
      visitNode(node);
    } finally {
      if (scope) scopes.pop();
    }
  };
  const visitNode = (node: ts.Node): void => {
    // Types are erased; nothing in one runs.
    if (
      ts.isTypeNode(node) &&
      !(ts.isExpressionWithTypeArguments(node) && ts.isHeritageClause(node.parent))
    ) {
      return;
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [specifier] = node.arguments;
        // A package loaded lazily (`await import("satori")`) cannot hold a
        // reference into this app's `internal` object. Anything else — a
        // computed specifier, or a module of this app loaded at run time —
        // is a body the analyzer would have to guess at.
        if (
          specifier === undefined ||
          !ts.isStringLiteralLike(specifier) ||
          specifier.text.startsWith(".")
        ) {
          found.problems.push(
            `loads a module with a dynamic import() at ${where(node)}, which the credential-reachability graph cannot follow`,
          );
        }
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        !shadowed("require")
      ) {
        found.problems.push(
          `calls require() at ${where(node)}, which the credential-reachability graph cannot follow`,
        );
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "route" &&
        ts.isIdentifier(node.expression.expression) &&
        routers.has(node.expression.expression.text)
      ) {
        for (const argument of node.arguments) {
          if (!ts.isObjectLiteralExpression(argument)) continue;
          for (const property of argument.properties) {
            if (
              ts.isPropertyAssignment(property) &&
              ts.isIdentifier(property.name) &&
              property.name.text === "handler" &&
              ts.isIdentifier(property.initializer)
            ) {
              registrations.add(property.initializer);
            }
          }
        }
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (DIRECT_INVOCATION.has(node.name.text)) {
        found.problems.push(
          `touches .${node.name.text} at ${where(node)}, which runs a registered function without ctx.run… and so without an edge the credential-reachability graph can see`,
        );
      }
      if (
        ts.isIdentifier(node.expression) &&
        isNamespace(node.expression.text)
      ) {
        found.members.push({
          namespace: node.expression.text,
          member: node.name.text,
        });
        return;
      }
      visit(node.expression);
      return;
    }
    if (ts.isElementAccessExpression(node)) {
      const key = node.argumentExpression;
      if (ts.isStringLiteralLike(key) && DIRECT_INVOCATION.has(key.text)) {
        found.problems.push(
          `touches ["${key.text}"] at ${where(node)}, which runs a registered function without ctx.run… and so without an edge the credential-reachability graph can see`,
        );
      }
      if (
        ts.isIdentifier(node.expression) &&
        isNamespace(node.expression.text)
      ) {
        found.problems.push(
          `indexes the namespace import ${node.expression.text}[…] at ${where(node)}; a computed member of an imported module cannot be resolved statically`,
        );
        visit(key);
        return;
      }
    }
    if (ts.isIdentifier(node)) {
      if (registrations.has(node)) {
        found.routeHandlers.add(node.text);
      } else if (shadowed(node.text)) {
        // A local; nothing module-level to follow.
      } else if (isNamespace(node.text)) {
        found.problems.push(
          `uses the namespace import ${node.text} as a value at ${where(node)}; once the module object escapes, which member is called cannot be resolved statically`,
        );
      } else {
        found.locals.push(node.text);
      }
      return;
    }
    // Names that declare or label rather than refer.
    if (
      (ts.isPropertyAssignment(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      ts.isIdentifier(node.name)
    ) {
      ts.forEachChild(node, (child) => {
        if (child !== node.name) visit(child);
      });
      return;
    }
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name)
    ) {
      ts.forEachChild(node, (child) => {
        if (child === node.name) return;
        if (ts.isBindingElement(node) && child === node.propertyName) return;
        visit(child);
      });
      return;
    }
    if (ts.isLabeledStatement(node) || ts.isBreakOrContinueStatement(node)) {
      if (ts.isLabeledStatement(node)) visit(node.statement);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(statement);
  return found;
}
