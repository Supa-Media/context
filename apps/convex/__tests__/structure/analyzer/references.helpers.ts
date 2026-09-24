import ts from "typescript";

/**
 * Which names one top-level statement uses, read from a real parse: the
 * half of the import follower that looks inside a body. Moved out of
 * `moduleIndex.helpers.ts` so the index (what a module imports, exports and
 * declares) and the reading of a statement are each one file.
 */

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
  /**
   * Every `internal.…` / `api.…` chain written in value position, as the
   * dotted path after the root (`functions.storage.getBindingForGateway`).
   * The follower requires each to name one registered function: a chain that
   * stops short (`internal.functions.storage`) is a module of references a
   * caller can index at run time, and the text rules drop it on the floor.
   */
  convexReferences: { chain: string; where: string }[];
  problems: string[];
}

/** What a module-level name is bound to, as far as reading a body cares. */
export interface ModuleNames {
  /** `import * as x from "./y"`, or `import x = require("./y")`. */
  isNamespace(name: string): boolean;
  /** `internal` or `api`, imported from `_generated/api` under its own name. */
  isGeneratedApi(name: string): boolean;
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

/**
 * The five ways into another Convex function from a context. A direct call
 * whose target is written out — `ctx.runAction(internal.x.y, …)` — is what
 * the graph reads. Every other touch of one of these names is a dispatch the
 * graph cannot see: `const { runAction } = ctx`, `ctx.runAction.call(…)`,
 * `ctx["runAction"]`, `Reflect.get(ctx, "runAction")`, and a call whose
 * target is anything but a written-out reference, including one hidden behind
 * a type argument (`ctx.runQuery<T>(ref)`) that the text pattern misses.
 */
const DISPATCH = new Set([
  "runQuery",
  "runMutation",
  "runAction",
  "runAfter",
  "runAt",
]);

/** Which argument of each dispatch names the function it runs. */
const DISPATCH_TARGET: Record<string, number> = {
  runQuery: 0,
  runMutation: 0,
  runAction: 0,
  runAfter: 1,
  runAt: 1,
};

export function bindingNames(name: ts.BindingName, into: string[]): void {
  if (ts.isIdentifier(name)) {
    into.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) bindingNames(element.name, into);
  }
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

export function collectReferences(
  statement: ts.Statement,
  names: ModuleNames,
  routers: ReadonlySet<string>,
  sourceFile: ts.SourceFile,
): References {
  const found: References = {
    locals: [],
    members: [],
    routeHandlers: new Set(),
    convexReferences: [],
    problems: [],
  };
  const registrations = new Set<ts.Node>();
  const scopes: Set<string>[] = [];
  const shadowed = (name: string) => scopes.some((scope) => scope.has(name));
  const isNamespace = (name: string) =>
    names.isNamespace(name) && !shadowed(name);
  const isGeneratedApi = (name: string) =>
    names.isGeneratedApi(name) && !shadowed(name);
  /** `internal.a.b.c` written out, and nothing else, is a nameable target. */
  const isWrittenReference = (argument: ts.Expression | undefined): boolean => {
    // `internal.x.y as never` is still `internal.x.y`: casts are erased.
    let node = argument;
    while (
      node !== undefined &&
      (ts.isAsExpression(node) ||
        ts.isSatisfiesExpression(node) ||
        ts.isTypeAssertionExpression(node) ||
        ts.isNonNullExpression(node) ||
        ts.isParenthesizedExpression(node))
    ) {
      node = node.expression;
    }
    let root = node;
    while (root !== undefined && ts.isPropertyAccessExpression(root)) {
      root = root.expression;
    }
    return (
      root !== undefined &&
      root !== node &&
      ts.isIdentifier(root) &&
      isGeneratedApi(root.text)
    );
  };
  const where = (node: ts.Node) =>
    `line ${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`;

  /** `const { runAction } = ctx` takes the dispatch out of the call site. */
  const destructures = (element: ts.BindingElement): void => {
    const key = element.propertyName ?? element.name;
    if (
      (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) &&
      DISPATCH.has(key.text)
    ) {
      found.problems.push(
        `destructures ${key.text} at ${where(element)}, which dispatches where the credential-reachability graph cannot see`,
      );
    }
  };
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
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        DISPATCH.has(callee.name.text) &&
        !isWrittenReference(node.arguments[DISPATCH_TARGET[callee.name.text]!])
      ) {
        found.problems.push(
          `calls .${callee.name.text}(…) at ${where(node)} with a target that is not a written-out internal/api reference, which the credential-reachability graph cannot follow`,
        );
      }
      if (
        ts.isElementAccessExpression(callee) &&
        !ts.isStringLiteralLike(callee.argumentExpression) &&
        !ts.isNumericLiteral(callee.argumentExpression)
      ) {
        found.problems.push(
          `calls a computed member at ${where(node)}; which function runs cannot be resolved statically`,
        );
      }
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
      if (
        DISPATCH.has(node.name.text) &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node)
      ) {
        found.problems.push(
          `takes .${node.name.text} at ${where(node)} without calling it, which dispatches where the credential-reachability graph cannot see`,
        );
      }
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
      if (
        !ts.isStringLiteralLike(key) &&
        !ts.isNumericLiteral(key) &&
        /(^|\.)(ctx|scheduler)$/.test(node.expression.getText(sourceFile))
      ) {
        // A context's members are its dispatch methods; a computed one is a
        // dispatch chosen at run time.
        found.problems.push(
          `reads a computed member of ${node.expression.getText(sourceFile)} at ${where(node)}, which dispatches where the credential-reachability graph cannot see`,
        );
      }
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
    if (ts.isStringLiteralLike(node) && DISPATCH.has(node.text)) {
      found.problems.push(
        `names "${node.text}" as a string at ${where(node)}, which is how a dispatch is reached by reflection`,
      );
      return;
    }
    if (ts.isIdentifier(node)) {
      if (registrations.has(node)) {
        found.routeHandlers.add(node.text);
      } else if (shadowed(node.text)) {
        // A local; nothing module-level to follow.
      } else if (isGeneratedApi(node.text)) {
        // Only a chain written out in full is a function reference; the
        // follower checks it names one. See `convexReferences`.
        const chain: string[] = [];
        let top: ts.Node = node;
        while (
          ts.isPropertyAccessExpression(top.parent) &&
          top.parent.expression === top
        ) {
          chain.push(top.parent.name.text);
          top = top.parent;
        }
        found.convexReferences.push({ chain: chain.join("."), where: where(node) });
      } else if (node.text === "Reflect") {
        found.problems.push(
          `uses Reflect at ${where(node)}; a member reached by reflection cannot be resolved statically`,
        );
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
      if (ts.isBindingElement(node)) destructures(node);
      ts.forEachChild(node, (child) => {
        if (child === node.name) return;
        if (ts.isBindingElement(node) && child === node.propertyName) return;
        visit(child);
      });
      return;
    }
    if (ts.isBindingElement(node)) destructures(node);
    if (ts.isLabeledStatement(node) || ts.isBreakOrContinueStatement(node)) {
      if (ts.isLabeledStatement(node)) visit(node.statement);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(statement);
  return found;
}
