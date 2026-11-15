import { describe, expect, it } from "vitest";
import { sqlStorage } from "../test/sql";
import { handle, type Env } from "./index";
import { AUDIENCE, ISSUER, REPOSITORY, WORKFLOWS, verify } from "./oidc";
import { TestSet } from "./testSet";

const enc = (v: unknown) => btoa(typeof v === "string" ? v : JSON.stringify(v)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

async function signer() {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey), kid: "k1" };
  const now = Math.floor(Date.now() / 1000);
  const good = { iss: ISSUER, aud: AUDIENCE, exp: now + 300, iat: now, repository: REPOSITORY, ref: "refs/heads/main", job_workflow_ref: WORKFLOWS.run, run_id: "4242", actor: "someone" };
  const sign = async (claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, key = pair.privateKey) => {
    const head = enc({ alg: "RS256", kid: "k1", typ: "JWT", ...header });
    const body = enc({ ...good, ...claims });
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`)));
    return `Bearer ${head}.${body}.${enc(String.fromCharCode(...sig))}`;
  };
  return { sign, keys: async () => [jwk] };
}

describe("GitHub OIDC", () => {
  it("lets in main's Test Set workflow and nothing else", async () => {
    const { sign, keys } = await signer();
    await expect(verify(await sign(), "run", keys)).resolves.toMatchObject({ run_id: "4242" });
    const refused = async (claims: Record<string, unknown>, door: "run" | "seed" = "run", header = {}) => expect(verify(await sign(claims, header), door, keys)).rejects.toThrow();
    // The same workflow file dispatched on a branch names the branch: refused, so a branch never sees the cases.
    await refused({ job_workflow_ref: `${REPOSITORY}/.github/workflows/tex-test-set.yml@refs/heads/feature`, ref: "refs/heads/feature" });
    await refused({ ref: "refs/heads/feature" });
    await refused({ job_workflow_ref: `${REPOSITORY}/.github/workflows/tex-replay.yml@refs/heads/main` });
    await refused({ repository: "someone/context" });
    await refused({ aud: "sts.amazonaws.com" });
    await refused({ iss: "https://example.com" });
    await refused({ exp: Math.floor(Date.now() / 1000) - 1 });
    await refused({ run_id: "" });
    // The run workflow's token does not open the seed door, nor the other way round.
    await refused({}, "seed");
    await expect(verify(await sign({ job_workflow_ref: WORKFLOWS.seed }), "seed", keys)).resolves.toBeTruthy();
    await refused({}, "run", { alg: "none" });
    await refused({}, "run", { kid: "other" });
  });

  it("refuses a token signed by any key but GitHub's, and one with no token at all", async () => {
    const { keys } = await signer();
    const other = await signer();
    await expect(verify(await other.sign(), "run", keys)).rejects.toThrow(/signature/);
    await expect(verify(null, "run", keys)).rejects.toThrow(/no token/);
    await expect(verify("Bearer a.b", "run", keys)).rejects.toThrow();
  });
});

describe("the HTTP doors", () => {
  const envWith = (vars: Partial<Env> = {}) => {
    const obj = new TestSet({ storage: { sql: sqlStorage() } } as never, {});
    obj.put({ id: "lease", set: "test", title: "Lease and landlord", msgs: [{ id: "m1", who: "Sam", text: "when does my lease end", labels: { fd: { star: true } } }] }, "user_1");
    return { TEST_SET: { idFromName: () => "id", get: () => obj }, ...vars } as unknown as Env;
  };
  const post = (path: string, body: unknown, authorization?: string) =>
    new Request(`https://gateway.test/tex-eval${path}`, { method: "POST", body: JSON.stringify(body), headers: authorization ? { authorization } : {} });

  it("answers counts to anyone, and no words", async () => {
    const res = await handle(new Request("https://gateway.test/tex-eval/counts"), envWith());
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ chats: 1, stars: 1, byNode: { fd: 1 }, perChat: [{ stars: 1, kind: "one", msgs: 1 }] });
    expect(text).not.toMatch(/lease/i);
  });

  it("hands the conversations only to main's workflow, then scores its answers", async () => {
    const { sign, keys } = await signer();
    const env = envWith();
    const start = { pr: 3, sha: "a".repeat(40), base: "b".repeat(40) };
    expect((await handle(post("/v1/runs", start), env, keys)).status).toBe(401);
    const branchToken = await sign({ ref: "refs/heads/x", job_workflow_ref: `${REPOSITORY}/.github/workflows/tex-test-set.yml@refs/heads/x` });
    expect((await handle(post("/v1/runs", start, branchToken), env, keys)).status).toBe(401);
    const res = await handle(post("/v1/runs", start, await sign()), env, keys);
    expect(res.status).toBe(200);
    const { run, conversations } = (await res.json()) as { run: string; conversations: { id: string }[] };
    expect(conversations.map((c) => c.id)).toEqual(["lease"]);
    const answers = [{ chat: "lease", msg: "m1", node: "fd", right: true }];
    const scored = await handle(post("/v1/runs/result", { run, branch: answers, main: answers }, await sign()), env, keys);
    expect(await scored.json()).toEqual({ verdict: { pass: true, total: 1, right: 1, main: 1, byNode: { fd: { total: 1, right: 1, main: 1 } } } });
    // The next run on the same commit, from another GitHub run, is capped.
    expect((await handle(post("/v1/runs", start, await sign({ run_id: "5" })), env, keys)).status).toBe(429);
  });

  it("answers no run on a deployment that runs none, and nothing on a path it does not serve", async () => {
    const { sign, keys } = await signer();
    expect((await handle(post("/v1/runs", {}, await sign()), envWith({ RUNS: "off" }), keys)).status).toBe(404);
    expect((await handle(new Request("https://gateway.test/tex-eval/v1/chats"), envWith(), keys)).status).toBe(404);
    expect((await handle(new Request("https://gateway.test/tex-eval/v1/runs"), envWith(), keys)).status).toBe(405);
  });
});
