import { describe, expect, it } from "vitest";
import { forwardContainerLogs } from "./containerLogs";

/** A container port that answers /logs from a numbered list and /health with a fixed body. */
const NOW = 1_700_000_000_000;

function container(boot: string, records: { id: number; event: string }[], health: unknown = { ok: true, started: true, queued: 0, lines: [{ line: "0123", frontier: 7 }], startedAt: NOW, lastReadAt: NOW }) {
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
    const forwarded = await forwardContainerLogs(port, { boot: "b1", next: 1 }, (record) => logged.push(record), () => NOW);
    expect(logged.map((record) => record.event)).toEqual(["line.stream_failed", "line.reconnect", "bridge.health"]);
    expect(logged[0]).toMatchObject({ from: "container", id: 2 });
    expect(logged[2]).toMatchObject({ ok: true, read: "fresh", read_age_ms: 0, last_read_at: NOW, started: true, queued: 0, lines: [{ line: "0123", frontier: 7 }] });
    expect(forwarded.cursor).toEqual({ boot: "b1", next: 3 });
    expect(forwarded.health).toEqual({ ok: true, read: "fresh", readAgeMs: 0, started: true });
  });

  it("reads a restarted container from its first record, whatever the old cursor said", async () => {
    const logged: Record<string, unknown>[] = [];
    const port = container("b2", [{ id: 1, event: "container.listening" }, { id: 2, event: "line.start" }]);
    const forwarded = await forwardContainerLogs(port, { boot: "b1", next: 40 }, (record) => logged.push(record), () => NOW);
    expect(logged.filter((record) => record.from === "container").map((record) => record.event)).toEqual(["container.listening", "line.start"]);
    expect(port.asked).toContain("/logs?after=0");
    expect(forwarded.cursor).toEqual({ boot: "b2", next: 2 });
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
    const forwarded = await forwardContainerLogs(port, { boot: "b1", next: 5 }, (record) => logged.push(record));
    expect(forwarded).toEqual({ cursor: { boot: "b1", next: 5 }, health: null });
    expect(logged).toEqual([
      { event: "bridge.logs_failed", status: 500 },
      { event: "bridge.health", ok: false, error: "TypeError" },
    ]);
  });

  it("does not call the bridge ok when the last Photon read is past two poll intervals", async () => {
    const logged: Record<string, unknown>[] = [];
    const staleAt = NOW - 121_000;
    const port = container("b1", [], { started: true, queued: 0, lines: [], startedAt: staleAt, lastReadAt: staleAt });
    const degraded = await forwardContainerLogs(port, { boot: "b1", next: 0 }, (record) => logged.push(record), () => NOW);
    expect(degraded.health).toMatchObject({ ok: false, read: "degraded", readAgeMs: 121_000, started: true });
    expect(logged.at(-1)).toMatchObject({ event: "bridge.health", ok: false, read: "degraded", read_age_ms: 121_000 });

    logged.length = 0;
    const older = NOW - 180_000;
    const portStale = container("b1", [], { started: true, queued: 0, lines: [], startedAt: older, lastReadAt: older });
    const stale = await forwardContainerLogs(portStale, { boot: "b1", next: 0 }, (record) => logged.push(record), () => NOW);
    expect(stale.health).toMatchObject({ ok: false, read: "stale", readAgeMs: 180_000 });
  });
});
