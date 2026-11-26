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
    expect(await scored.json()).toEqual({ verdict: { pass: true, total: 1, right: 1, main: 1, attempts: 1, byNode: { fd: { total: 1, right: 1, main: 1, worse: false } }, byKind: { one: { total: 1, right: 1, main: 1 } } } });
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

describe("the Search Test's doors", () => {
  it("lets in only the search workflows' tokens, each at its own door", async () => {
    const { sign, keys } = await signer();
    const searchRun = await sign({ job_workflow_ref: WORKFLOWS["search-run"] });
    const searchSeed = await sign({ job_workflow_ref: WORKFLOWS["search-seed"] });
    await expect(verify(searchRun, "search-run", keys)).resolves.toMatchObject({ run_id: "4242" });
    await expect(verify(searchSeed, "search-seed", keys)).resolves.toBeTruthy();
    await expect(verify(searchRun, "search-seed", keys)).rejects.toThrow(/may use this door/);
    await expect(verify(searchSeed, "search-run", keys)).rejects.toThrow(/may use this door/);
    // Tex's tokens never open the search doors, and the search tokens never open Tex's.
    await expect(verify(await sign(), "search-run", keys)).rejects.toThrow(/may use this door/);
    await expect(verify(await sign({ job_workflow_ref: WORKFLOWS.seed }), "search-seed", keys)).rejects.toThrow(/may use this door/);
    await expect(verify(searchRun, "run", keys)).rejects.toThrow(/may use this door/);
    await expect(verify(searchSeed, "seed", keys)).rejects.toThrow(/may use this door/);
  });

  it("refuses a branch's copy of a search workflow, the same file on main's name notwithstanding", async () => {
    const { sign, keys } = await signer();
    const onBranch = (file: string) => sign({ ref: "refs/heads/feature", job_workflow_ref: `${REPOSITORY}/.github/workflows/${file}@refs/heads/feature` });
    await expect(verify(await onBranch("search-test-set.yml"), "search-run", keys)).rejects.toThrow();
    await expect(verify(await onBranch("search-test-set-seed.yml"), "search-seed", keys)).rejects.toThrow();
  });
});

describe("the Search Test's HTTP doors", () => {
  const held = { id: "lease", set: "test", query: "when does my lease end", as: "sam", expect: ["@seyi/home/lease.md"], kind: "lease", notes: { "@seyi/home/lease.md": "The lease ends in June." } };
  const envWith = (vars: Partial<Env> = {}) => {
    const obj = new TestSet({ storage: { sql: sqlStorage() } } as never, {});
    obj.searchPut(held as never, "user_1");
    return { TEST_SET: { idFromName: () => "id", get: () => obj }, ...vars } as unknown as Env;
  };
  const post = (path: string, body: unknown, authorization?: string) =>
    new Request(`https://gateway.test/tex-eval${path}`, { method: "POST", body: JSON.stringify(body), headers: authorization ? { authorization } : {} });
  const start = { pr: 3, sha: "a".repeat(40), base: "b".repeat(40) };

  it("answers search counts to anyone, and no words", async () => {
    const text = await (await handle(new Request("https://gateway.test/tex-eval/search/counts"), envWith())).text();
    expect(JSON.parse(text)).toEqual({ cases: 1, byKind: { lease: 1 } });
    expect(text).not.toMatch(/lease ends|when does/i);
  });

  it("hands the search cases only to main's search workflow, and only at its own door", async () => {
    const { sign, keys } = await signer();
    const env = envWith();
    const searchToken = await sign({ job_workflow_ref: WORKFLOWS["search-run"] });
    expect((await handle(post("/v1/search/runs", start), env, keys)).status).toBe(401);
    expect((await handle(post("/v1/search/runs", start, await sign()), env, keys)).status).toBe(401);
    const branchToken = await sign({ ref: "refs/heads/x", job_workflow_ref: `${REPOSITORY}/.github/workflows/search-test-set.yml@refs/heads/x` });
    expect((await handle(post("/v1/search/runs", start, branchToken), env, keys)).status).toBe(401);
    // The Tex run door does not hand out search cases either.
    expect((await handle(post("/v1/runs", start, searchToken), env, keys)).status).toBe(401);
    const res = await handle(post("/v1/search/runs", start, searchToken), env, keys);
    expect(res.status).toBe(200);
    const { run, cases } = (await res.json()) as { run: string; cases: { id: string }[] };
    expect(cases.map((c) => c.id)).toEqual(["lease"]);
    const answers = [{ id: "lease", rank: 1 }];
    const scored = await handle(post("/v1/search/runs/result", { run, branch: answers, main: answers }, searchToken), env, keys);
    expect(await scored.json()).toEqual({ verdict: { pass: true, total: 1, first: 1, mainFirst: 1, top5: 1, mainTop5: 1 } });
    expect((await handle(post("/v1/search/runs", start, await sign({ job_workflow_ref: WORKFLOWS["search-run"], run_id: "5" })), env, keys)).status).toBe(429);
  });

  it("refuses Tex's workflow at the search seed door, and the search workflow at Tex's seed door", async () => {
    const { sign, keys } = await signer();
    const env = envWith();
    expect((await handle(post("/v1/search/seed", { cases: [] }, await sign()), env, keys)).status).toBe(401);
    expect((await handle(post("/v1/seed", { conversations: [] }, await sign({ job_workflow_ref: WORKFLOWS["search-seed"] })), env, keys)).status).toBe(401);
    const seeded = await handle(post("/v1/search/seed", { cases: [held] }, await sign({ job_workflow_ref: WORKFLOWS["search-seed"] })), env, keys);
    expect(await seeded.json()).toMatchObject({ kept: 0, skipped: [expect.stringContaining("already here")] });
  });

  it("answers no search run on a deployment that runs none, and no GET on a search run path", async () => {
    const { sign, keys } = await signer();
    const searchToken = await sign({ job_workflow_ref: WORKFLOWS["search-run"] });
    expect((await handle(post("/v1/search/runs", start, searchToken), envWith({ RUNS: "off" }), keys)).status).toBe(404);
    expect((await handle(new Request("https://gateway.test/tex-eval/v1/search/runs"), envWith(), keys)).status).toBe(405);
  });
});
