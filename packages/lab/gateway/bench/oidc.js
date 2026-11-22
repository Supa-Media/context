/**
 * GitHub Actions' signed token, the bench route's door for a workflow run (as `infra/tex-eval/src/oidc.ts` is the
 * Test Set's): a job with `id-token: write` asks GitHub for a token naming `AUDIENCE`, and this checks GitHub's
 * signature and the claims. Only the Lab's eval workflow on main gets in. No secret is kept anywhere: the token is
 * GitHub's, minted per job, good for minutes.
 *
 * A branch that dispatches the workflow on itself gets a token naming its own ref, and is refused. The bench objects
 * hold public benchmark notes only, which is why a run on main's workflow may read them whatever code it runs.
 */

export const ISSUER = "https://token.actions.githubusercontent.com";
export const AUDIENCE = "context-bench";
export const REPOSITORY = "Supa-Media/context";
export const WORKFLOW = `${REPOSITORY}/.github/workflows/lab-eval-run.yml@refs/heads/main`;
const JWKS_URL = `${ISSUER}/.well-known/jwks`;

let cached = null;
/** GitHub's signing keys, kept ten minutes per isolate. */
export async function githubKeys() {
  if (cached && Date.now() - cached.at < 600_000) return cached.keys;
  const response = await fetch(JWKS_URL);
  if (!response.ok) throw new Error("GitHub's signing keys could not be read");
  const body = await response.json();
  cached = { at: Date.now(), keys: Array.isArray(body?.keys) ? body.keys : [] };
  return cached.keys;
}

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const decode = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));

/** Whether `token` looks like a signed token at all (three parts, a JSON header), so the route knows which door. */
export const looksSigned = (token) => /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token ?? "");

/**
 * The claims when GitHub signed `token` for the bench's workflow on main; otherwise the reason, as `{refused}`.
 * `audience` and `workflow` name another door's (the Lab's preview test chats, `labSandbox/preview.js`): the same
 * checks, its own audience and its own workflow on main.
 */
export async function verifyGithubToken(token, { keys = githubKeys, now = Date.now(), audience = AUDIENCE, workflow = WORKFLOW, use = "the bench" } = {}) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return { refused: "not a signed token" };
  let header;
  let claims;
  try {
    header = decode(parts[0]);
    claims = decode(parts[1]);
  } catch {
    return { refused: "not a signed token" };
  }
  if (header?.alg !== "RS256") return { refused: "not signed the way GitHub signs" };
  let jwk;
  try {
    jwk = (await keys()).find((k) => k.kid === header.kid);
  } catch {
    return { refused: "GitHub's signing keys could not be read" };
  }
  if (!jwk) return { refused: "signed by a key GitHub does not publish" };
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const good = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!good) return { refused: "the signature does not hold" };
  const s = Math.floor(now / 1000);
  if (claims.iss !== ISSUER) return { refused: "not issued by GitHub Actions" };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(audience)) return { refused: `not meant for ${use}` };
  if (!(claims.exp > s)) return { refused: "expired" };
  if (typeof claims.nbf === "number" && claims.nbf > s + 60) return { refused: "not valid yet" };
  if (claims.repository !== REPOSITORY) return { refused: "not this repository" };
  if (claims.job_workflow_ref !== workflow || claims.ref !== "refs/heads/main") return { refused: `only ${workflow} may use ${use}` };
  return { claims };
}
