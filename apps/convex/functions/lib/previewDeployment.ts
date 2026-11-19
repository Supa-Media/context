/**
 * Is this deployment a per-branch preview, and which one?
 *
 * A preview is a Convex preview deployment created by `.github/workflows/deploy-preview.yml`
 * for one pull request, with its own Workers on `workers.dev`
 * (`docs/decisions/testing/preview-environments.md`). It holds only seeded,
 * fictional data, so a few staging-only conveniences (persona sign-in codes,
 * free managed storage, the seed) are allowed there too. Everything that
 * widens is asked through `isIsolatedPreview`, and nothing else.
 *
 * All legs must hold, each ruling out a different mistake:
 *
 *  - `APP_ENV` is exactly `preview`. Production and staging set their own.
 *  - `PREVIEW_NAME` is `pr<N>`: the name the workflow gave this preview, and
 *    the prefix of every bucket, database and index it creates, so cleanup can
 *    find them and nothing it creates can collide with a real workspace's.
 *  - `APP_ORIGIN` is that preview's own router on `workers.dev`
 *    (`https://context-router-pr<N>.<subdomain>.workers.dev`), never a
 *    `context.lc` or `tex.lc` host.
 *  - `CONVEX_CLOUD_URL`, set by the platform, is a `.convex.cloud` deployment,
 *    and is not the one `STAGING_CONVEX_DEPLOYMENT` names.
 *
 * An operator who copied production's variables onto a preview, or a preview's
 * onto production, fails the third leg: production's `APP_ORIGIN` is
 * `https://context.lc`.
 */

/** What this module reads. `process.env` in production, a literal in tests. */
type Environment = Record<string, string | undefined>;

/** `pr` and a pull request number, no leading zero. */
export const PREVIEW_NAME_PATTERN = /^pr[1-9][0-9]{0,6}$/;

/** The preview's name when every leg holds, else null. */
export function previewName(env: Environment = process.env): string | null {
  if (env.APP_ENV !== "preview") return null;
  const name = env.PREVIEW_NAME ?? "";
  if (!PREVIEW_NAME_PATTERN.test(name)) return null;

  let origin: URL;
  try {
    origin = new URL(env.APP_ORIGIN ?? "");
  } catch {
    return null;
  }
  if (origin.protocol !== "https:" || origin.port !== "" || origin.pathname !== "/" || origin.search || origin.hash) return null;
  if (env.APP_ORIGIN !== origin.origin) return null;
  const labels = origin.hostname.split(".");
  if (labels.length !== 4 || labels[0] !== `context-router-${name}` || labels[2] !== "workers" || labels[3] !== "dev") return null;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(labels[1])) return null;

  let cloud: URL;
  try {
    cloud = new URL(env.CONVEX_CLOUD_URL ?? "");
  } catch {
    return null;
  }
  if (cloud.protocol !== "https:" || !/^[a-z0-9-]+\.convex\.cloud$/.test(cloud.hostname)) return null;
  const staging = env.STAGING_CONVEX_DEPLOYMENT;
  if (staging && cloud.hostname === `${staging}.convex.cloud`) return null;
  return name;
}

/** True only on a per-branch preview deployment. */
export function isIsolatedPreview(env: Environment = process.env): boolean {
  return previewName(env) !== null;
}

/**
 * The prefix a preview puts in front of every bucket, search database and
 * meaning index it creates (`pr<N>-`), or "" anywhere else.
 */
export function previewResourcePrefix(env: Environment = process.env): string {
  const name = previewName(env);
  return name === null ? "" : `${name}-`;
}
