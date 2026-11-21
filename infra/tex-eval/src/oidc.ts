/**
 * GitHub Actions OIDC: the only way a run reaches the Test Set. A workflow job with `id-token: write` asks GitHub
 * for a token naming this service as its audience; GitHub signs it, and its claims say which repository, which
 * workflow file at which ref, and which run asked. This Worker checks the signature against GitHub's published
 * keys and then the claims, so only main's own Test Set workflows get in. There is no secret to keep: a branch can
 * dispatch `tex-test-set.yml` on itself, but then its token names `@refs/heads/<branch>`, and is refused.
 */

export const ISSUER = "https://token.actions.githubusercontent.com";
export const AUDIENCE = "context-tex-eval";
export const REPOSITORY = "Supa-Media/context";
const JWKS_URL = `${ISSUER}/.well-known/jwks`;

/** The workflows each door takes, as GitHub writes `job_workflow_ref`: the file on main and nowhere else. */
export const WORKFLOWS = {
  run: `${REPOSITORY}/.github/workflows/tex-test-set.yml@refs/heads/main`,
  seed: `${REPOSITORY}/.github/workflows/tex-test-set-seed.yml@refs/heads/main`,
  "search-run": `${REPOSITORY}/.github/workflows/search-test-set.yml@refs/heads/main`,
  "search-seed": `${REPOSITORY}/.github/workflows/search-test-set-seed.yml@refs/heads/main`,
} as const;
export type Door = keyof typeof WORKFLOWS;

export interface Claims {
  iss: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nbf?: number;
  repository: string;
  ref: string;
  job_workflow_ref: string;
  run_id: string;
  run_attempt?: string;
  actor?: string;
  [k: string]: unknown;
}

export class Refused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refused";
  }
}

type Jwk = JsonWebKey & { kid?: string };
export type KeySource = () => Promise<Jwk[]>;

let cached: { at: number; keys: Jwk[] } | null = null;
/** GitHub's signing keys, kept ten minutes. */
export const githubKeys: KeySource = async () => {
  if (cached && Date.now() - cached.at < 600_000) return cached.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Refused("GitHub's signing keys could not be read");
  const body = (await res.json()) as { keys?: Jwk[] };
  cached = { at: Date.now(), keys: body.keys ?? [] };
  return cached.keys;
};

const b64url = (s: string) => {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
};
const decode = <T>(s: string): T => JSON.parse(new TextDecoder().decode(b64url(s))) as T;

/** The bearer token's claims when GitHub signed it for this door; else throws `Refused` with the reason. */
export async function verify(authorization: string | null, door: Door, keys: KeySource = githubKeys, now = Date.now()): Promise<Claims> {
  const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
  if (!token) throw new Refused("no token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Refused("not a signed token");
  let header: { alg?: string; kid?: string };
  let claims: Claims;
  try {
    header = decode(parts[0]);
    claims = decode(parts[1]);
  } catch {
    throw new Refused("not a signed token");
  }
  if (header.alg !== "RS256") throw new Refused("not signed the way GitHub signs");
  const jwk = (await keys()).find((k) => k.kid === header.kid);
  if (!jwk) throw new Refused("signed by a key GitHub does not publish");
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const good = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!good) throw new Refused("the signature does not hold");
  const s = Math.floor(now / 1000);
  if (claims.iss !== ISSUER) throw new Refused("not issued by GitHub Actions");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(AUDIENCE)) throw new Refused("not meant for this service");
  if (!(claims.exp > s)) throw new Refused("expired");
  if (typeof claims.nbf === "number" && claims.nbf > s + 60) throw new Refused("not valid yet");
  if (claims.repository !== REPOSITORY) throw new Refused("not this repository");
  if (claims.job_workflow_ref !== WORKFLOWS[door] || claims.ref !== "refs/heads/main") throw new Refused(`only ${WORKFLOWS[door]} may use this door`);
  if (!/^\d+$/.test(String(claims.run_id ?? ""))) throw new Refused("no run named");
  return claims;
}
