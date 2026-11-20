/**
 * `inboxFetch` (`chatCalls.ts`): the gateway's call on one of this Worker's objects.
 *
 * The line names the object's id and the path, and how long the fetch took. It does
 * not name the inbox: the placed name can be a phone number. A fetch that throws is
 * still timed, and the error is the fetch's own.
 */
import { describe, expect, it, vi } from "vitest";
import { inboxFetch } from "./chatCalls";

const PHONE = "enam:+15555550100";

function namespace(fetchImpl: (request: Request) => Promise<Response> | Response, id = "abc123def") {
  return {
    idFromName: () => ({ toString: () => id }),
    get: () => ({ fetch: fetchImpl }),
  } as unknown as DurableObjectNamespace;
}

function logged(run: () => Promise<void>): Promise<Record<string, unknown>[]> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  return run().finally(() => spy.mockRestore()).then(() => lines.map((line) => JSON.parse(line) as Record<string, unknown>));
}

describe("inboxFetch", () => {
  it("logs the object id, the path and the elapsed time, and not the phone", async () => {
    const lines = await logged(async () => {
      const response = await inboxFetch(namespace(() => Response.json({ ok: true })), { name: PHONE }, new Request("https://inbox/job-update?origin=https://secret.example", { method: "POST", body: "{}" }));
      expect(response.status).toBe(200);
    });
    const line = lines.find((entry) => entry.event === "inbox_fetch");
    expect(line).toMatchObject({ event: "inbox_fetch", id: "abc123def", path: "/job-update", outcome: "http_200" });
    expect(typeof line?.ms).toBe("number");
    expect(JSON.stringify(line)).not.toContain("+15555550100");
    expect(JSON.stringify(line)).not.toContain("secret.example");
  });

  it("a fetch that never answers is still logged when it throws, and the throw is unchanged", async () => {
    const lines = await logged(async () => {
      await expect(inboxFetch(namespace(() => { throw new Error("inbox hung"); }, "+15555550100"), { name: PHONE }, new Request("https://inbox/accept", { method: "POST", body: "{}" }))).rejects.toThrow("inbox hung");
    });
    const line = lines.find((entry) => entry.event === "inbox_fetch");
    expect(line).toMatchObject({ event: "inbox_fetch", id: "opaque", path: "/accept", outcome: "threw" });
    expect(JSON.stringify(line)).not.toContain("+15555550100");
    expect(JSON.stringify(line)).not.toContain("inbox hung");
  });
});
