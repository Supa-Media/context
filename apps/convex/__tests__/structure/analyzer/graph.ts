import { textFacts } from "./facts";
import { followHelpers } from "./helpers";
import { CREDENTIAL_BARRIERS, CREDENTIAL_HTTP_ROUTES } from "./pins";
import {
  type AnalyzedModule,
  type Classification,
  CONVEX_REFERENCE,
  DECRYPT_CALL,
  exportBlocks,
  type Violation,
  withoutImports,
} from "./source";

/**
 * Build the graph and return every way a public function can reach a decrypt.
 *
 * Pure over its input so the same analyzer can be pointed at the real codebase
 * and at a synthetic attack module — see the final test.
 */
export function analyze(modules: AnalyzedModule[]): {
  violations: Violation[];
  decryptCapable: Set<string>;
  /** Registered function → the registered functions it calls. */
  edges: Map<string, string[]>;
  /** Registered function → the internal functions it only schedules. */
  schedules: Map<string, string[]>;
} {
  const violations: Violation[] = [];
  const schedules = new Map<string, string[]>();
  const decryptCapable = new Set<string>();
  const edges = new Map<string, string[]>();
  const classifications = new Map<string, Classification>();
  const knownNodes = new Set<string>();

  for (const module of modules) {
    for (const name of Object.keys(module.exports)) {
      knownNodes.add(`${module.reference}.${name}`);
    }
  }
  const follower = followHelpers(modules, knownNodes);

  for (const module of modules) {
    const { preamble, blocks } = exportBlocks(module.source);

    // Fail closed: a decrypt reached from a module-level helper cannot be
    // attributed to one export, so every export in the module inherits it.
    // Superseded by `moduleWideTaintFromHelpers` below, which covers this
    // case and the one it missed.

    // Same fail-closed rule for *call edges*, and it is the hole the barrier
    // set would otherwise open. A module-level helper like
    //
    //   async function openStore(ctx, id) {
    //     return await ctx.runAction(internal.functions.storage.getBindingForGateway, …);
    //   }
    //
    // belongs to no Convex function, so its reference would be counted for
    // nobody — a public action could call it and the graph would see nothing.
    // Every export in the module inherits references found in unattributed
    // text.
    //
    // **Unattributed is not the same as "above the first export", and the
    // difference was a live hole.** `exportBlocks` splits on `export const`,
    // so a helper written *after* a non-function export —
    //
    //   export const SOME_NAME = "…";      // not a Convex function
    //   async function openStore(ctx) { … } // lands in SOME_NAME's block
    //
    // was attributed to that constant's block. A constant is not a registered
    // Convex function, so it is not in `module.exports`, so it is not a node,
    // so the edge was dropped on the floor. Found by writing a provisioner
    // whose credential read sits in exactly that position: the analyzer said
    // it reached no decrypt, and it plainly did.
    //
    // So the unattributed text is the preamble *plus every block whose name is
    // not a Convex function this analysis knows about*.
    const unattributed = [preamble];
    for (const [blockName, blockText] of blocks) {
      if (!(blockName in module.exports)) unattributed.push(blockText);
    }
    const moduleWideTaintFromHelpers = unattributed.some((text) =>
      DECRYPT_CALL.test(withoutImports(text)),
    );

    const preambleTargets: string[] = [];
    for (const text of unattributed) {
      const stripped = withoutImports(text);
      let found: RegExpExecArray | null;
      CONVEX_REFERENCE.lastIndex = 0;
      while ((found = CONVEX_REFERENCE.exec(stripped)) !== null) {
        const target = found[1].slice(1);
        if (knownNodes.has(target)) preambleTargets.push(target);
      }
    }

    for (const [name, classification] of Object.entries(module.exports)) {
      const node = `${module.reference}.${name}`;
      classifications.set(node, classification);

      // An export the block splitter cannot locate — `export const { a, b } =`
      // (how the auth framework re-exports its functions), or a
      // `const x = query(…); export { x }` — falls back to the whole module as
      // its body. Conservative on purpose: a function whose definition cannot
      // be pinpointed inherits everything its file reaches, so hiding a call
      // behind an indirect export makes the analysis *more* suspicious of it,
      // not blind to it.
      const body = blocks.get(name) ?? module.source;
      // What the export block itself says. `textFacts` is the one reading of
      // a call, a schedule, a decrypt and an unfollowable `ctx.run…`, shared
      // with the helper follower so a helper is held to the same rules.
      //
      // Scheduling is not calling, and the difference is the whole reason the
      // connect flow can exist. `ctx.runQuery/runMutation/runAction` awaits a
      // value and hands it to the caller, so a public function that runs a
      // decrypting internal function has that credential in its own scope —
      // that is the edge this graph exists to forbid. `ctx.scheduler.runAfter`
      // enqueues a job in a *separate* transaction whose return value the
      // scheduler discards; there is no channel back to whoever queued it, so
      // it cannot hand a credential to a public caller.
      //
      // The distinction is load-bearing rather than a convenience: without it
      // no public function could ever trigger a bucket probe, and "verify the
      // credential the user just pasted" would have to be a polling cron
      // chosen to satisfy a static check rather than because it is the right
      // design.
      //
      // Two things keep it honest, both enforced below:
      //   - a scheduled target must still be a statically resolvable
      //     `internal.…` reference, so nothing hides behind a computed name
      //     or reaches a *public* function, and
      //   - only the reference in the scheduler's argument position is
      //     exempted. The same function named anywhere else in the same body
      //     is still an ordinary call edge.
      //
      // What it does not prove is that a scheduled job never *stores* a
      // plaintext credential somewhere a public query could read it. No static
      // rule can; `__tests__/provisioning.test.ts` asserts behaviourally that
      // the credential appears in no recorded error, audit event, or return
      // value, and the public return-validator check below is the second net.
      const own = textFacts(body, knownNodes);

      // …and everything it reaches through the names it uses: helpers in
      // other modules, followed through their imports, and registered
      // functions it calls directly. See `helpers.ts`.
      const reached = follower.reach(module, name);

      if (moduleWideTaintFromHelpers || own.decrypt || reached.decrypt) {
        decryptCapable.add(node);
      }
      edges.set(node, [...own.calls, ...preambleTargets, ...reached.calls]);
      schedules.set(node, [...new Set([...own.schedules, ...reached.schedules])]);

      // Every `ctx.runX` must name a statically resolvable function, every
      // scheduled target must be a nameable internal one, and every name the
      // follower could not resolve fails closed — or the graph is a fiction.
      const problems = new Set(own.problems);
      for (const problem of reached.problems) problems.add(problem);
      for (const reason of problems) violations.push({ node, reason });
    }
  }
  // Propagate capability backwards until nothing new is tainted.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [node, targets] of edges) {
      if (decryptCapable.has(node)) continue;
      // Taint stops at a barrier — see CREDENTIAL_BARRIERS above for what
      // that buys and, just as importantly, what it does not.
      if (
        targets.some(
          (target) =>
            decryptCapable.has(target) && !CREDENTIAL_BARRIERS.has(target),
        )
      ) {
        decryptCapable.add(node);
        changed = true;
      }
    }
  }

  for (const node of decryptCapable) {
    const classification = classifications.get(node);
    if (classification?.kind === "http") {
      // An HTTP route is reachable from the internet by path. One of them has
      // to hand the gateway a decrypted credential; the rest must not be able
      // to, and which one is which is pinned by name.
      if (!CREDENTIAL_HTTP_ROUTES.has(node)) {
        violations.push({
          node,
          reason:
            "is an HTTP route that can transitively reach the storage-secret decrypt path, and is not one of the enumerated CREDENTIAL_HTTP_ROUTES",
        });
      }
      continue;
    }
    if (classification?.isPublic) {
      violations.push({
        node,
        reason:
          "is a PUBLIC Convex function that can transitively reach the storage-secret decrypt path",
      });
    }
  }

  return { violations, decryptCapable, edges, schedules };
}

export function findViolations(modules: AnalyzedModule[]): Violation[] {
  return analyze(modules).violations;
}
