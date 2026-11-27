/**
 * Tex in mail, the Worker's part (`texMail.ts`): a person's Tex store's alarm calls `TexRoutines.texMailDue({ owner })`,
 * which claims that person's waiting runs from the control plane and has the gateway run each with its own session.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./index";
import { TexRoutines } from "./texRoutineDue";

const CONTROL = "https://cp.example";
const GATEWAY = "https://gw.example";
const WORKSPACE = "ws_personal_1";

type Seen = { url: string; auth: string | null; body: unknown };

function world(runs: unknown[], gateway: () => Response = () => Response.json({ outcome: "answered", sent: true })) {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, auth: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === `${CONTROL}/agent-texts/mail-runs/due`) return Response.json({ runs });
      if (url === `${GATEWAY}/tex/mail-run`) return gateway();
      return new Response(null, { status: 500 });
    }),
  );
  return seen;
}

const entrypoint = () =>
  new TexRoutines({} as ExecutionContext, { AGENT_WORKER_SECRET: "control-plane-secret", CONTROL_PLANE_ORIGIN: CONTROL, GATEWAY_ORIGIN: GATEWAY } as unknown as Env);

const RUN = { runId: "texmail_1", accessToken: "cat_for_this_run", workspaceId: "ws_team_1", path: "areas/growth/mail/tex.md", mailboxId: "mb_0123456789abcdef" };

afterEach(() => vi.unstubAllGlobals());

describe("Tex in mail on the Worker", () => {
  it("claims the person's runs with the Worker's secret and runs each with its own session", async () => {
    const seen = world([RUN]);
    expect(await entrypoint().texMailDue({ owner: `person:${WORKSPACE}` })).toEqual({ ran: 1 });
    expect(seen[0]).toEqual({ url: `${CONTROL}/agent-texts/mail-runs/due`, auth: "Bearer control-plane-secret", body: { owner: WORKSPACE } });
    expect(seen[1]).toEqual({ url: `${GATEWAY}/tex/mail-run`, auth: `Bearer ${RUN.accessToken}`, body: { workspaceId: RUN.workspaceId, path: RUN.path, mailboxId: RUN.mailboxId } });
  });

  it("refuses an owner that is not a person's before asking anything", async () => {
    const seen = world([RUN]);
    for (const owner of ["chat:abc", "person:", `workspace:${WORKSPACE}`, 7]) {
      await expect(entrypoint().texMailDue({ owner } as never)).rejects.toThrow(TypeError);
    }
    expect(seen).toHaveLength(0);
  });

  it("skips a run the control plane sent malformed, and a failed run is not counted", async () => {
    const seen = world([{ ...RUN, mailboxId: "not-a-box" }, { ...RUN, runId: "texmail_2" }], () => new Response(null, { status: 503 }));
    expect(await entrypoint().texMailDue({ owner: `person:${WORKSPACE}` })).toEqual({ ran: 0 });
    expect(seen.filter((call) => call.url === `${GATEWAY}/tex/mail-run`)).toHaveLength(1);
  });
});
