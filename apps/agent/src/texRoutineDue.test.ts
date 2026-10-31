/**
 * The route a Tex store's alarm calls (`POST /tex/routine-due`, `texRoutineDue.ts`).
 *
 * It is reachable only through the gateway's service binding, and the binding
 * is no proof of who calls, so the route also needs `TEX_ALARM_SECRET` as a
 * bearer. Refused: no secret configured, a missing or wrong bearer, a chat's
 * owner, a malformed body. Each refusal happens before the control plane is
 * asked anything.
 *
 * Double fire: the alarm and the cron may both ask. The control plane hands a
 * run out once (it moves the routine's next time and holds a lease), so the
 * second ask finds nothing due and nothing is run or texted.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";

const SECRET = "tex-alarm-secret-not-a-real-one";
const CONTROL = "https://cp.example";
const GATEWAY = "https://gw.example";
const WORKSPACE = "ws_personal_1";
const PATH = "tex/routines/daily/standup.md";
const NEXT = 1_750_086_400_000;

type Seen = { url: string; method: string; auth: string | null; body: unknown };

/** The control plane and the gateway, as the route reaches them; `due` answers the due call. */
function world(due: (body: unknown) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ url, method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization"), body });
    if (url === `${CONTROL}/agent-texts/routines/due`) return due(body);
    if (url === `${CONTROL}/agent-texts/routines/result`) return Response.json({ status: "recorded" });
    if (url === `${GATEWAY}/agent`) return Response.json({ outcome: "answered", answer: "Standup.", send: "note" });
    return new Response(null, { status: 500 });
  });
  vi.stubGlobal("fetch", fetcher);
  return seen;
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    SENDER_INBOX: {} as DurableObjectNamespace,
    AGENT_WORKER_SECRET: "control-plane-secret",
    CONTROL_PLANE_ORIGIN: CONTROL,
    GATEWAY_ORIGIN: GATEWAY,
    TEX_ALARM_SECRET: SECRET,
    ...overrides,
  } as unknown as Env;
}

function alarm(body: unknown, { bearer = SECRET }: { bearer?: string | null } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
  return new Request("https://agent.example/tex/routine-due", { method: "POST", headers, body: JSON.stringify(body) });
}

const DUE = { owner: `person:${WORKSPACE}`, id: PATH };

const runOf = (next: number | null) => ({
  runId: "run_1",
  accessToken: "cat_grant_for_this_run_only",
  path: PATH,
  timeZone: "Europe/London",
  send: "note",
  phones: [],
  nextRunAt: next,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the alarm's route refuses what is not the gateway's alarm", () => {
  it("refuses everything when no secret is configured, even a bearer of nothing", async () => {
    const seen = world(() => Response.json({ runs: [] }));
    const unset = await worker.fetch(alarm(DUE, { bearer: "" }), env({ TEX_ALARM_SECRET: undefined }));
    expect(unset.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("refuses a missing or wrong bearer before it reads the body or asks the control plane", async () => {
    const seen = world(() => Response.json({ runs: [runOf(NEXT)] }));
    expect((await worker.fetch(alarm(DUE, { bearer: null }), env())).status).toBe(401);
    expect((await worker.fetch(alarm(DUE, { bearer: "guess" }), env())).status).toBe(401);
    // The control plane's own secret is not this route's: it is a different credential, and it does not open this.
    expect((await worker.fetch(alarm(DUE, { bearer: "control-plane-secret" }), env())).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("refuses a GET, and any path other than its own", async () => {
    world(() => Response.json({ runs: [] }));
    const get = await worker.fetch(new Request("https://agent.example/tex/routine-due", { headers: { authorization: `Bearer ${SECRET}` } }), env());
    expect(get.status).toBe(405);
  });

  it("refuses a chat's owner and a malformed owner or path, with the right bearer", async () => {
    const seen = world(() => Response.json({ runs: [runOf(NEXT)] }));
    expect((await worker.fetch(alarm({ owner: "chat:abc123", id: PATH }), env())).status).toBe(400);
    expect((await worker.fetch(alarm({ owner: "person:", id: PATH }), env())).status).toBe(400);
    expect((await worker.fetch(alarm({ owner: `person:${WORKSPACE}`, id: "" }), env())).status).toBe(400);
    expect((await worker.fetch(alarm({ owner: `person:${WORKSPACE}`, id: 7 }), env())).status).toBe(400);
    expect((await worker.fetch(alarm(null), env())).status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});

describe("the alarm runs its routine", () => {
  it("asks the control plane for that one routine, runs it once, and says when it runs next", async () => {
    const seen = world(() => Response.json({ runs: [runOf(NEXT)] }));
    const response = await worker.fetch(alarm(DUE), env());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: NEXT });

    const asked = seen.find((call) => call.url === `${CONTROL}/agent-texts/routines/due`);
    expect(asked?.body).toEqual({ scope: { workspaceId: WORKSPACE, path: PATH } });
    expect(asked?.auth).toBe("Bearer control-plane-secret");
    const ran = seen.filter((call) => call.url === `${GATEWAY}/agent`);
    expect(ran).toHaveLength(1);
    expect(ran[0]!.auth).toBe("Bearer cat_grant_for_this_run_only");
  });

  it("a second alarm, or the cron's, finds nothing due: nothing runs, and nothing is texted or reported", async () => {
    // The first alarm's run is claimed, so the control plane hands out nothing now.
    const seen = world(() => Response.json({ runs: [] }));
    const response = await worker.fetch(alarm(DUE), env());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ next: null });
    expect(seen.filter((call) => call.url === `${GATEWAY}/agent`)).toHaveLength(0);
    expect(seen.filter((call) => call.url.endsWith("/agent-texts/routines/result"))).toHaveLength(0);
  });

  it("answers 503 when the control plane cannot be reached, so the object tries again", async () => {
    world(() => new Response(null, { status: 500 }));
    const response = await worker.fetch(alarm(DUE), env());
    expect(response.status).toBe(503);
  });
});
