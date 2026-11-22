/**
 * The bench route's door for a workflow run (`packages/lab/gateway/bench/oidc.js`): GitHub's signature, then the
 * claims. Only the Lab's eval workflow on main, in this repository, for the bench's audience, gets in.
 *
 * Sabotage record (temporary local edits, reverted): dropping the `job_workflow_ref` check, the audience check or the
 * signature check each fails its line below.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { AUDIENCE, ISSUER, REPOSITORY, WORKFLOW, looksSigned, verifyGithubToken } from "../../../packages/lab/gateway/bench/oidc.js";

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

async function signer() {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
  const sign = async (claims, kid = "k1") => {
    const head = b64url(JSON.stringify({ alg: "RS256", kid }));
    const body = b64url(JSON.stringify(claims));
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`)));
    return `${head}.${body}.${b64url(sig)}`;
  };
  return { sign, keys: async () => [jwk] };
}

const now = 1_800_000_000_000;
const good = { iss: ISSUER, aud: AUDIENCE, exp: now / 1000 + 300, iat: now / 1000, repository: REPOSITORY, ref: "refs/heads/main", job_workflow_ref: WORKFLOW, run_id: "1" };

test("GitHub's token for the eval workflow on main gets in; any other is refused with its reason", async () => {
  const { sign, keys } = await signer();
  const check = async (claims) => await verifyGithubToken(await sign(claims), { keys, now });
  assert.ok((await check(good)).claims);
  assert.ok(looksSigned(await sign(good)));
  assert.match((await check({ ...good, job_workflow_ref: `${REPOSITORY}/.github/workflows/other.yml@refs/heads/main` })).refused, /only/);
  assert.match((await check({ ...good, ref: "refs/heads/feature", job_workflow_ref: WORKFLOW.replace("refs/heads/main", "refs/heads/feature") })).refused, /only/);
  assert.match((await check({ ...good, aud: "context-tex-eval" })).refused, /not meant/);
  assert.match((await check({ ...good, repository: "someone/context" })).refused, /repository/);
  assert.match((await check({ ...good, exp: now / 1000 - 1 })).refused, /expired/);
  assert.match((await check({ ...good, iss: "https://example.invalid" })).refused, /not issued/);
  const token = await sign(good);
  const [h, , s] = token.split(".");
  assert.match((await verifyGithubToken(`${h}.${b64url(JSON.stringify({ ...good, run_id: "2" }))}.${s}`, { keys, now })).refused, /signature/);
  assert.match((await verifyGithubToken(await sign(good, "other"), { keys, now })).refused, /key GitHub does not publish/);
  assert.match((await verifyGithubToken("not.a.jwt", { keys, now })).refused, /not a signed token/);
});
