/**
 * The routine runner a Tex store's alarm calls: the named RPC entrypoint
 * `TexRoutines.routineDue({owner, id})` (`texRoutineDue.ts`).
 *
 * It is reachable only through a service binding that names the entrypoint.
 * Over HTTP the Worker has no such route, so `POST /tex/routine-due` answers
 * 404, whatever bearer it carries. The method checks its own arguments: a
 * chat's owner, a malformed owner, or a bad path is refused before the control
 * plane is asked anything.
 *
 * Double fire: the alarm and the cron can both ask. The control plane hands a
 * run out once (it moves the routine's next time and holds a lease), so the
 * second ask finds nothing due and nothing is run or reported.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";
import { TexRoutines } from "./texRoutineDue";

const CONTROL = "https://cp.example";
const GATEWAY = "https://gw.example";
const WORKSPACE = "ws_personal_1";
const PATH = "tex/routines/daily/standup.md";
const NEXT = 1_750_086_400_000;

type Seen = { url: string; auth: string | null; body: unknown };

/** The control plane and the gateway, as the entrypoint reaches them; `due` answers the due call. */
function world(due: (body: unknown) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ url, auth: new Headers(init?.headers).get("authorization"), body });
    if (url === `${CONTROL}/agent-texts/routines/due`) return due(body);
    if (url === `${CONTROL}/agent-texts/routines/result`) return Response.json({ status: "recorded" });
    if (url === `${GATEWAY}/agent`) return Response.json({ outcome: "answered", answer: "Standup.", send: "note" });
    return new Response(null, { status: 500 });
  });
  vi.stubGlobal("fetch", fetcher);
  return seen;
}

function env(): Env {
  return {
    SENDER_INBOX: {} as DurableObjectNamespace,
    AGENT_WORKER_SECRET: "control-plane-secret",
    CONTROL_PLANE_ORIGIN: CONTROL,
    GATEWAY_ORIGIN: GATEWAY,
  } as unknown as Env;
}

/** The entrypoint, as the Workers runtime makes one for a call through its service binding. */
function entrypoint(): TexRoutines {
  return new TexRoutines({} as ExecutionContext, env());
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

describe("the entrypoint refuses what is not a person's routine", () => {
  it.each([
    ["a chat's owner", { owner: "chat:abc123", id: PATH }],
    ["an owner with no workspace", { owner: "person:", id: PATH }],
    ["an owner that is not a person's", { owner: `workspace:${WORKSPACE}`, id: PATH }],
    ["an empty path", { owner: `person:${WORKSPACE}`, id: "" }],
    ["a path that is not a string", { owner: `person:${WORKSPACE}`, id: 7 }],
    ["a path with a NUL", { owner: `person:${WORKSPACE}`, id: "a\0b" }],
    ["no arguments", null],
  ])("refuses %s before asking the control plane", async (_name, call) => {
    const seen = world(() => Response.json({ runs: [runOf(NEXT)] }));
    await expect(entrypoint().routineDue(call as never)).rejects.toThrow(TypeError);
    expect(seen).toHaveLength(0);
  });
});

describe("the entrypoint runs its routine", () => {
  it("asks the control plane for that one routine, runs it once, and says when it runs next", async () => {
    const seen = world(() => Response.json({ runs: [runOf(NEXT)] }));
    expect(await entrypoint().routineDue(DUE)).toEqual({ next: NEXT });

    const asked = seen.find((call) => call.url === `${CONTROL}/agent-texts/routines/due`);
    expect(asked?.body).toEqual({ scope: { workspaceId: WORKSPACE, path: PATH } });
    expect(asked?.auth).toBe("Bearer control-plane-secret");
    const ran = seen.filter((call) => call.url === `${GATEWAY}/agent`);
    expect(ran).toHaveLength(1);
    expect(ran[0]!.auth).toBe("Bearer cat_grant_for_this_run_only");
  });

  it("a second alarm, or the cron's, finds nothing due: nothing runs, nothing is reported", async () => {
    // The first alarm's run is claimed, so the control plane hands out nothing now.
    const seen = world(() => Response.json({ runs: [] }));
    expect(await entrypoint().routineDue(DUE)).toEqual({ next: null });
    expect(seen.filter((call) => call.url === `${GATEWAY}/agent`)).toHaveLength(0);
    expect(seen.filter((call) => call.url.endsWith("/agent-texts/routines/result"))).toHaveLength(0);
  });

  it("rejects when the control plane cannot be reached, so the object tries again", async () => {
    world(() => new Response(null, { status: 500 }));
    await expect(entrypoint().routineDue(DUE)).rejects.toThrow();
  });
});

describe("the entrypoint is not an HTTP route", () => {
  it("answers 404 over HTTP, with or without a bearer, and asks the control plane nothing", async () => {
    const seen = world(() => Response.json({ runs: [runOf(NEXT)] }));
    const attempts: Array<Record<string, string>> = [{}, { authorization: "Bearer control-plane-secret" }];
    for (const headers of attempts) {
      const response = await worker.fetch(
        new Request("https://agent.example/tex/routine-due", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(DUE),
        }),
        env(),
      );
      expect(response.status).toBe(404);
    }
    expect(seen).toHaveLength(0);
  });
});
