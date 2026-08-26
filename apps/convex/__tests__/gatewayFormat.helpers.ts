/// <reference types="vite/client" />
/**
 * The gateway's own `privacy.md` parser, borrowed for the control plane's tests.
 *
 * `privacy.md` is on-bucket format. The control plane writes it once, at
 * connect time; `apps/mcp/src/index.js` reads it on every single request and
 * decides from it what a connected AI client is allowed to see. If the two
 * disagree about the format, the failure is not a stack trace — it is a
 * gateway that cannot parse the manifest and falls back to the legacy
 * `scopes.yml` path, which does not exist in a new bucket, which means no
 * rules, which means *everything defaults to private and the context looks
 * empty*. Or worse, a manifest that parses into rules nobody intended.
 *
 * A test asserting "the file we wrote looks like what we expect" would catch
 * none of that: both halves would be our own expectations. So this reaches for
 * the real thing.
 *
 * ## Why it is extracted rather than imported
 *
 * `parsePrivacyManifest` is module-private in the worker — the only export is
 * the `fetch`/`scheduled` handler object. Exporting it would mean editing
 * `apps/mcp`. Instead the worker's **actual source** is loaded as text, its
 * `import` lines and the `export default` are stripped, and it is evaluated as
 * a function body so its module-private declarations become locals we can
 * return. What runs is the gateway's own code, character for character, not a
 * transcription of it.
 *
 * If the worker ever grows a top-level statement that cannot survive this
 * (a side effect, another export), the sanity check below fails loudly rather
 * than silently testing nothing.
 */

/**
 * Globbed rather than imported as `"…/index.js?raw"` so the typing dependency
 * is exactly the one `structure.test.ts` and `test.setup.ts` already carry
 * (`ImportMeta.glob` from `vite/client`), instead of adding a second one.
 */
const GATEWAY_SOURCES = import.meta.glob("../../mcp/src/index.js", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const gatewaySource = Object.values(GATEWAY_SOURCES)[0];
if (typeof gatewaySource !== "string") {
  throw new Error(
    "apps/mcp/src/index.js could not be loaded; the privacy-format contract is untested",
  );
}

export interface PrivacyRule {
  prefix: string;
  vis: "team" | "private";
}

export interface ParsedPrivacyManifest {
  rules: PrivacyRule[];
  overrides: Map<string, "team" | "private">;
}

interface GatewayInternals {
  parsePrivacyManifest(text: string): ParsedPrivacyManifest;
  visibilityOf(key: string, rules: PrivacyRule[]): "team" | "private";
  effectiveVisibility(
    key: string,
    rules: PrivacyRule[],
    overrides: Map<string, string>,
  ): "team" | "private";
  isPlumbing(key: string): boolean;
  canSee(
    key: string,
    scope: string,
    rules: PrivacyRule[],
    overrides: Map<string, string>,
  ): boolean;
  renderPrivacyRulesBlock(
    rules: PrivacyRule[],
    overrides: Map<string, string>,
  ): string;
  replacePrivacyRulesBlock(
    text: string,
    rules: PrivacyRule[],
    overrides: Map<string, string>,
  ): string;
}

let cached: GatewayInternals | null = null;

/** The gateway's private helpers, evaluated from its real source. */
export function gatewayInternals(): GatewayInternals {
  if (cached) return cached;

  const body = gatewaySource
    .replace(/^import[\s\S]*?from\s+["'][^"']+["'];?$/gm, "")
    .replace(/^export default/m, "const __workerDefault =");

  if (/^export\s/m.test(body)) {
    throw new Error(
      "apps/mcp/src/index.js has an export this extraction does not handle; " +
        "update gatewayFormat.helpers.ts rather than weakening the assertion",
    );
  }

  const factory = new Function(
    `${body}\nreturn {
      parsePrivacyManifest,
      visibilityOf,
      effectiveVisibility,
      isPlumbing,
      canSee,
      renderPrivacyRulesBlock,
      replacePrivacyRulesBlock,
    };`,
  );
  cached = factory() as GatewayInternals;

  // Non-vacuity: prove we got the real parser and that it is strict, so a
  // later "it parsed!" assertion means something.
  let threw = false;
  try {
    cached.parsePrivacyManifest("no markers here");
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new Error(
      "the extracted parsePrivacyManifest accepted a manifest with no managed block",
    );
  }

  return cached;
}
