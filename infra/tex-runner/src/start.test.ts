import { describe, expect, it } from "vitest";
import { ISSUER, REPOSITORY, WORKFLOWS, verify } from "../../tex-eval/src/oidc";
import { labelFor } from "./github";
import { AUDIENCE, ONLINE_WITHIN_MS, handle, type Runners } from "./start";

const enc = (v: unknown) => btoa(typeof v === "string" ? v : JSON.stringify(v)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

async function signer() {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey), kid: "k1" };
  const now = Math.floor(Date.now() / 1000);
  const good = { iss: ISSUER, aud: AUDIENCE, exp: now + 300, iat: now, repository: REPOSITORY, ref: "refs/heads/main", job_workflow_ref: WORKFLOWS["lab-runner"], run_id: "4242", run_attempt: "2" };
  const sign = async (claims: Record<string, unknown> = {}) => {
    const head = enc({ alg: "RS256", kid: "k1", typ: "JWT" });
    const body = enc({ ...good, ...claims });
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`)));
    return `Bearer ${head}.${body}.${enc(String.fromCharCode(...sig))}`;
  };
  return { sign, keys: async () => [jwk] };
}

/** A fake GitHub: registers runner 7, which comes online after `onlineAfter` status reads. */
function fakeGitHub({ registerStatus = 201, onlineAfter = 1 } = {}) {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  let reads = 0;
  const fetcher = async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/generate-jitconfig")) return Response.json({ runner: { id: 7 }, encoded_jit_config: "jit-secret" }, { status: registerStatus });
    if (method === "DELETE") return new Response(null, { status: 204 });
    reads++;
    return Response.json({ status: reads >= onlineAfter ? "online" : "offline" });
  };
  return { fetcher, calls };
}

function fakeRunners(fresh = true) {
  const started: unknown[][] = [];
  const stopped: string[] = [];
  const runners: Runners = {
    start: async (...args) => (started.push(args), fresh),
    stop: async (label) => void stopped.push(label),
  };
  return { runners, started, stopped };
}

const ask = (authorization?: string, path = "/v1/start", method = "POST") =>
  new Request(`https://runner.test${path}`, { method, headers: authorization ? { authorization } : {} });

describe("the Lab runner's door", () => {
  it("opens only to main's tex-lab-sandbox.yml, run from main, with this service's audience", async () => {
    const { sign, keys } = await signer();
    await expect(verify(await sign(), "lab-runner", keys, Date.now(), AUDIENCE)).resolves.toBeTruthy();
    const refusedWith = async (claims: Record<string, unknown>) => {
      const github = fakeGitHub();
      const { runners, started } = fakeRunners();
      const res = await handle(ask(await sign(claims)), { token: "t", runners, keys, fetcher: github.fetcher, sleep: async () => {} });
      expect(res.status).toBe(401);
      expect(github.calls).toEqual([]);
      expect(started).toEqual([]);
    };
    // A branch dispatching the workflow on itself names its branch.
    await refusedWith({ job_workflow_ref: `${REPOSITORY}/.github/workflows/tex-lab-sandbox.yml@refs/heads/feature`, ref: "refs/heads/feature" });
    // Another workflow on main, the eval service's audience, and another repository.
    await refusedWith({ job_workflow_ref: WORKFLOWS.run });
    await refusedWith({ aud: "context-tex-eval" });
    await refusedWith({ repository: "someone/context" });
    const res = await handle(ask(), { token: "t", runners: fakeRunners().runners, keys });
    expect(res.status).toBe(401);
  });

  it("registers one runner for this run's attempt and answers its label once it is online", async () => {
    const { sign, keys } = await signer();
    const github = fakeGitHub({ onlineAfter: 3 });
    const { runners, started } = fakeRunners();
    const res = await handle(ask(await sign()), { token: "t", runners, keys, fetcher: github.fetcher, sleep: async () => {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ label: "tex-lab-4242-2" });
    const registered = github.calls.find((c) => c.url.endsWith("/generate-jitconfig"));
    expect(registered?.body).toMatchObject({ name: "tex-lab-4242-2", labels: ["tex-lab-4242-2"] });
    expect(started).toEqual([["tex-lab-4242-2", 7, "jit-secret"]]);
    // The configuration is the container's alone: never in the answer.
    expect(JSON.stringify(await handle(ask(await sign()), { token: "t", runners, keys, fetcher: github.fetcher, sleep: async () => {} }).then((r) => r.json()))).not.toContain("jit-secret");
  });

  it("stops and removes a runner that does not come online, so the workflow runs the job on GitHub", async () => {
    const { sign, keys } = await signer();
    const github = fakeGitHub({ onlineAfter: Infinity });
    const { runners, stopped } = fakeRunners();
    let t = 0;
    const res = await handle(ask(await sign()), { token: "t", runners, keys, fetcher: github.fetcher, now: () => t, sleep: async (ms) => void (t += ms) });
    expect(res.status).toBe(504);
    expect(t).toBeGreaterThanOrEqual(ONLINE_WITHIN_MS);
    expect(stopped).toEqual(["tex-lab-4242-2"]);
    expect(github.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/runners/7"))).toBe(true);
  });

  it("refuses a second runner for the same attempt, and a GitHub that will not register one", async () => {
    const { sign, keys } = await signer();
    const again = fakeGitHub();
    const res = await handle(ask(await sign()), { token: "t", runners: fakeRunners(false).runners, keys, fetcher: again.fetcher, sleep: async () => {} });
    expect(res.status).toBe(409);
    expect(again.calls.some((c) => c.method === "DELETE")).toBe(true);
    const refused = await handle(ask(await sign()), { token: "t", runners: fakeRunners().runners, keys, fetcher: fakeGitHub({ registerStatus: 403 }).fetcher, sleep: async () => {} });
    expect(refused.status).toBe(502);
    const none = await handle(ask(await sign()), { token: undefined, runners: fakeRunners().runners, keys, sleep: async () => {} });
    expect(none.status).toBe(503);
  });

  it("has one door", async () => {
    expect((await handle(ask(undefined, "/v1/other"), { token: "t", runners: fakeRunners().runners })).status).toBe(404);
    expect((await handle(ask(undefined, "/v1/start", "GET"), { token: "t", runners: fakeRunners().runners })).status).toBe(405);
  });

  it("labels a run's attempt and nothing else", () => {
    expect(labelFor("4242", "1")).toBe("tex-lab-4242-1");
    expect(() => labelFor("4242;rm", "1")).toThrow();
    expect(() => labelFor("4242", "")).toThrow();
  });
});
