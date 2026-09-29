import { describe, expect, test } from "@jest/globals";
import { auditActionLabel, type ConsoleAuditEvent } from "../features/console/advanced/advanced";
import { auditWhenLabel, groupAuditEvents } from "../features/console/advanced/auditGroups";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = 1_000 * HOUR;

let seq = 0;
function event(partial: Partial<ConsoleAuditEvent>): ConsoleAuditEvent {
  seq += 1;
  return {
    eventId: `e${seq}`,
    action: "agent.session.renewed",
    actorUserId: "u1",
    actorEmail: "sam@example.com",
    paths: [],
    at: NOW,
    ...partial,
  };
}

describe("folding back-to-back repeats in the audit trail", () => {
  test("a wall of identical renewals becomes one row that keeps the count and span", () => {
    const events = [2 * MINUTE, 3 * MINUTE, 8 * HOUR, 10 * HOUR].map((ago) =>
      event({ at: NOW - ago }),
    );
    const groups = groupAuditEvents(events);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(4);
    expect(groups[0]?.event).toBe(events[0]);
    expect(groups[0]?.firstAt).toBe(NOW - 10 * HOUR);
    expect(auditWhenLabel(groups[0]!, NOW)).toBe("4 times · 10 hours ago to 2 minutes ago");
  });

  test("a different row in between ends the run, so the trail never reorders", () => {
    const groups = groupAuditEvents([
      event({ at: NOW - 1 * MINUTE }),
      event({ action: "file.write", paths: ["notes/a.md"], at: NOW - 2 * MINUTE }),
      event({ at: NOW - 3 * MINUTE }),
    ]);
    expect(groups.map((g) => [g.event.action, g.count])).toEqual([
      ["agent.session.renewed", 1],
      ["file.write", 1],
      ["agent.session.renewed", 1],
    ]);
  });

  test("each differing fact keeps its own row: actor, client, path, or detail", () => {
    const base = { action: "file.write", paths: ["notes/a.md"] };
    const cases: Partial<ConsoleAuditEvent>[] = [
      { actorUserId: "u2", actorEmail: "kim@example.com" },
      { actorClientId: "Claude Desktop" },
      { paths: ["notes/b.md"] },
      { paths: ["notes/a.md", "notes/b.md"] },
    ];
    for (const other of cases) {
      expect(groupAuditEvents([event(base), event({ ...base, ...other })])).toHaveLength(2);
    }

    // Two plugin requests to different hosts are two facts, even though the
    // action, actor and (empty) paths all match.
    const net = (host: string) =>
      event({ action: "plugin.network", details: { pluginId: "p", host, method: "GET" } });
    expect(groupAuditEvents([net("a.example"), net("b.example")])).toHaveLength(2);
    expect(groupAuditEvents([net("a.example"), net("a.example")])).toHaveLength(1);
  });

  test("repeated edits of the same note fold too, not only renewals", () => {
    const edit = () => event({ action: "file.write", paths: ["notes/a.md"] });
    expect(groupAuditEvents([edit(), edit(), edit()])[0]?.count).toBe(3);
  });

  test("a single event reads exactly as before", () => {
    const [group] = groupAuditEvents([event({ at: NOW - 3 * MINUTE })]);
    expect(group?.count).toBe(1);
    expect(auditWhenLabel(group!, NOW)).toBe("3 minutes ago");
  });

  test("a run inside one time bucket names the bucket once", () => {
    const groups = groupAuditEvents([event({ at: NOW - 10 * HOUR }), event({ at: NOW - 10 * HOUR - MINUTE })]);
    expect(auditWhenLabel(groups[0]!, NOW)).toBe("2 times · 10 hours ago");
  });

  test("nothing in, nothing out", () => {
    expect(groupAuditEvents([])).toEqual([]);
  });
});

describe("naming the in-app agent's sign-ins", () => {
  test("renewals and first sign-ins read in words, not as raw action names", () => {
    expect(auditActionLabel("agent.session.renewed")).toBe("Renewed the in-app agent's sign-in");
    expect(auditActionLabel("agent.session.opened")).toBe("Signed in the in-app agent");
  });
});
