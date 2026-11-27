/**
 * THE AREA PANEL ASKS HOW ROUTINES RAN AT `POST /@slug/files/area-routines` (`areas/useAreaRoutineState.ts`).
 *
 * The console's own grant, the session's own workspace named in the body, as the data sync asks
 * (`data/dataSync.ts`). Anything but a served answer is no state: the rows are drawn without run lines.
 */

import { describe, expect, jest, test } from "@jest/globals";

jest.mock("../features/agent/useConsoleGrant", () => ({ useConsoleGrant: () => async () => ({ accessToken: "t" }) }));
jest.mock("convex/react", () => ({ useQuery: () => undefined, useMutation: () => async () => null, useAction: () => async () => null, useConvex: () => ({}) }));

import { areaRoutinesUrl, askAreaRoutines } from "../features/console/files/folderPage/areas/useAreaRoutineState";

const URL_ = "https://gateway.example/@acme/files/area-routines";

describe("the area routines call", () => {
  test("goes to the gateway that serves the endpoint, for a slug only", () => {
    expect(areaRoutinesUrl("https://gateway.example/mcp", "acme")).toBe(URL_);
    expect(areaRoutinesUrl("https://gateway.example/mcp", "../x")).toBeNull();
    expect(areaRoutinesUrl("not a url", "acme")).toBeNull();
    expect(areaRoutinesUrl("https://gateway.example/mcp", null)).toBeNull();
  });

  test("sends the workspace with the grant, re-mints once on a 401, and reads a served answer", async () => {
    const sent: { auth: string; body: string }[] = [];
    let calls = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent.push({ auth: (init.headers as Record<string, string>).authorization!, body: String(init.body) });
      calls += 1;
      const status = calls === 1 ? 401 : 200;
      const body = calls === 1 ? {} : { served: true, week: "2026-11-23", routines: [{ path: "areas/a/routines/daily/x.md", area: "areas/a", nextAt: 2, lastAt: 1, outcome: "sent", bot: "b", answeredAt: null }], usage: [{ bot: "b", area: "areas/a", used: 3 }] };
      return { status, json: async () => body };
    }) as unknown as typeof fetch;
    const tokens = ["old", "new"];
    const state = await askAreaRoutines({ url: URL_, workspaceId: "ws1", token: async () => tokens.shift()!, fetchImpl });
    expect(sent).toEqual([
      { auth: "Bearer old", body: '{"workspaceId":"ws1"}' },
      { auth: "Bearer new", body: '{"workspaceId":"ws1"}' },
    ]);
    expect(state).toMatchObject({ week: "2026-11-23", usage: [{ bot: "b", area: "areas/a", used: 3 }] });
  });

  test("not served, refused or unreachable is no state", async () => {
    const answer = (status: number, body: unknown) => (async () => ({ status, json: async () => body })) as unknown as typeof fetch;
    const ask = (fetchImpl: typeof fetch) => askAreaRoutines({ url: URL_, workspaceId: "ws1", token: async () => "t", fetchImpl });
    expect(await ask(answer(200, { served: false }))).toBeNull();
    expect(await ask(answer(403, { message: "no" }))).toBeNull();
    const offline = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await ask(offline)).toBeNull();
  });
});
