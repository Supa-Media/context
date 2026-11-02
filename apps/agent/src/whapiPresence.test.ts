/**
 * The WhatsApp group-typing experiment (Dev2, 2026-11-01;
 * docs/decisions/texting-assistant/whapi-presence-probe.md): Tex asks Whapi for
 * a group's presences once a day, and a presences delivery is only described in
 * the logs (keys, status, whether its id names a group), never acted on.
 *
 * Sabotage: logging `contact_id` itself fails "never logs an id"; dropping the
 * day check fails "once a day".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Fetch } from "./clients";
import { MemoryStorage } from "./memoryStorage.testing";
import { watchGroupPresenceDaily, whapiGroupId } from "./whapi";
import { parseWhapiWebhook } from "./whapiInbound";

const LINE = "+15555550199";
const KEYS = { token: "tok-123", line: LINE };
const GROUP = "120363000000000000@g.us";
/** The group id this Worker files a WhatsApp group under (`whapiGroupId`). */
const CHAT = whapiGroupId(GROUP);
const DAY = Date.UTC(2026, 10, 1, 12);

afterEach(() => vi.restoreAllMocks());

function shapes(payload: unknown) {
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  const events = parseWhapiWebhook(payload, LINE);
  const lines = logs.mock.calls.flat().map((line) => JSON.parse(String(line))).filter((line) => line.event === "whapi_presence_shape");
  return { events, lines, raw: logs.mock.calls.flat().join(" ") };
}

describe("a presences delivery", () => {
  it("is described, not acted on, and never logs an id", () => {
    const { events, lines, raw } = shapes({
      presences: [
        { contact_id: "15555550111", status: "typing" },
        { contact_id: GROUP, status: "recording" },
        { contact_id: "15555550112@lid", status: "online" },
      ],
      event: { type: "presences", event: "post" },
      channel_id: "CHANNEL-1",
    });
    expect(events).toEqual([]);
    expect(lines).toEqual([
      { event: "whapi_presence_shape", keys: "channel_id:contact_id:event:status", status: "typing", idKind: "person" },
      { event: "whapi_presence_shape", keys: "channel_id:contact_id:event:status", status: "recording", idKind: "group" },
      { event: "whapi_presence_shape", keys: "channel_id:contact_id:event:status", status: "online", idKind: "other" },
    ]);
    expect(raw).not.toMatch(/15555550111|120363000000000000|15555550112|CHANNEL-1/);
  });

  it("an odd status is written as other", () => {
    const { lines } = shapes({ presences: [{ contact_id: "15555550111", status: "Typing!!" }] });
    expect(lines[0]).toMatchObject({ status: "other" });
  });
});

describe("watching a group's presences", () => {
  function fetcher(status: number | Error) {
    const calls: { url: string; method: string }[] = [];
    const fn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET" });
      if (status instanceof Error) throw status;
      return new Response("{}", { status });
    }) as unknown as Fetch;
    return { fn, calls };
  }

  it("asks once a day, and 409 counts as watching", async () => {
    const storage = new MemoryStorage();
    const conflict = fetcher(409);
    await watchGroupPresenceDaily(storage, conflict.fn, KEYS, CHAT, DAY);
    await watchGroupPresenceDaily(storage, conflict.fn, KEYS, CHAT, DAY + 60_000);
    expect(conflict.calls).toHaveLength(1);
    expect(conflict.calls[0]).toMatchObject({ method: "POST" });
    expect(conflict.calls[0]!.url).toContain(`/presences/${encodeURIComponent(GROUP)}`);
    await watchGroupPresenceDaily(storage, conflict.fn, KEYS, CHAT, DAY + 24 * 3_600_000);
    expect(conflict.calls).toHaveLength(2);
  });

  it("a refusal or a network error never throws, and is tried again next message", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new MemoryStorage();
    const broken = fetcher(new Error("network"));
    await expect(watchGroupPresenceDaily(storage, broken.fn, KEYS, CHAT, DAY)).resolves.toBeUndefined();
    const refused = fetcher(402);
    await watchGroupPresenceDaily(storage, refused.fn, KEYS, CHAT, DAY);
    expect(refused.calls).toHaveLength(1);
  });

  it("a Sendblue group is never watched", async () => {
    const storage = new MemoryStorage();
    const any = fetcher(200);
    await watchGroupPresenceDaily(storage, any.fn, KEYS, "8F2C3D1A-A5B7-4E9F-8C1D-2A3B4C5D6E7F", DAY);
    expect(any.calls).toEqual([]);
  });
});
