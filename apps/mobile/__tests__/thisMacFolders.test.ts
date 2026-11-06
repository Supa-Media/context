/**
 * This Mac's folders, read and saved by the page with its own console grant
 * (`features/tex/page/thisMacFolders.ts`). v0.1.72 saved them from the Mac app
 * with the Mac's own connection, which the gateway refuses for every client but
 * the console, so a pick was lost (Dev2, 2026-11-04).
 *
 * ## Sabotage record
 *
 *  1. `set` posted without the workspace the Mac was found in. → `saves in the workspace that lists this Mac` fails.
 *  2. The bearer taken from anything but the page's own grant. → `every call carries the page's own grant` fails.
 */

import { describe, expect, test } from "@jest/globals";
import { gatewayFolderStore } from "../features/tex/page/thisMacFolders";

type Call = { url: string; auth: string; body: Record<string, unknown> };

function gateway(machinesBy: Record<string, { id: string; folders?: unknown }[]>, refuse = false) {
  const calls: Call[] = [];
  const fetchFake = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url, auth: init.headers.authorization, body });
    if (refuse) return { ok: false, status: 403, json: async () => ({ error: "forbidden" }) };
    const ws = body.workspaceId as string;
    if (url.endsWith("/machines/app/list")) return { ok: true, json: async () => ({ ok: true, machines: machinesBy[ws] ?? [] }) };
    const patch = body.patch as { folders: string[] };
    return { ok: true, json: async () => ({ ok: true, machine: { id: body.machineId, folders: patch.folders } }) };
  }) as unknown as typeof fetch;
  return { calls, fetchFake };
}

const options = (fetchFake: typeof fetch) => ({
  endpoint: "https://context.example/mcp",
  workspaceIds: ["ws_me", "ws_team"],
  token: async (workspaceId: string) => `console-${workspaceId}`,
  fetch: fetchFake,
});

describe("this Mac's folders, on the page's own grant", () => {
  test("reads this Mac's folders from the workspace that lists it", async () => {
    const { fetchFake } = gateway({ ws_team: [{ id: "mch_1", folders: ["/Users/a/Code", "relative"] }] });
    expect(await gatewayFolderStore(options(fetchFake)).read("mch_1")).toEqual(["/Users/a/Code"]);
  });

  test("saves in the workspace that lists this Mac, and answers what the gateway kept", async () => {
    const { calls, fetchFake } = gateway({ ws_team: [{ id: "mch_1", folders: [] }] });
    const saved = await gatewayFolderStore(options(fetchFake)).save("mch_1", ["/Users/a/Code/app"]);
    expect(saved).toEqual(["/Users/a/Code/app"]);
    const set = calls.find((c) => c.url.endsWith("/machines/app/set"))!;
    expect(set.body).toEqual({ machineId: "mch_1", patch: { folders: ["/Users/a/Code/app"] }, workspaceId: "ws_team" });
  });

  test("every call carries the page's own grant for that workspace", async () => {
    const { calls, fetchFake } = gateway({ ws_team: [{ id: "mch_1", folders: [] }] });
    await gatewayFolderStore(options(fetchFake)).save("mch_1", ["/x"]);
    expect(calls.map((c) => c.body.workspaceId)).toEqual(["ws_me", "ws_team", "ws_team"]);
    expect(calls.every((c) => c.auth === `Bearer console-${c.body.workspaceId}`)).toBe(true);
  });

  test("a Mac no workspace lists, or a refusal, reads as null, never an empty list", async () => {
    expect(await gatewayFolderStore(options(gateway({}).fetchFake)).read("mch_1")).toBeNull();
    const refused = gatewayFolderStore(options(gateway({ ws_me: [{ id: "mch_1" }] }, true).fetchFake));
    expect(await refused.read("mch_1")).toBeNull();
    expect(await refused.save("mch_1", ["/x"])).toBeNull();
  });
});
