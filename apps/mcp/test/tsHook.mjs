/**
 * Lets the gateway's `node --test` files import the texting Worker's TypeScript, which the gateway's chat object
 * (`src/texChat.js`) runs as it is (step 3 of Tex's config graph, docs/architecture/tex.md). Wrangler bundles that
 * code for the deploy; Node 22 runs it here with `--experimental-transform-types`, and this hook fills in what a
 * bundler does and Node does not: a relative import with no extension is the `.ts` file beside it, and
 * `cloudflare:workers` is the Worker's own stand-in for tests (`apps/agent/src/cloudflareWorkers.testing.ts`).
 */
const WORKERS = new URL("../../agent/src/cloudflareWorkers.testing.ts", import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return { url: WORKERS, shortCircuit: true };
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[cm]?[jt]s$|\.json$/.test(specifier)) {
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      // Not a TypeScript file: resolved as written below.
    }
  }
  return next(specifier, context);
}
