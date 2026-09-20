/**
 * Seventeen rows, eight of them called Claude.
 *
 * Every machine, browser profile and re-auth mints its own grant, so the
 * Connected list on a real workspace was seventeen rows each saying "Claude ·
 * @seyi · team access · read & write · last used 17 hours ago" with a Revoke
 * beside it. The count is the useful fact at rest; the individual grants
 * matter only when somebody is cutting one off.
 *
 * What this pins is the two ways a group could quietly mislead: by hiding that
 * an app reaches more than one context, and by reporting the health of its
 * healthiest grant.
 */

import { describe, expect, test } from "@jest/globals";
import { connectionCount, groupClients } from "../features/console/clients/grouped";
import type { ConsoleClient } from "../features/console/types";

function client(overrides: Partial<ConsoleClient> = {}): ConsoleClient {
  return {
    id: "grant_1",
    name: "Claude",
    context: "@seyi",
    detail: "last used 5 minutes ago",
    mine: true,
    status: "ok",
    ...overrides,
  };
}

describe("grouping", () => {
  test("one row per app, however many grants it holds", () => {
    const groups = groupClients([
      client({ id: "a" }),
      client({ id: "b" }),
      client({ id: "c", name: "ChatGPT" }),
    ]);
    expect(groups.map((group) => group.name)).toEqual(["Claude", "ChatGPT"]);
    expect(groups[0]!.clients).toHaveLength(2);
  });

  test("the app somebody used most recently stays first, rather than the biggest pile", () => {
    const groups = groupClients([
      client({ id: "a", name: "ChatGPT" }),
      client({ id: "b" }),
      client({ id: "c" }),
      client({ id: "d" }),
    ]);
    expect(groups[0]!.name).toBe("ChatGPT");
  });

  test("the count is in the group's own words", () => {
    expect(connectionCount(groupClients([client()])[0]!)).toBe("1 connection");
    expect(connectionCount(groupClients([client({ id: "a" }), client({ id: "b" })])[0]!)).toBe(
      "2 connections",
    );
  });

  test("a group names every context it reaches, because revoking it is ambiguous otherwise", () => {
    const [group] = groupClients([client({ id: "a" }), client({ id: "b", context: "@supa" })]);
    expect(group!.contexts).toBe("@seyi and @supa");
  });

  test("...and a group in one context names just that one", () => {
    expect(groupClients([client()])[0]!.contexts).toBe("@seyi");
  });

  test("a grant that is somebody else's marks the whole group, so Revoke is never a surprise", () => {
    const [group] = groupClients([client({ id: "a" }), client({ id: "b", mine: false })]);
    expect(group!.hasOthers).toBe(true);
  });

  test("...and a group that is all yours says so", () => {
    expect(groupClients([client(), client({ id: "b" })])[0]!.hasOthers).toBe(false);
  });
});

describe("a group is only as healthy as its unhealthiest grant", () => {
  test("one never-used grant among healthy ones shows as needing attention", () => {
    const [group] = groupClients([client({ id: "a" }), client({ id: "b", status: "warn" })]);
    expect(group!.status).toBe("warn");
  });

  test("...and a critical one outranks a warning", () => {
    const [group] = groupClients([
      client({ id: "a", status: "warn" }),
      client({ id: "b", status: "crit" }),
    ]);
    expect(group!.status).toBe("crit");
  });

  test("all healthy is healthy", () => {
    expect(groupClients([client(), client({ id: "b" })])[0]!.status).toBe("ok");
  });

  test("the detail is the most recent grant's, which is the one that answers 'is this in use'", () => {
    const [group] = groupClients([
      client({ id: "a", detail: "last used 5 minutes ago" }),
      client({ id: "b", detail: "last used 3 days ago" }),
    ]);
    expect(group!.detail).toBe("last used 5 minutes ago");
  });
});

describe("nothing is lost on the way in", () => {
  test("every grant handed in is in exactly one group", () => {
    const clients = [
      client({ id: "a" }),
      client({ id: "b", name: "ChatGPT" }),
      client({ id: "c" }),
      client({ id: "d", name: "Codex" }),
    ];
    const grouped = groupClients(clients).flatMap((group) => group.clients);
    expect(grouped).toHaveLength(clients.length);
    expect(new Set(grouped.map((one) => one.id)).size).toBe(clients.length);
  });

  test("an empty list is no groups rather than one empty group", () => {
    expect(groupClients([])).toEqual([]);
  });
});
