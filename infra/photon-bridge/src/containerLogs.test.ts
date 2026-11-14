import { describe, expect, it } from "vitest";
import { forwardContainerLogs } from "./containerLogs";

/** A container port that answers /logs from a numbered list and /health with a fixed body. */
function container(boot: string, records: { id: number; event: string }[], health: unknown = { ok: true, started: true, queued: 0, lines: [{ line: "0123", frontier: 7 }] }) {
  const asked: string[] = [];
  return {
    asked,
    fetch: async (input: string | Request) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      asked.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/health") return Response.json(health);
      const after = Number(url.searchParams.get("after"));
      const last = records.at(-1)?.id ?? 0;
      return Response.json({ boot, next: last, records: records.filter((record) => record.id > after) });
    },
  };
}

describe("forwardContainerLogs", () => {
  it("logs each record since the cursor as the container's, then one health line", async () => {
    const logged: Record<string, unknown>[] = [];
    const port = container("b1", [{ id: 1, event: "line.start" }, { id: 2, event: "line.stream_failed" }, { id: 3, event: "line.reconnect" }]);
    const next = await forwardContainerLogs(port, { boot: "b1", next: 1 }, (record) => logged.push(record));
    expect(logged.map((record) => record.event)).toEqual(["line.stream_failed", "line.reconnect", "bridge.health"]);
    expect(logged[0]).toMatchObject({ from: "container", id: 2 });
    expect(logged[2]).toMatchObject({ ok: true, started: true, queued: 0, lines: [{ line: "0123", frontier: 7 }] });
    expect(next).toEqual({ boot: "b1", next: 3 });
  });

  it("reads a restarted container from its first record, whatever the old cursor said", async () => {
    const logged: Record<string, unknown>[] = [];
    const port = container("b2", [{ id: 1, event: "container.listening" }, { id: 2, event: "line.start" }]);
    const next = await forwardContainerLogs(port, { boot: "b1", next: 40 }, (record) => logged.push(record));
    expect(logged.filter((record) => record.from === "container").map((record) => record.event)).toEqual(["container.listening", "line.start"]);
    expect(port.asked).toContain("/logs?after=0");
    expect(next).toEqual({ boot: "b2", next: 2 });
  });

  it("logs a failed read and keeps the cursor, and still logs health", async () => {
    const logged: Record<string, unknown>[] = [];
    const port = {
      fetch: async (input: string | Request) => {
        const path = new URL(typeof input === "string" ? input : input.url).pathname;
        if (path === "/health") throw new TypeError("gone");
        return new Response(null, { status: 500 });
      },
    };
    const next = await forwardContainerLogs(port, { boot: "b1", next: 5 }, (record) => logged.push(record));
    expect(next).toEqual({ boot: "b1", next: 5 });
    expect(logged).toEqual([
      { event: "bridge.logs_failed", status: 500 },
      { event: "bridge.health", ok: false, error: "TypeError" },
    ]);
  });
});
