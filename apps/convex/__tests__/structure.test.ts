/// <reference types="vite/client" />
/**
 * THE CREDENTIAL BOUNDARY, ENFORCED STRUCTURALLY.
 *
 * `SECURITY.md` commitment #2 says storage secrets are "decryptable only by
 * internal server code paths — never returned by any client-callable
 * function". This file is what makes that a property of the codebase rather
 * than a habit.
 *
 * ## What the previous guard was, and how it fell over
 *
 * It enumerated the exports of `functions/storage.ts` and asserted that no
 * *public* one had `secret`, `credential`, or `decrypt` in its **name**. Two
 * holes, and an adversarial review walked through both at once by adding a new
 * file:
 *
 * ```ts
 * // functions/gateway.ts
 * export const fetchBucketConfig = action({
 *   args: { workspaceId: v.id("workspaces") },
 *   handler: async (ctx, args) =>
 *     await ctx.runAction(internal.functions.storage.getBindingForGateway, args),
 * });
 * ```
 *
 * An unauthenticated caller got a decrypted secret and the whole suite stayed
 * green: the loop never looked outside one file, and `fetchBucketConfig`
 * contains none of the three words. A guard a rename defeats is not a guard,
 * and a guard scoped to the file you already trust is not a guard either.
 *
 * ## What this asserts instead
 *
 * It walks **every** Convex module, classifies each exported function by what
 * Convex itself says it is (`isPublic` / `isInternal` — not by its name), and
 * builds the call graph from `ctx.runQuery/runMutation/runAction(internal.…)`
 * references. Then: **no public function may transitively reach the decrypt
 * path.** Rename anything you like; add any file you like; the reachability is
 * what fails.
 *
 * Two supporting rules make that closure honest:
 *
 *  - **No dynamic dispatch.** A `ctx.runAction(someComputedRef)` cannot be
 *    followed statically, so it is refused outright rather than assumed safe.
 *    Otherwise `ctx.runAction((internal as any).functions.storage[name])`
 *    walks straight through the graph.
 *  - **Fail closed on helpers.** If a module reaches `decryptSecret` from
 *    somewhere other than inside a single exported function's body, the whole
 *    module is treated as decrypt-capable. A false positive costs a
 *    restructure; a false negative costs a customer's bucket.
 *
 * And the analysis is proved non-vacuous: the last test feeds the reviewer's
 * exact attack module through the same analyzer and requires it to be caught.
 */

import { describe, expect, test } from "vitest";

// Every Convex module, twice: once as source to analyze, once as a live module
// so the public/internal classification comes from Convex rather than from a
// naming convention. The ignore list matches `test.setup.ts`.
const RAW_SOURCES = import.meta.glob(
  ["../**/*.ts", "!../__tests__/**", "!../node_modules/**", "!../*.config.ts", "!../*.setup.ts"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const LIVE_MODULES = import.meta.glob(
  ["../**/*.ts", "!../__tests__/**", "!../node_modules/**", "!../*.config.ts", "!../*.setup.ts"],
  { eager: true },
) as Record<string, Record<string, unknown>>;

/** What Convex records on a registered function. */
interface Classification {
  isPublic: boolean;
  isInternal: boolean;
  kind: "query" | "mutation" | "action" | "http";
}

interface AnalyzedModule {
  /** Dotted reference path, e.g. `functions.storage`. */
  reference: string;
  /** Human-readable path for failure messages. */
  path: string;
  source: string;
  exports: Record<string, Classification>;
}

interface Violation {
  node: string;
  reason: string;
}

/** `../functions/lib/crypto.ts` → `functions.lib.crypto` */
function referencePath(globKey: string): string {
  return globKey
    .replace(/^\.\.\//, "")
    .replace(/\.ts$/, "")
    .split("/")
    .join(".");
}

function classify(value: unknown): Classification | null {
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
function exportBlocks(source: string): {
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
function withoutImports(source: string): string {
  return source.replace(/^import[\s\S]*?from\s+["'][^"']+["'];?$/gm, "");
}

const DECRYPT_CALL = /\bdecryptSecret\s*\(/;

/**
 * Which modules may import the decrypt at all.
 *
 * `DECRYPT_CALL` above is a text match on a module's own source, and the taint
 * graph's nodes are Convex functions — so a plain helper module that calls
 * `decryptSecret` and declares no Convex function is invisible to both. The
 * public function importing it contains no `decryptSecret(` and passes every
 * check in this file. See the laundering test for the three-line version.
 *
 * So the import is enumerated rather than the call inferred. Both entries here
 * declare Convex functions and are already analyzed properly; adding a third
 * fails this test, which is the point — a new module reaching the decrypt is a
 * conversation, not a merge.
 */
const DECRYPT_IMPORTERS: ReadonlySet<string> = new Set([
  "functions/storage.ts",
  "functions/cloudflare.ts",
  // THE THIRD, AND WHAT IT OPENS.
  //
  // Not a storage credential and not an account credential: a **PKCE
  // verifier**, parked for the ten minutes between sending somebody to
  // Dropbox and their coming back. It is sealed at rest for the same reason
  // the others are — this table would otherwise hold a live half-credential in
  // the clear — and it is opened in exactly one place, `exchangeAndBind`,
  // which is reachable only by a schedule edge.
  //
  // Worth stating plainly because the argument for a third importer is the
  // argument the comment above says to be suspicious of: it could not call one
  // of the two that already decrypt, because neither has anything to do with
  // an OAuth flow, and folding it into `storage.ts` would put the connect
  // handshake inside the module that serves credentials to the gateway.
  "functions/dropboxConnect.ts",
  // THE FOURTH, AND THE ONLY ONE THAT OPENS NOBODY'S CREDENTIAL BUT OURS.
  //
  // Every importer above holds something belonging to a *customer* — their
  // bucket key, their Cloudflare account, their half-finished Dropbox
  // handshake — and the rules around them exist to keep one tenant's secret
  // away from another tenant and from every client. `appSecrets` is the other
  // direction: the platform's own integration credentials, the Cloudflare
  // token that provisions search databases, a payment provider's key. No
  // tenant is on the other end of one.
  //
  // It is a separate importer rather than a row in `storage.ts` because the
  // two are bound to different things and must stay that way: a storage
  // envelope is sealed to a `workspaceId`, and these are sealed to the
  // `platform:integration` scope (`lib/crypto.ts`), so neither can ever
  // authenticate in the other's place. Putting both in one module would put
  // one keyset call away from the wrong context object.
  //
  // What bounds it: `readIntegrationSecret` is an internalAction with no
  // schedule edge and no route — the only callers are server-side
  // integrations that need the token to make an outbound request. The admin
  // console, which is the only thing that *writes* these rows, cannot read
  // one back: it has `listSecrets`, which returns a fingerprint, and there is
  // deliberately no `getSecret`. If one is ever added, this suite fails.
  "functions/admin.ts",
]);

/** An import of `decryptSecret`, in code rather than in prose. */
function importsDecrypt(source: string): boolean {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return /import\s*\{[^}]*\bdecryptSecret\b[^}]*\}\s*from/.test(withoutComments);
}
const CONVEX_REFERENCE = /\b(?:internal|api)((?:\.[A-Za-z_$][\w$]*)+)/g;
const RUN_CALL = /\.run(?:Query|Mutation|Action)\(\s*([^,)\s]*)/g;
/**
 * `ctx.scheduler.runAfter(delay, internal.x.y, …)` / `runAt(when, …)`.
 *
 * The delay expression is matched as "everything up to the first comma", so a
 * delay that itself contains a comma (`Math.max(0, n)`) will not match here.
 * That is a fail-closed miss, not a hole: with no scheduler span recorded, the
 * reference that follows is counted as an ordinary call edge and propagates
 * taint exactly as before.
 */
const SCHEDULE_CALL = /\.scheduler\.run(?:After|At)\(\s*[^,]*,\s*([^,)\s]*)/g;

/**
 * THE CREDENTIAL BARRIER SET.
 *
 * Every function here is decrypt-capable **and** may be called by a public
 * function. Taint stops at a barrier: its callers do not inherit it.
 *
 * That is a real relaxation of the property this file used to enforce — that
 * no public function could reach a credential *at all* — and it was added
 * deliberately, because the alternative is that a person can never read or
 * write their own bucket from the console. A read path has to obtain a
 * credential somewhere, and no static rule can prove that a function which
 * holds one does not leak it: a `returns: v.string()` handler could return
 * `credential.secretAccessKey` and satisfy any validator-based check.
 *
 * So the barrier is not a *proof*, it is a **pin**. What it buys:
 *
 *  - The set is enumerated here, by name. Adding a second one is a diff to
 *    this file that a reviewer sees, exactly like adding to the
 *    decrypt-capable list below.
 *  - Everything else is unchanged. A public function that calls
 *    `getBindingForGateway` directly — the reviewer's original attack — still
 *    fails, because that function is not a barrier. So does one that calls
 *    `verifyStorageBinding`, or any *new* internal function that opens a
 *    credential without being listed here.
 *  - The barrier's own return validator is checked for credential fields (see
 *    the test below), and `__tests__/fileContent.test.ts` asserts
 *    behaviourally that no credential and no note content reaches a caller,
 *    an audit row, or an error.
 *
 * A barrier earns its place by being small enough to read in one sitting and
 * by doing exactly one thing with the credential. `runFileOperation` builds one
 * `S3Store` and hands it to `lib/fileOps.ts`, which has no access to the
 * credential at all. **Do not add one without that property.**
 */
const CREDENTIAL_BARRIERS = new Set(["functions.files.runFileOperation"]);

/**
 * Every `encrypted*` column in the schema, lowercased — read from the schema
 * rather than typed out here.
 *
 * The two credential-field guards below match **specific field names**, so
 * until this existed they protected exactly the names somebody remembered to
 * add. That is the failure this file already documents one guard over: a
 * credential check that grepped export names, defeated by a rename in a new
 * file. A second credential shape — an OAuth refresh token beside an S3
 * secret, say — arrives as a new column with a new name, and a hand-maintained
 * list does not know about it. The list would still be green, and the guard
 * would be blind to precisely the field nobody had thought about yet.
 *
 * Deriving it means a new encrypted column is forbidden in a public return
 * validator from the moment it is declared, with nobody needing to remember.
 * `ENVELOPE_FIELDS` in `functions/storage.ts` is coupled to the schema the
 * same way and for the same reason.
 */
export function encryptedColumnsIn(schemaSource: string): string[] {
  const names = [...schemaSource.matchAll(/^\s+(encrypted[A-Za-z0-9]*)\s*:/gm)].map((match) =>
    match[1]!.toLowerCase(),
  );
  return [...new Set(names)];
}

const SCHEMA_ENCRYPTED_FIELDS = (() => {
  const source = RAW_SOURCES["../schema.ts"];
  if (typeof source !== "string") {
    throw new Error("structure.test.ts could not read schema.ts to derive credential fields");
  }
  return encryptedColumnsIn(source);
})();

/**
 * Plus the ones that are credentials without being encrypted at rest.
 *
 * `secretaccesskey` is the plaintext half nothing should ever return;
 * `accesskeyid` names the credential's public half, forbidden to a barrier
 * because a barrier returning half a key pair has already returned too much.
 */
const PLAINTEXT_CREDENTIAL_FIELDS = [
  // The S3 secret, and the Dropbox one. `accesstoken` matters as much as
  // `secretaccesskey` and is easier to miss, because it is the *decrypted*
  // half — the value `getBindingForGateway` hands the gateway, not an envelope
  // with an offline step in front of it. It never appears as a schema column,
  // so the derivation above cannot find it: at rest Dropbox is stored as
  // `encryptedAccessToken`, and the bare `accessToken` exists only in flight.
  // A guard that only reads the schema is a guard that only knows the shapes
  // that sit still.
  "secretaccesskey",
  "accesstoken",
];

const PUBLIC_FORBIDDEN_FIELDS = [
  ...new Set([...PLAINTEXT_CREDENTIAL_FIELDS, ...SCHEMA_ENCRYPTED_FIELDS]),
];
const BARRIER_FORBIDDEN_FIELDS = [
  ...new Set([...PLAINTEXT_CREDENTIAL_FIELDS, "accesskeyid", ...SCHEMA_ENCRYPTED_FIELDS]),
];

/**
 * THE HTTP ROUTES THAT MAY REACH A CREDENTIAL.
 *
 * There are two, and there is a reason it cannot be zero: the whole product is
 * a worker in another datacentre signing S3 requests with the customer's own
 * key, and the only way it gets that key is over HTTPS from here.
 * `/gateway/binding`'s *purpose* is to return a decrypted secret, and so is
 * `/gateway/ingest/binding`'s.
 *
 * ── The second entry, and what it costs ─────────────────────────────────────
 *
 * `/gateway/ingest/binding` was added with the Email Worker, and it is exactly
 * what the paragraph below warns about: a second internet-facing path to other
 * people's bucket keys. It is here rather than folded into the first because it
 * cannot present the same proofs. `/gateway/binding` requires an end user's
 * access token and derives the workspace from that grant; an inbound email has
 * no user token, because nobody is present and nothing was authorized just now.
 *
 * What it keeps, and what is checked below: the caller still cannot name a
 * context. It presents a ticket the control plane minted, bound at mint time to
 * whatever `resolvePersonalContextForIngestion` answered for a name a *sender*
 * typed. What it gives up is "a real person authorized this just now", and the
 * bound is that a stolen `EMAIL_WORKER_SECRET` reaches one ingestion-enabled
 * personal context's credential per single-use, five-minute ticket, rate-limited
 * per name, and no shared context ever.
 *
 * A third entry would need the same argument made again, in this comment.
 *
 * So this is not a barrier and must not be read as one. A barrier stops taint
 * propagating — everything that calls through it comes out clean, which is why
 * `CREDENTIAL_BARRIERS` has one member and a long warning attached. This is a
 * **pin**: the route is still decrypt-capable, it still appears in the
 * enumerated `decryptCapable` set below, and every *other* http route in the
 * codebase still fails if it can reach a credential. Adding a second entry
 * here is a diff a reviewer sees, and it means a second internet-facing path
 * to other people's bucket keys.
 *
 * What keeps the exemption honest, all enforced below:
 *
 *  - the route must actually be an `httpAction` and must actually be
 *    decrypt-capable, or the pin is stale;
 *  - **every** route in `http.ts` — this one included — must be built by the
 *    `gatewayRoute` factory, and that factory must require the gateway secret,
 *    so no route can be added that skips proof #1;
 *  - `expectedWorkspaceId` must never be used as a lookup key anywhere, which
 *    is what keeps proof #2 meaningful: the workspace comes from the grant the
 *    user's token resolved to, and the caller cannot name the workspace it
 *    gets.
 *
 * None of that proves the route does not leak. Nothing static can. It bounds
 * the blast radius to one reviewed, two-factor-authenticated path, and
 * `__tests__/controlPlane.test.ts` carries the behavioural half.
 */
const CREDENTIAL_HTTP_ROUTES = new Set([
  "http.gatewayBinding",
  "http.gatewayIngestBinding",
]);

/**
 * THE FACTORIES A ROUTE IN `http.ts` MAY BE BUILT BY.
 *
 * Every one of them must require a shared secret before the handler runs, and
 * the test below reads each factory's body to check that it does. The set is
 * enumerated for the same reason `CREDENTIAL_HTTP_ROUTES` is: adding a third
 * door is a diff to this file that a reviewer sees, rather than a route that
 * quietly checks nothing.
 *
 * They are separate factories because the two callers have different powers and
 * hold different secrets — see `EMAIL_WORKER_SECRET_ENV_VAR` in
 * `functions/lib/gatewayAuth.ts`. A test below asserts they really do read
 * different environment variables, so collapsing them into one shared secret
 * fails here.
 */
const ROUTE_FACTORIES: Record<string, string> = {
  gatewayRoute: "requestIsFromGateway",
  emailWorkerRoute: "requestIsFromEmailWorker",
};

/**
 * THE ROUTES THAT REQUIRE NO SECRET AT ALL.
 *
 * There is one, and the enumeration is the point: a route that checks nothing
 * has to be named here, in this file, in a diff a reviewer reads — never
 * something a handler quietly is.
 *
 * `sharePreview` answers a **link-preview crawler**, which has no session and
 * never will, and it is reached only through `infra/router`. A shared secret
 * would be a fourth credential to rotate for a value the request already
 * carries: the caller presents a share token, 32 bytes from
 * `crypto.getRandomValues` that only the owner and the person they sent it to
 * have seen. `infra/router/src/preview.ts` refuses to forward anything that is
 * not shaped like one, so garbage never reaches this deployment.
 *
 * What makes it safe is not the absence of a secret — it is what the route can
 * say. `previewTitleForToken` returns one field, `title`, and returns `null`
 * for an unknown token, a revoked share, an expired one, and one whose owner
 * turned the title off, so a crawler cannot tell any of them apart. The title
 * itself is owner-chosen or derived from the note's filename and is **never
 * read from the note**, so an unfurl costs the customer's bucket nothing.
 *
 * The tests in `sharePreview.test.ts` are what hold that; the entry here is
 * what stops a second one being added without the same argument.
 */
const UNAUTHENTICATED_HTTP_ROUTES = new Set([
  "sharePreview",
  "shareCard",
  "shareNotePreview",
]);

/**
 * Every response an unauthenticated route can produce, as its field names.
 *
 * A handler has more than one `return` — the success path and an early answer
 * for a malformed body — and a field added to the quiet one reaches the same
 * anonymous crawler on every bad request. Pinning the last literal, or the
 * first, is pinning half a route: measured, `owner: "seyi", notes: 42` on
 * either handler's early return passed all 39 checks here and the whole 1543
 * convex suite.
 *
 * It also asserts that **every** `return` is one of those literals. Without
 * that, the loop is satisfied by a handler that keeps its two `json({…})`
 * calls and adds a third branch returning a bare `new Response` — which was
 * also measured green.
 */
function unauthenticatedRouteResponses(source: string, handlerName: string): string[][] {
  const start = source.indexOf(`export const ${handlerName}`);
  expect(start, `${handlerName} is enumerated but not defined`).toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf("\n});", start));

  const returns = [...body.matchAll(/\breturn\s+([\s\S]{0,20}?)[({]/g)].map((m) =>
    m[0].replace(/\s+/g, " "),
  );
  for (const statement of returns) {
    expect(
      statement,
      `${handlerName} answers with something other than json(...): ${statement}`,
    ).toMatch(/return json\(/);
  }

  const literals = [...body.matchAll(/json\(\{([^{}]*)\}\)/g)];
  expect(
    literals.length,
    `${handlerName} should answer with flat object literals only`,
  ).toBe(returns.length);

  return literals.map(([, literal]) =>
    [...literal.matchAll(/([a-zA-Z_$][\w$]*)\s*:/g)].map((m) => m[1]!).sort(),
  );
}

/**
 * Build the graph and return every way a public function can reach a decrypt.
 *
 * Pure over its input so the same analyzer can be pointed at the real codebase
 * and at a synthetic attack module — see the final test.
 */
function analyze(modules: AnalyzedModule[]): {
  violations: Violation[];
  decryptCapable: Set<string>;
} {
  const violations: Violation[] = [];
  const decryptCapable = new Set<string>();
  const edges = new Map<string, string[]>();
  const classifications = new Map<string, Classification>();
  const knownNodes = new Set<string>();

  for (const module of modules) {
    for (const name of Object.keys(module.exports)) {
      knownNodes.add(`${module.reference}.${name}`);
    }
  }

  for (const module of modules) {
    const { preamble, blocks } = exportBlocks(module.source);

    // Fail closed: a decrypt reached from a module-level helper cannot be
    // attributed to one export, so every export in the module inherits it.
    const moduleWideTaint = DECRYPT_CALL.test(withoutImports(preamble));

    // Same fail-closed rule for *call edges*, and it is the hole the barrier
    // set would otherwise open. A module-level helper like
    //
    //   async function openStore(ctx, id) {
    //     return await ctx.runAction(internal.functions.storage.getBindingForGateway, …);
    //   }
    //
    // sits above the first `export const`, so it belongs to no export block and
    // its reference was previously counted for nobody — a public action could
    // call it and the graph would see nothing. Every export in the module now
    // inherits references found in the preamble.
    const preambleTargets: string[] = [];
    {
      const text = withoutImports(preamble);
      let found: RegExpExecArray | null;
      CONVEX_REFERENCE.lastIndex = 0;
      while ((found = CONVEX_REFERENCE.exec(text)) !== null) {
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
      if (moduleWideTaint || DECRYPT_CALL.test(body)) decryptCapable.add(node);

      let match: RegExpExecArray | null;

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
      const scheduledSpans: [number, number][] = [];
      SCHEDULE_CALL.lastIndex = 0;
      while ((match = SCHEDULE_CALL.exec(body)) !== null) {
        const argument = match[1];
        const start = match.index + match[0].length - argument.length;
        scheduledSpans.push([start, start + argument.length]);
        if (!/^internal\./.test(argument)) {
          violations.push({
            node,
            reason: `schedules ${argument || "<unparsed>"}, which is not a statically resolvable internal function reference — a scheduled target must be nameable, or the credential-reachability graph cannot see what was queued`,
          });
        }
      }
      const isScheduledReference = (index: number) =>
        scheduledSpans.some(([start, end]) => index >= start && index < end);

      const targets: string[] = [];
      CONVEX_REFERENCE.lastIndex = 0;
      while ((match = CONVEX_REFERENCE.exec(body)) !== null) {
        const target = match[1].slice(1);
        if (!knownNodes.has(target)) continue;
        if (isScheduledReference(match.index)) continue;
        targets.push(target);
      }
      edges.set(node, [...targets, ...preambleTargets]);

      // Every `ctx.runX` must name a statically resolvable function, or the
      // graph above is a fiction.
      RUN_CALL.lastIndex = 0;
      while ((match = RUN_CALL.exec(body)) !== null) {
        const argument = match[1];
        if (!/^(internal|api)\./.test(argument)) {
          violations.push({
            node,
            reason: `calls ctx.run…(${argument || "<unparsed>"}), which cannot be resolved statically — the credential-reachability graph cannot see through it`,
          });
        }
      }
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
          (target) => decryptCapable.has(target) && !CREDENTIAL_BARRIERS.has(target),
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

  return { violations, decryptCapable };
}

function findViolations(modules: AnalyzedModule[]): Violation[] {
  return analyze(modules).violations;
}

function realModules(): AnalyzedModule[] {
  return Object.keys(RAW_SOURCES).map((globKey) => {
    const exports: Record<string, Classification> = {};
    for (const [name, value] of Object.entries(LIVE_MODULES[globKey] ?? {})) {
      const classification = classify(value);
      if (classification !== null) exports[name] = classification;
    }
    return {
      reference: referencePath(globKey),
      path: globKey.replace(/^\.\.\//, ""),
      source: RAW_SOURCES[globKey],
      exports,
    };
  });
}

describe("no public function can reach a storage secret", () => {
/**
   * Pin the exact set of functions that can reach a decrypted credential.
   *
   * The scheduling exemption above is correct but load-bearing: a public
   * function may now *trigger* a decrypt, and no static rule can prove the
   * scheduled job never stores that plaintext somewhere a public query reads.
   * What remains checkable is the size of the blast radius — so the set is
   * enumerated here rather than merely bounded.
   *
   * If this test fails you have added a new way to reach a storage credential.
   * That may well be correct. It is not something to fix by editing the list
   * and moving on: whatever you added now holds other people's bucket keys, and
   * needs the same scrutiny `getBindingForGateway` got. Add it deliberately,
   * and say why in the commit.
   */
  /**
   * The other half of the same closure, one level below the graph.
   *
   * The test below enumerates which *functions* can reach a decrypt. This one
   * enumerates which *modules* may import it at all, and it is what stops a
   * plain helper — no Convex exports, therefore no graph node — from calling
   * `decryptSecret` on behalf of a public function whose own source never
   * mentions it.
   *
   * If this fails, do not add the module and move on. Ask why a third place
   * needs to open a customer's credential, and whether it could instead call
   * one of the two that already does.
   */
  test("only these modules may import the decrypt", () => {
    const importers = Object.entries(RAW_SOURCES)
      .filter(([, source]) => importsDecrypt(source as string))
      .map(([path]) => path.replace(/^(\.\.?\/)+/, ""))
      .sort();

    expect(importers).toEqual([...DECRYPT_IMPORTERS].sort());
  });

  test("only these functions can reach a decrypted credential", () => {
    const { decryptCapable } = analyze(realModules());

    expect([...decryptCapable].sort()).toEqual([
      // The decrypt itself. internalAction, so Convex refuses to route it
      // from a client.
      "functions.storage.getBindingForGateway",
      // Re-encrypts every binding during a key rotation. Reads plaintext by
      // definition; internal, batched, never client-reachable.
      "functions.storage.rekeyStorageBindings",
      // Builds a real S3Store to probe the bucket a user just connected.
      // Reached only by a schedule edge from bindStorage.
      "functions.provisioning.verifyStorageBinding",
      // THE SECOND KIND OF CREDENTIAL, AND THE ONLY FUNCTION THAT OPENS ONE.
      //
      // Everything else in this list decrypts a *storage* key — a credential
      // scoped to one bucket. This one decrypts the customer's **Cloudflare
      // account** credential, which is strictly more powerful: it can create
      // buckets and mint further credentials. It is here because there is no
      // way to create a bucket in somebody's account without briefly holding
      // something that may act on that account, and the alternative is that
      // the product only works for people who already know R2.
      //
      // What bounds it: the envelope exists for one attempt and one attempt
      // only. `beginProvisioning` writes it, this opens it, and the row
      // carrying it is deleted on success and stripped of it on failure — so
      // unlike a storage binding there is no steady state in which the
      // control plane holds an account-level Cloudflare credential at all.
      // internalAction, reached only by a schedule edge from
      // `beginProvisioning`, and `__tests__/cloudflare.test.ts` asserts
      // behaviourally that the token appears in no table and in no public
      // return value.
      "functions.cloudflare.provisionCloudflareStorage",
      // THE THIRD KIND, AND THE WEAKEST ONE.
      //
      // Opens the parked PKCE verifier so the authorization code can be
      // exchanged for a Dropbox grant. What it holds is not a key to anybody's
      // storage — a verifier is useless without the matching code, it is
      // ten minutes old at most, and the row carrying it is deleted *before*
      // this runs, so a replay finds nothing.
      //
      // It is here rather than inside `completeDropboxConnect` precisely
      // because that one is public: reached only by a schedule edge, which is
      // the same shape as `verifyStorageBinding`.
      "functions.dropboxConnect.exchangeAndBind",
      // THE CREDENTIAL'S FUNERAL. Opens a Dropbox refresh token one last
      // time to disable the grant at Dropbox after `disconnectStorage`
      // deleted the row — without it, "Disconnect" forgets our copy while
      // the authorization lives on in the person's account, and their next
      // connect silently auto-approves. The envelope arrives in the args
      // (the row is already gone), it is spent on one refresh + one revoke,
      // and every failure is swallowed: after this runs, successfully or
      // not, the control plane holds nothing. internalAction, reached only
      // by schedule edges — three of them now: `disconnectStorage`,
      // `applyBinding` rebinding away from Dropbox, and
      // `applyDropboxBinding` landing on a different account. A count in
      // this list is the sort of thing that goes stale silently, so it is
      // here to be checked rather than trusted.
      "functions.dropboxConnect.revokeDropboxGrant",
      // THE FILE EDITOR'S CREDENTIAL BARRIER. Builds one S3Store for one
      // file operation and hands it to lib/fileOps.ts, which never sees the
      // credential. internalAction, and the only member of
      // CREDENTIAL_BARRIERS — read that comment before adding a second.
      "functions.files.runFileOperation",
      // Resolves the end user's access token to a live grant, derives the
      // workspace from THAT grant, and opens that workspace's credential for
      // the gateway. internalAction; the only thing that reaches it is the
      // route below.
      "functions.controlPlane.openStorageBinding",
      // The ingest analogue. Spends a single-use ticket the control plane
      // minted, reads the workspace off THAT ticket's row, and opens its
      // credential for the Email Worker. internalAction; the only thing that
      // reaches it is `/gateway/ingest/binding`.
      "functions.ingestionGateway.openIngestionBinding",
      // AN INTERNET-FACING PATH TO A CREDENTIAL. `/gateway/binding`.
      // Requires the gateway secret AND the user's access token, and the
      // workspace comes from the grant, never from the caller.
      "http.gatewayBinding",
      // THE SECOND ONE. `/gateway/ingest/binding`. Requires the email worker's
      // own secret and a ticket we minted; there is no user token, because an
      // inbound email has nobody behind it. Read the CREDENTIAL_HTTP_ROUTES
      // comment before adding a third.
      "http.gatewayIngestBinding",
      // THE PLATFORM'S OWN CREDENTIALS, AND THE ONE FUNCTION THAT OPENS ONE.
      //
      // Not a customer's anything — see the `functions/admin.ts` entry in
      // DECRYPT_IMPORTERS. internalAction, no schedule edge and no HTTP route;
      // the callers are the server-side integrations that need a token to make
      // an outbound request with it.
      //
      // The thing to check if this list ever grows a sibling: the admin
      // console writes these rows and must never read one. It calls
      // `setSecret` (which encrypts and never decrypts) and `listSecrets`
      // (which returns a fingerprint). A `getSecret` would land in this list
      // as a *public* function and be caught by the next test rather than
      // this one.
      "functions.admin.readIntegrationSecret",
    ].sort());
  });

  test("every decrypt-capable Convex function is internal", () => {
    const modules = realModules();
    const { decryptCapable } = analyze(modules);
    const classifications = new Map<string, Classification>();
    for (const module of modules) {
      for (const [name, classification] of Object.entries(module.exports)) {
        classifications.set(`${module.reference}.${name}`, classification);
      }
    }

    // Belt to the violations check's braces: that test reports public
    // reachers, this one asserts the positive property directly, so a bug in
    // the reporting loop cannot make both pass.
    //
    // HTTP routes are excluded here and covered by their own rule below —
    // excluded because they carry no `isPublic`/`isInternal` at all, not
    // because they are trusted.
    for (const node of decryptCapable) {
      const classification = classifications.get(node);
      if (classification?.kind === "http") continue;
      expect(classification?.isPublic, `${node} must not be public`).toBe(false);
    }
  });

  test("every decrypt-capable HTTP route is one of the enumerated ones", () => {
    const modules = realModules();
    const { decryptCapable } = analyze(modules);
    const classifications = new Map<string, Classification>();
    for (const module of modules) {
      for (const [name, classification] of Object.entries(module.exports)) {
        classifications.set(`${module.reference}.${name}`, classification);
      }
    }

    const reachers = [...decryptCapable].filter(
      (node) => classifications.get(node)?.kind === "http",
    );
    expect(reachers.sort()).toEqual([...CREDENTIAL_HTTP_ROUTES].sort());
  });

  test("the analyzer actually sees the whole control plane", () => {
    const modules = realModules();
    const paths = modules.map((m) => m.path);

    // If a module stops being globbed, every assertion below silently passes
    // over it. Pin the ones that must be in scope.
    expect(paths).toContain("functions/storage.ts");
    expect(paths).toContain("functions/provisioning.ts");
    expect(paths).toContain("functions/grants.ts");
    expect(paths).toContain("functions/audit.ts");
    expect(paths).toContain("functions/workspaces.ts");
    expect(paths).toContain("functions/names.ts");

    const total = modules.reduce(
      (sum, module) => sum + Object.keys(module.exports).length,
      0,
    );
    expect(total).toBeGreaterThan(15);
  });

  test("every Convex function is either public or internal, never neither", () => {
    for (const module of realModules()) {
      for (const [name, classification] of Object.entries(module.exports)) {
        // An `httpAction` is genuinely neither: Convex routes it by path, not
        // through the `api`/`internal` object. It is not exempt from scrutiny
        // — it is held to the stricter HTTP rules above and below — but the
        // public/internal dichotomy does not apply to it.
        if (classification.kind === "http") continue;
        expect(
          classification.isPublic !== classification.isInternal,
          `${module.path}#${name} is classified as neither public nor internal (or as both)`,
        ).toBe(true);
      }
    }
  });

  test("the decrypt path exists and is reachable only from internal functions", () => {
    const violations = findViolations(realModules());
    expect(
      violations.map((v) => `${v.node} ${v.reason}`),
      "a public Convex function can reach the credential decrypt path",
    ).toEqual([]);
  });

  /**
   * The graph must actually find the decrypt path, or the test above passes
   * because it found nothing at all.
   */
  test("the analysis is not vacuous — it locates the real decrypting function", () => {
    const modules = realModules();
    const storage = modules.find((m) => m.path === "functions/storage.ts");
    expect(storage).toBeDefined();

    const { blocks } = exportBlocks(storage!.source);
    expect(DECRYPT_CALL.test(blocks.get("getBindingForGateway") ?? "")).toBe(true);
    expect(storage!.exports.getBindingForGateway).toEqual({
      kind: "action",
      isPublic: false,
      isInternal: true,
    });
  });

  /**
   * No public function's declared return type may carry a credential field.
   *
   * A second, independent net: reachability catches a public function that
   * *calls* the decrypt path, this catches one that returns a credential it
   * obtained some other way (a raw envelope read straight off the row, say).
   * It reads the validator Convex will actually enforce, not the source.
   */
  /**
   * The derivation itself, checked — because a regex that quietly stops
   * matching disables both guards below and leaves them green.
   *
   * This is the shape the file already warns about: "a guard nobody has checked
   * is not a guard". A derived list makes the guard cover fields nobody
   * remembered, and makes an empty list a silent all-clear. So: prove it finds
   * a column it was not told about, and prove it is not empty on the real
   * schema.
   */
  test("the credential-field list is derived from the schema, and the derivation works", () => {
    // A column that does not exist in this repo today. A hand-maintained list
    // could not know about it; the derivation must.
    expect(
      encryptedColumnsIn(
        [
          "  storageBindings: defineTable({",
          "    provider: v.string(),",
          "    encryptedRefreshToken: v.optional(v.string()),",
          "    encryptedAccessToken: v.optional(v.string()),",
          "    dropboxAccountId: v.optional(v.string()),",
          "  })",
        ].join("\n"),
      ),
    ).toEqual(["encryptedrefreshtoken", "encryptedaccesstoken"]);

    // Lowercased, deduplicated, and nothing that merely mentions the word.
    expect(encryptedColumnsIn("    encrypted: v.string(),")).toEqual(["encrypted"]);
    expect(encryptedColumnsIn("// encryptedThing: not a column")).toEqual([]);

    // And on the real schema it is non-empty and covers what is there now. An
    // empty list would make both guards below pass unconditionally.
    expect(SCHEMA_ENCRYPTED_FIELDS.length).toBeGreaterThan(0);
    expect(PUBLIC_FORBIDDEN_FIELDS).toContain("encryptedsecretaccesskey");
    expect(PUBLIC_FORBIDDEN_FIELDS).toContain("encryptedsetupcredential");
    expect(BARRIER_FORBIDDEN_FIELDS).toContain("encryptedsetupcredential");
    // The Dropbox columns, which the hand-written list never knew about.
    expect(PUBLIC_FORBIDDEN_FIELDS).toContain("encryptedrefreshtoken");
    expect(PUBLIC_FORBIDDEN_FIELDS).toContain("encryptedaccesstoken");
    expect(PUBLIC_FORBIDDEN_FIELDS).toContain("encryptedverifier");
    // And the decrypted token, which no schema column will ever name.
    expect(PUBLIC_FORBIDDEN_FIELDS).toContain("accesstoken");
    expect(BARRIER_FORBIDDEN_FIELDS).toContain("accesstoken");
  });

  test("no public function declares a credential field in its return validator", () => {
    // Derived from the schema, so a new credential column is covered the moment
    // it is declared. `encryptedsetupcredential` — the Cloudflare provisioning
    // envelope — arrives that way rather than by being remembered: it seals a
    // credential that can create buckets and mint further credentials in a
    // customer's cloud account, so it belongs here for the same reason the
    // storage envelope does. An opaque value is still the credential.
    const forbidden = PUBLIC_FORBIDDEN_FIELDS;
    for (const [globKey, module] of Object.entries(LIVE_MODULES)) {
      for (const [name, value] of Object.entries(module ?? {})) {
        const classification = classify(value);
        if (classification === null || !classification.isPublic) continue;

        const exportReturns = (value as { exportReturns?: () => string })
          .exportReturns;
        if (typeof exportReturns !== "function") continue;

        const returns = exportReturns.call(value).toLowerCase();
        for (const field of forbidden) {
          expect(
            returns.includes(`"${field}"`),
            `${globKey}#${name} is public and returns a "${field}" field`,
          ).toBe(false);
        }
      }
    }
  });

  /**
   * The reviewer's attack, run through the same analyzer.
   *
   * This is the test that says what the guard is worth. `functions/gateway.ts`
   * below is the file that defeated the old name-based check verbatim: a
   * public action, innocuously named, that launders the internal decrypting
   * action for an unauthenticated caller.
   */
  test("catches a new public module that launders the internal decrypting action", () => {
    const attack: AnalyzedModule = {
      reference: "functions.gateway",
      path: "functions/gateway.ts",
      source: `
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";

export const fetchBucketConfig = action({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) =>
    await ctx.runAction(internal.functions.storage.getBindingForGateway, args),
});
`,
      exports: {
        fetchBucketConfig: { kind: "action", isPublic: true, isInternal: false },
      },
    };

    const violations = findViolations([...realModules(), attack]);
    expect(violations.map((v) => v.node)).toContain(
      "functions.gateway.fetchBucketConfig",
    );
    expect(violations[0].reason).toMatch(/decrypt path/);
  });

  /** The other way through: hide the call target behind a computed reference. */
  test("refuses a ctx.run… call whose target cannot be resolved statically", () => {
    const attack: AnalyzedModule = {
      reference: "functions.dynamic",
      path: "functions/dynamic.ts",
      source: `
export const passthrough = action({
  args: { name: v.string() },
  handler: async (ctx, args) =>
    await ctx.runAction((internal as any).functions.storage[args.name], {}),
});
`,
      exports: {
        passthrough: { kind: "action", isPublic: true, isInternal: false },
      },
    };

    const violations = findViolations([...realModules(), attack]);
    expect(violations.map((v) => v.reason).join(" ")).toMatch(
      /cannot be resolved statically/,
    );
  });

  /** The fourth: launder it through an indirect export the splitter can't see. */
  test("catches a decrypt reached from a function that is not a plain `export const`", () => {
    const attack: AnalyzedModule = {
      reference: "functions.indirect",
      path: "functions/indirect.ts",
      source: `
import { internal } from "../_generated/api";
import { action } from "../_generated/server";

const passthrough = action({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) =>
    await ctx.runAction(internal.functions.storage.getBindingForGateway, args),
});

export { passthrough };
`,
      exports: {
        passthrough: { kind: "action", isPublic: true, isInternal: false },
      },
    };

    const violations = findViolations([...realModules(), attack]);
    expect(violations.map((v) => v.node)).toContain(
      "functions.indirect.passthrough",
    );
  });

  /**
   * And the sixth, which the five above all miss: the decrypt in a plain
   * TypeScript helper that declares no Convex functions.
   *
   * Every rule so far reasons over the *graph*, and the graph's nodes are
   * Convex functions. A module exporting an ordinary arrow function
   * contributes no nodes, so it is not a node anything can be tainted
   * through — while the public function that imports it contains no
   * `decryptSecret(` of its own and passes every textual check.
   *
   * This is the fourth time a guard here has been weaker than it looked
   * (CLAUDE.md keeps the tally: a check that grepped export names, an isolation
   * claim that inverted silently, an import guard that read prose as code), and
   * it is the same shape each time — a rule that describes the code it expects
   * rather than the code an attacker would write.
   *
   * The closure is the one this file already uses twice, for
   * `CREDENTIAL_BARRIERS` and for the pinned `decryptCapable` set: enumerate.
   * `decryptSecret` may be imported only by modules on `DECRYPT_IMPORTERS`, so
   * a laundering helper fails loudly and has to be argued for rather than
   * merged. The test below is the enumeration; this one proves it bites.
   */
  test("catches a decrypt laundered through a helper that declares no Convex functions", () => {
    const launder = `
import { decryptSecret, requireKeyset } from "./crypto";
export const open = (envelope: string, workspaceId: string) =>
  decryptSecret(envelope, requireKeyset(), { workspaceId });
`;
    expect(importsDecrypt(launder)).toBe(true);
    // …and a module that merely mentions it in prose does not, so the rule is
    // about code rather than about the word.
    expect(
      importsDecrypt("// this module never calls decryptSecret, it just says so\nexport const x = 1;"),
    ).toBe(false);
  });

  /** And the fifth: a public function in the same file as the decrypt. */
  test("catches a public function that decrypts inline, whatever it is called", () => {
    const attack: AnalyzedModule = {
      reference: "functions.innocuous",
      path: "functions/innocuous.ts",
      source: `
import { decryptSecret, requireKeyset } from "./lib/crypto";

export const health = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("storageBindings").first();
    return await decryptSecret(row.encryptedSecretAccessKey, requireKeyset(), {
      workspaceId: args.workspaceId,
    });
  },
});
`,
      exports: { health: { kind: "query", isPublic: true, isInternal: false } },
    };

    const violations = findViolations([...realModules(), attack]);
    expect(violations.map((v) => v.node)).toContain("functions.innocuous.health");
  });
});

/**
 * Scheduling versus calling.
 *
 * `applyBinding` queues `verifyStorageBinding`, which decrypts. The graph
 * treats that as a non-propagating edge, and these are the tests that say
 * exactly how far that exemption goes — because an exemption nobody probed is
 * indistinguishable from a hole.
 */
describe("a scheduled call is not a call", () => {
  /** The whole point: the real connect flow must be expressible. */
  test("a public function may schedule a decrypting internal function", () => {
    const scheduling: AnalyzedModule = {
      reference: "functions.connect",
      path: "functions/connect.ts",
      source: `
import { internal } from "../_generated/api";
import { mutation } from "../_generated/server";

export const connect = mutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(
      0,
      internal.functions.storage.getBindingForGateway,
      args,
    );
    return null;
  },
});
`,
      exports: {
        connect: { kind: "mutation", isPublic: true, isInternal: false },
      },
    };

    expect(findViolations([...realModules(), scheduling])).toEqual([]);
  });

  /**
   * The exemption is positional, not per-function. Naming the same target in
   * the scheduler's argument slot must not launder a real call to it
   * elsewhere in the same body.
   */
  test("scheduling a function does not excuse also calling it", () => {
    const attack: AnalyzedModule = {
      reference: "functions.both",
      path: "functions/both.ts",
      source: `
export const connect = action({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(
      0,
      internal.functions.storage.getBindingForGateway,
      args,
    );
    return await ctx.runAction(
      internal.functions.storage.getBindingForGateway,
      args,
    );
  },
});
`,
      exports: {
        connect: { kind: "action", isPublic: true, isInternal: false },
      },
    };

    expect(
      findViolations([...realModules(), attack]).map((v) => v.node),
    ).toContain("functions.both.connect");
  });

  /** A scheduled target still has to be nameable. */
  test("refuses a scheduled target that cannot be resolved statically", () => {
    const attack: AnalyzedModule = {
      reference: "functions.dynamicSchedule",
      path: "functions/dynamicSchedule.ts",
      source: `
export const queue = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(0, (internal as any).functions.storage[args.name], {});
  },
});
`,
      exports: { queue: { kind: "mutation", isPublic: true, isInternal: false } },
    };

    expect(
      findViolations([...realModules(), attack])
        .map((v) => v.reason)
        .join(" "),
    ).toMatch(/not a statically resolvable internal function reference/);
  });

  /** …and it has to be internal. Scheduling a public function is not a thing. */
  test("refuses a scheduled target that is a public api reference", () => {
    const attack: AnalyzedModule = {
      reference: "functions.publicSchedule",
      path: "functions/publicSchedule.ts",
      source: `
export const queue = mutation({
  args: {},
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, api.functions.storage.getStorageBinding, {});
  },
});
`,
      exports: { queue: { kind: "mutation", isPublic: true, isInternal: false } },
    };

    expect(
      findViolations([...realModules(), attack])
        .map((v) => v.reason)
        .join(" "),
    ).toMatch(/not a statically resolvable internal function reference/);
  });

  /**
   * Non-vacuity, again: the exemption is only meaningful if the target it
   * exempts really is decrypt-capable.
   */
  test("the function the real connect flow schedules does reach the decrypt path", () => {
    const modules = realModules();
    const storage = modules.find((m) => m.path === "functions/storage.ts");
    const { blocks } = exportBlocks(storage!.source);
    expect(blocks.get("applyBinding")).toMatch(
      /scheduler\.runAfter\(\s*0,\s*internal\.functions\.provisioning\.verifyStorageBinding/,
    );

    const provisioning = modules.find((m) => m.path === "functions/provisioning.ts");
    const provisioningBlocks = exportBlocks(provisioning!.source).blocks;
    // It reaches the decrypt path through `getBindingForGateway`…
    expect(provisioningBlocks.get("verifyStorageBinding")).toContain(
      "internal.functions.storage.getBindingForGateway",
    );
    // …and it is internal, so nothing but the scheduler can reach it.
    expect(provisioning!.exports.verifyStorageBinding).toEqual({
      kind: "action",
      isPublic: false,
      isInternal: true,
    });

    // Swap the schedule for a call — everything else about the module
    // identical — and the same analyzer rejects it. That is what makes the
    // exemption a distinction rather than a blanket amnesty for
    // `verifyStorageBinding`.
    const called: AnalyzedModule = {
      reference: "functions.storageCalling",
      path: "functions/storageCalling.ts",
      exports: storage!.exports,
      source: storage!.source
        .replace(/ctx\.scheduler\.runAfter\(\s*0,/, "ctx.runAction(")
        // Re-point the clone's internal references at itself, so the public
        // `bindStorage` reaches the clone's `applyBinding` and not the real
        // one, which still merely schedules.
        .split("internal.functions.storage.")
        .join("internal.functions.storageCalling."),
    };
    expect(
      findViolations([...realModules(), called]).map((v) => v.node),
    ).toContain("functions.storageCalling.bindStorage");
  });
});

/**
 * The credential barrier.
 *
 * `CREDENTIAL_BARRIERS` is the one place this file lets a public function
 * reach a decrypted credential, and an exemption nobody probed is
 * indistinguishable from a hole. These are the probes.
 */
describe("the credential barrier is a pin, not an amnesty", () => {
  /** Non-vacuity: a barrier that is not decrypt-capable proves nothing. */
  test("every barrier really does reach the decrypt path, and is internal", () => {
    const modules = realModules();
    const { decryptCapable } = analyze(modules);
    const classifications = new Map<string, Classification>();
    for (const module of modules) {
      for (const [name, classification] of Object.entries(module.exports)) {
        classifications.set(`${module.reference}.${name}`, classification);
      }
    }

    expect(CREDENTIAL_BARRIERS.size).toBeGreaterThan(0);
    for (const barrier of CREDENTIAL_BARRIERS) {
      expect(decryptCapable.has(barrier), `${barrier} is listed as a credential barrier but cannot reach a credential — either it is misnamed or the list is stale`).toBe(true);
      expect(classifications.get(barrier)).toEqual({
        kind: "action",
        isPublic: false,
        isInternal: true,
      });
    }
  });

  /**
   * A barrier's declared return type must not be able to carry a credential.
   *
   * The same check the public functions get, applied to the one internal
   * function public code is allowed to call. It is not a proof — a handler can
   * stuff a secret into a `v.string()` — but it makes the obvious mistake
   * impossible, and the behavioural half lives in `fileContent.test.ts`.
   */
  test("no barrier declares a credential field in its return validator", () => {
    const forbidden = BARRIER_FORBIDDEN_FIELDS;
    for (const [globKey, module] of Object.entries(LIVE_MODULES)) {
      for (const [name, value] of Object.entries(module ?? {})) {
        const node = `${referencePath(globKey)}.${name}`;
        if (!CREDENTIAL_BARRIERS.has(node)) continue;
        const exportReturns = (value as { exportReturns?: () => string }).exportReturns;
        expect(typeof exportReturns, `${node} must declare a return validator`).toBe(
          "function",
        );
        const returns = exportReturns!.call(value).toLowerCase();
        for (const field of forbidden) {
          expect(returns.includes(`"${field}"`), `${node} returns a "${field}" field`).toBe(
            false,
          );
        }
      }
    }
  });

  /** The whole point: the real console read path must be expressible. */
  test("a public function may call a barrier", () => {
    const caller: AnalyzedModule = {
      reference: "functions.console",
      path: "functions/console.ts",
      source: `
import { internal } from "../_generated/api";
import { action } from "../_generated/server";

export const read = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  handler: async (ctx, args) =>
    await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope: "private",
      operation: { kind: "read", path: args.path },
    }),
});
`,
      exports: { read: { kind: "action", isPublic: true, isInternal: false } },
    };

    expect(findViolations([...realModules(), caller])).toEqual([]);
  });

  /**
   * …and calling a decrypt-capable function that is *not* a barrier is still
   * the failure it always was. This is the attack the barrier could have
   * quietly legalised for every internal function at once.
   */
  test("a public function may not call a decrypt-capable non-barrier", () => {
    const attack: AnalyzedModule = {
      reference: "functions.probe",
      path: "functions/probe.ts",
      source: `
import { internal } from "../_generated/api";
import { action } from "../_generated/server";

export const reverify = action({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) =>
    await ctx.runAction(internal.functions.provisioning.verifyStorageBinding, args),
});
`,
      exports: { reverify: { kind: "action", isPublic: true, isInternal: false } },
    };

    expect(
      findViolations([...realModules(), attack]).map((v) => v.node),
    ).toContain("functions.probe.reverify");
  });

  /**
   * Being internal is not what makes something a barrier — being *listed* is.
   * A new internal action that opens a credential launders nothing.
   */
  test("a new internal function does not become a barrier by being internal", () => {
    const attack: AnalyzedModule = {
      reference: "functions.launder",
      path: "functions/launder.ts",
      source: `
import { internal } from "../_generated/api";
import { action, internalAction } from "../_generated/server";

export const openStore = internalAction({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) =>
    await ctx.runAction(internal.functions.storage.getBindingForGateway, args),
});

export const config = action({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) =>
    await ctx.runAction(internal.functions.launder.openStore, args),
});
`,
      exports: {
        openStore: { kind: "action", isPublic: false, isInternal: true },
        config: { kind: "action", isPublic: true, isInternal: false },
      },
    };

    expect(
      findViolations([...realModules(), attack]).map((v) => v.node),
    ).toContain("functions.launder.config");
  });

  /**
   * The hole the barrier set would otherwise open, and the reason the analyzer
   * now reads the module preamble.
   *
   * A helper above the first `export const` belongs to no export block. Before
   * this rule its `internal.…` reference was counted for nobody, so a public
   * action could reach a credential through a plain function and the graph saw
   * an empty edge list.
   */
  test("a module-level helper cannot hide a call to the decrypt path", () => {
    const attack: AnalyzedModule = {
      reference: "functions.helper",
      path: "functions/helper.ts",
      source: `
import { internal } from "../_generated/api";
import { action } from "../_generated/server";

async function openStore(ctx: any, workspaceId: any) {
  return await ctx.runAction(internal.functions.storage.getBindingForGateway, {
    workspaceId,
  });
}

export const peek = action({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const credential = await openStore(ctx, args.workspaceId);
    return credential.bucket;
  },
});
`,
      exports: { peek: { kind: "action", isPublic: true, isInternal: false } },
    };

    expect(
      findViolations([...realModules(), attack]).map((v) => v.node),
    ).toContain("functions.helper.peek");
  });
});

/**
 * THE HTTP SURFACE.
 *
 * `http.ts` carries the nine routes the MCP gateway resolves every request
 * through, and one of them exists specifically to hand out a decrypted storage
 * credential. Until these tests existed the analyzer could not see any of
 * them: `classify` returned `null` for an `httpAction`, so no route was a node,
 * no route had edges, and a route reaching `getBindingForGateway` produced
 * silence — the exact failure the reviewer's `functions/gateway.ts` attack
 * demonstrated for public actions, reachable through a different door.
 *
 * The rules here are stricter than the ones for `api`/`internal` functions,
 * because an HTTP route has no argument validator and no function-name gate in
 * front of it — only whatever its own handler checks first.
 */
describe("the gateway's HTTP routes", () => {
  /**
   * The twelve routes the contracts document, by the path each is served at.
   *
   * Nine from `apps/mcp/src/controlPlane.js` (the MCP gateway) and three from
   * `infra/email-worker/src/controlPlane.ts` (the Email Worker). A worker that
   * POSTs to a path this deployment does not serve gets a 404 and fails closed,
   * which is exactly what happened before the ingest three existed — so pinning
   * the paths here is what keeps "the contract" and "the routes" the same list.
   */
  const CONTRACT_ROUTES: Record<string, string> = {
    "/gateway/session": "gatewaySession",
    "/gateway/binding": "gatewayBinding",
    "/gateway/clients/register": "gatewayClientsRegister",
    "/gateway/clients/get": "gatewayClientsGet",
    "/gateway/authorize/start": "gatewayAuthorizeStart",
    "/gateway/codes/consume": "gatewayCodesConsume",
    "/gateway/grants/create": "gatewayGrantsCreate",
    "/gateway/grants/rotate": "gatewayGrantsRotate",
    "/gateway/grants/revoke": "gatewayGrantsRevoke",
    "/gateway/ingest/resolve": "gatewayIngestResolve",
    "/gateway/ingest/binding": "gatewayIngestBinding",
    "/gateway/ingest/record": "gatewayIngestRecord",
  };

  function httpModule(): AnalyzedModule {
    const module = realModules().find((m) => m.path === "http.ts");
    expect(module, "http.ts is not being analyzed at all").toBeDefined();
    return module!;
  }

  /**
   * Non-vacuity, and the thing that was actually broken. If `classify` stops
   * recognising `isHttp`, every other test in this block passes over an empty
   * set and proves nothing.
   */
  test("the analyzer classifies every control-plane route as an HTTP node", () => {
    const module = httpModule();
    for (const name of Object.values(CONTRACT_ROUTES)) {
      expect(module.exports[name], `http.ts#${name} is not classified`).toEqual({
        kind: "http",
        isPublic: true,
        isInternal: false,
      });
    }
  });

  /** …and that each is actually wired to the path the contract names. */
  test("each route is registered at its documented path, POST only", () => {
    const source = httpModule().source;
    for (const [path, name] of Object.entries(CONTRACT_ROUTES)) {
      const registration = new RegExp(
        `path:\\s*"${path.replace(/\//g, "\\/")}",\\s*method:\\s*"POST",\\s*handler:\\s*${name}`,
      );
      expect(
        registration.test(source.replace(/\s+/g, " ")),
        `${path} is not routed to ${name} as a POST`,
      ).toBe(true);
    }
  });

  /**
   * PROOF #1 CANNOT BE FORGOTTEN.
   *
   * Twelve handlers each remembering to check a shared secret is twelve chances
   * to forget, and the thirteenth route somebody adds in a hurry is the one
   * that does. So the check is not something a route *does*, it is something a
   * route *is*: every export is built by one of the enumerated factories, and
   * every factory refuses anything without its secret.
   */
  test("every route in http.ts is built by an enumerated secret-checking factory", () => {
    const source = httpModule().source;
    const declarations = [...source.matchAll(/^export const (\w+)\s*=\s*(\w+)\(/gm)];
    expect(declarations.length, "no routes found in http.ts").toBeGreaterThan(0);
    for (const [, name, factory] of declarations) {
      if (UNAUTHENTICATED_HTTP_ROUTES.has(name)) continue;
      expect(
        Object.keys(ROUTE_FACTORIES),
        `http.ts#${name} is built by ${factory}, which is not one of the enumerated route factories — so nothing forces it to require a secret`,
      ).toContain(factory);
    }
  });

  /**
   * The exemption is a pin, not an amnesty.
   *
   * An enumeration nobody checks the size of is a list that grows. This fails
   * if a second unauthenticated route appears, which forces the conversation
   * that entry #1 already had — the same discipline `CREDENTIAL_BARRIERS`
   * follows one section above.
   */
  test("the routes that require no secret are exactly the three share previews", () => {
    // `shareCard` joined `sharePreview` when the card moved into the
    // customer's bucket. It discloses strictly less than its neighbour — the
    // same owner-chosen title, as a picture — and is bounded the same way: a
    // 64-character CSPRNG token the owner handed out, a key computed from that
    // token rather than supplied, and one 404 for every absence.
    expect([...UNAUTHENTICATED_HTTP_ROUTES]).toEqual([
      "sharePreview",
      "shareCard",
      // The third, and the only one whose argument is guessable. It answers
      // only for notes the owner has explicitly team-linked, which is what
      // keeps the probe to the set they already chose to publish — see
      // `previewForNote`.
      //
      // **A folder link learned to name what is inside it and this list did not
      // grow**, which is the part worth stating: the contents are a field on
      // this route rather than a fourth route, so the argument that had to be
      // made three times has not had to be made a fourth. The exemption is a
      // pin, not an amnesty, and a route added here still owes it in full.
      "shareNotePreview",
    ]);

    const source = httpModule().source;
    const start = source.indexOf("export const sharePreview");
    expect(start, "sharePreview is enumerated but not defined").toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n});", start));

    /**
     * **Two fields wide now, and the second one had to be argued for.**
     *
     * This said "one field wide, or it is a different route", which was the
     * right bar and is not a bar against ever having two. The card's
     * description read "Sign in to read it" — true of every share there was,
     * false of an unlisted link, and a card that tells a stranger to sign in
     * when they need no account is the product being wrong on the first
     * surface they see.
     *
     * `openToAnyone` passes the test every field here has to pass: it
     * discloses nothing a crawler could not learn by following the link it is
     * already holding, and it is `false` for every absence, so the *tuple* is
     * byte-identical for unknown, revoked, expired and title-less shares.
     *
     * The fields are pinned by name and a spread is refused, because the
     * failure to expect on an unauthenticated route is a third field arriving
     * from upstream that nobody looked at.
     */
    expect(body).toContain("previewTitleForToken");
    expect(body).toMatch(/json\(\{\s*title:\s*result\.title,\s*openToAnyone:\s*result\.openToAnyone\s*\}\)/);
    expect(body, "sharePreview must not spread its upstream result").not.toMatch(
      /\.\.\.result/,
    );
    for (const forbidden of ["workspaceId", "slug", "entryPath", "recipient", "createdBy"]) {
      expect(body, `sharePreview must not return ${forbidden}`).not.toContain(forbidden);
    }

    // **EVERY response, not the last one**, and every response a `json(`.
    // See `unauthenticatedRouteResponses`.
    for (const keys of unauthenticatedRouteResponses(source, "sharePreview")) {
      expect(keys, "every sharePreview response returns exactly these fields").toEqual([
        "openToAnyone",
        "title",
      ]);
    }
  });

  /**
   * **The third route is three fields wide, and each one was argued for.**
   *
   * `title` is the note's or folder's own name; `cardToken` is a locator that
   * grants nothing, because a team share's reader is authorised by membership
   * on every request; `children` is two or three names from inside a linked
   * folder, filtered to what a `team` reader may see and bounded in
   * `previewForNote` before it gets here.
   *
   * The exact shape is pinned rather than a subset, because the failure to
   * expect on an unauthenticated route is a field being added upstream and
   * arriving here by a spread nobody looked at. `shareNotePreview` names its
   * three fields for that reason, and this reads them back.
   *
   * **`children` growing is the thing to watch.** The field is the only list on
   * any of these three routes, and the addition that would look like an
   * improvement — a count of what is inside — is the one that must never be
   * made from anything but the visible names themselves.
   */
  test("the readable team link's route returns three fields and no more", () => {
    const source = httpModule().source;
    const start = source.indexOf("export const shareNotePreview");
    expect(start, "shareNotePreview is enumerated but not defined").toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n});", start));

    expect(body).toContain("previewForNote");
    for (const field of ["title:", "cardToken:", "children:"]) {
      expect(body, `shareNotePreview must return ${field}`).toContain(field);
    }
    // A spread would let a field added upstream reach the internet without
    // anybody deciding it should.
    expect(body, "shareNotePreview must name its fields, never spread them").not.toMatch(
      /json\(\s*\{?\s*\.\.\.|json\(result\)/,
    );

    // …and THREE, not "at least three". Asserting the names are present and
    // denying four literals by name is not the same as bounding the object:
    // adding `noteCount: 42,` to the returned literal passed this test and all
    // 1482 checks beside it, and shipped a count on an unauthenticated route —
    // which is the one addition CLAUDE.md says must never be made from anything
    // but the visible names themselves. The keys are read out of the literal
    // rather than listed here, so a rename fails loudly instead of silently
    // widening the exemption.
    //
    // Read from EVERY response rather than the last, which is the hole the
    // sibling route's pin had and this one kept: `body.lastIndexOf("return
    // json({")` skipped the early answer for a malformed body, and
    // `owner: "seyi", noteCount: 42` on that branch passed all 39 checks here.
    for (const keys of unauthenticatedRouteResponses(source, "shareNotePreview")) {
      expect(keys, "every shareNotePreview response returns exactly these fields").toEqual([
        "cardToken",
        "children",
        "title",
      ]);
    }
    for (const forbidden of ["workspaceId", "recipient", "createdBy", "entryPath"]) {
      expect(body, `shareNotePreview must not return ${forbidden}`).not.toContain(
        forbidden,
      );
    }
  });

  /** And every factory really does check it — otherwise the rule above is decor. */
  test("every factory refuses a request that does not carry its secret", () => {
    const source = httpModule().source;
    for (const [factoryName, guard] of Object.entries(ROUTE_FACTORIES)) {
      const start = source.indexOf(`function ${factoryName}(`);
      expect(start, `${factoryName} is enumerated but not defined in http.ts`).toBeGreaterThan(-1);
      const factory = source.slice(start);
      const body = factory.slice(0, factory.indexOf("\n}\n"));
      expect(body, `${factoryName} does not call ${guard}`).toContain(`${guard}(`);
      expect(body, `${factoryName} does not refuse`).toMatch(/unauthorized\(\)/);
    }

    // …and the comparison is constant-time and length-blind, so the secret's
    // length is not readable from a timing difference.
    const gatewayAuth = realModules().find(
      (m) => m.path === "functions/lib/gatewayAuth.ts",
    );
    expect(gatewayAuth).toBeDefined();
    expect(gatewayAuth!.source).toMatch(/constantTimeEqualsHex/);
    expect(gatewayAuth!.source).toMatch(/hashToken\(presented\)/);
  });

  /**
   * THE TWO DOORS HAVE TWO KEYS.
   *
   * The email worker's secret buys a storage credential with no human in the
   * loop; the gateway's buys nothing without one. Collapsing them into a single
   * shared value — the obvious "simplification", since both are just bearer
   * secrets — would mean a stolen email-worker secret is a working MCP gateway
   * and a stolen gateway secret is a way into people's buckets. A comment saying
   * "these are deliberately different" cannot fail. This can.
   */
  test("each route factory's guard reads a different secret", () => {
    const gatewayAuth = realModules().find(
      (m) => m.path === "functions/lib/gatewayAuth.ts",
    )!;

    const envVarOf = (guard: string): string => {
      const start = gatewayAuth.source.indexOf(`export async function ${guard}(`);
      expect(start, `${guard} is not defined in gatewayAuth.ts`).toBeGreaterThan(-1);
      const body = gatewayAuth.source.slice(start);
      const match = /requestCarriesSecret\(\s*request,\s*(\w+)/.exec(
        body.slice(0, body.indexOf("\n}\n")),
      );
      expect(match, `${guard} does not delegate to requestCarriesSecret`).not.toBeNull();
      return match![1];
    };

    const guards = Object.values(ROUTE_FACTORIES);
    const envVars = guards.map(envVarOf);
    expect(new Set(envVars).size, `two route factories share one secret: ${envVars.join(", ")}`).toBe(
      guards.length,
    );

    // Non-vacuity: those constant names have to be real, and hold the values
    // the deployment actually configures.
    expect(gatewayAuth.source).toMatch(
      /export const GATEWAY_SECRET_ENV_VAR = "GATEWAY_SECRET"/,
    );
    expect(gatewayAuth.source).toMatch(
      /export const EMAIL_WORKER_SECRET_ENV_VAR = "EMAIL_WORKER_SECRET"/,
    );
  });

  /**
   * PROOF #2 CANNOT DEGRADE INTO A LOOKUP.
   *
   * `expectedWorkspaceId` is the gateway's own conclusion, sent so we can
   * refuse a mismatch. The moment it selects a row — a `db.get`, a
   * `normalizeId`, an index `eq`, an assignment into a `workspaceId:` field —
   * the gateway can name the workspace it gets, and a compromised gateway
   * walks the customer list one id at a time with one valid token.
   *
   * A comment saying "veto only" cannot fail. This can.
   */
  test("expectedWorkspaceId is never used as a lookup key", () => {
    for (const module of realModules()) {
      const offenders = lookupUsesOf(module.source, "expectedWorkspaceId");
      expect(
        offenders,
        `${module.path} uses expectedWorkspaceId to select something; it may only ever be compared`,
      ).toEqual([]);
    }
  });

  /** Non-vacuity for the check above: it must catch the thing it forbids. */
  test("the lookup-key check catches the refactor it exists to prevent", () => {
    expect(
      lookupUsesOf(
        `const binding = await ctx.db.get(args.expectedWorkspaceId);`,
        "expectedWorkspaceId",
      ),
    ).toHaveLength(1);
    expect(
      lookupUsesOf(
        `await ctx.runAction(ref, { workspaceId: args.expectedWorkspaceId });`,
        "expectedWorkspaceId",
      ),
    ).toHaveLength(1);
    expect(
      lookupUsesOf(
        `.withIndex("by_workspace", (q) => q.eq("workspaceId", args.expectedWorkspaceId))`,
        "expectedWorkspaceId",
      ),
    ).toHaveLength(1);
    // The real usage — a comparison — must not be flagged, or the check is
    // just noise somebody will delete.
    expect(
      lookupUsesOf(
        `if (args.expectedWorkspaceId !== session.workspaceId) return null;`,
        "expectedWorkspaceId",
      ),
    ).toEqual([]);
  });

  /**
   * The enumerated exception has to be real. A pin naming a route that cannot
   * reach a credential is a stale pin, and a stale pin is how the next one
   * gets added without anyone noticing.
   */
  test("every enumerated credential route is an HTTP route that really reaches the decrypt path", () => {
    const modules = realModules();
    const { decryptCapable } = analyze(modules);
    const classifications = new Map<string, Classification>();
    for (const module of modules) {
      for (const [name, classification] of Object.entries(module.exports)) {
        classifications.set(`${module.reference}.${name}`, classification);
      }
    }

    expect(CREDENTIAL_HTTP_ROUTES.size).toBeGreaterThan(0);
    for (const route of CREDENTIAL_HTTP_ROUTES) {
      expect(
        decryptCapable.has(route),
        `${route} is pinned as a credential route but cannot reach a credential — either it is misnamed or the pin is stale`,
      ).toBe(true);
      expect(classifications.get(route)?.kind).toBe("http");
    }
  });

  /**
   * The attack this extension exists to catch, run through the same analyzer:
   * a *new* route that quietly reaches the decrypt path. Before `classify`
   * understood `isHttp`, this produced no violation at all.
   */
  test("catches a new HTTP route that reaches the decrypt path", () => {
    const attack: AnalyzedModule = {
      reference: "http",
      path: "http.ts",
      source: `
export const gatewayDebugBinding = gatewayRoute(async (ctx, body) => {
  const credential = await ctx.runAction(
    internal.functions.storage.getBindingForGateway,
    { workspaceId: body.workspaceId },
  );
  return json({ binding: credential });
});
`,
      exports: {
        gatewayDebugBinding: { kind: "http", isPublic: true, isInternal: false },
      },
    };

    const violations = findViolations([...realModules(), attack]);
    expect(violations.map((v) => v.node)).toContain("http.gatewayDebugBinding");
    expect(violations.map((v) => v.reason).join(" ")).toMatch(
      /enumerated CREDENTIAL_HTTP_ROUTES/,
    );
  });

  /** The indirect form: a new route reaching it through the internal resolver. */
  test("catches a new HTTP route that launders the credential through an internal action", () => {
    const attack: AnalyzedModule = {
      reference: "http",
      path: "http.ts",
      source: `
export const gatewayPeek = gatewayRoute(async (ctx, body) => {
  const binding = await ctx.runAction(
    internal.functions.controlPlane.openStorageBinding,
    { hashedAccessToken: body.hashedAccessToken, expectedWorkspaceId: null },
  );
  return json({ bucket: binding.bucket });
});
`,
      exports: {
        gatewayPeek: { kind: "http", isPublic: true, isInternal: false },
      },
    };

    expect(
      findViolations([...realModules(), attack]).map((v) => v.node),
    ).toContain("http.gatewayPeek");
  });

  /** A route that touches no credential is fine, and must stay fine. */
  test("an ordinary HTTP route is not a violation", () => {
    const benign: AnalyzedModule = {
      reference: "http",
      path: "http.ts",
      source: `
export const gatewayHealth = gatewayRoute(async () => json({ ok: true }));
`,
      exports: {
        gatewayHealth: { kind: "http", isPublic: true, isInternal: false },
      },
    };

    expect(findViolations([...realModules(), benign])).toEqual([]);
  });
});

/**
 * Lines that use `name` to *select* something rather than to compare it.
 *
 * Deliberately line-oriented and deliberately crude: it over-reports rather
 * than under-reports, and an over-report costs a restructure while an
 * under-report costs a customer's bucket.
 */
function lookupUsesOf(source: string, name: string): string[] {
  // Comments are allowed to describe the forbidden refactor — the docstring on
  // `openStorageBinding` names `ctx.db.get(expectedWorkspaceId)` precisely so a
  // reader knows what must never appear. What must not exist is a *use*.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  const offenders: string[] = [];
  for (const line of code.split("\n")) {
    if (!line.includes(name)) continue;
    if (/(?:db\.get|normalizeId|withIndex|\.eq)\s*\(/.test(line)) {
      offenders.push(line.trim());
      continue;
    }
    // An assignment into a workspace-id-shaped field. The lookbehind is what
    // keeps `expectedWorkspaceId:` itself — the argument declaration — from
    // matching its own name.
    if (/(?<![A-Za-z])workspaceId\s*:\s*[^,\n]*\b\w*expectedWorkspaceId/.test(line)) {
      offenders.push(line.trim());
    }
  }
  return offenders;
}
