/**
 * AN EDIT MADE IN THE APP IS DRAWN AS THE PERSON WHO MADE IT.
 *
 * The app's console is an OAuth client of its own (`Context (this app)`), so
 * every write it makes is recorded under that client name. Without the
 * conversion below, the replay and the live map would draw a person's own
 * edits as a robot named "@dev2's Context (this app)". Owner, 2026-10-09: a
 * tool is a robot; a person's hand is their face.
 *
 * The server records nothing differently. These tests pin the client side:
 * the same history line from a tool is still a tool.
 *
 * ## Sabotage record
 *
 *   historyActor ignores the console's client name           "app edit is the person" fails
 *   eventsFromStoredReads forces kind "agent" on every read  "a console read is a person" fails
 *   actorsFromActivity keeps a console client as an agent    "live console actor is a person" fails
 */
import { describe, expect, test } from "@jest/globals";
import type { AgentActivityView } from "../features/console/agents/agentActivity";
import { actorsFromActivity, eventsFromHistory, historyActor, type HistoryEntry } from "../features/console/map/live/convert";
import { eventsFromStoredReads } from "../features/console/map/live/storedReads";
import { CONSOLE_CLIENT_NAME } from "../features/console/map/live/agentKind";

const at = "2026-10-08T10:00:00.000Z";
const line = (over: Partial<HistoryEntry>): HistoryEntry => ({ at, kind: "revised", paths: ["1-projects/pricing.md"], by: "@dev2", via: null, ...over });

describe("a history line from the app is the person", () => {
  test("an edit the console made is the person's, by name", () => {
    expect(historyActor({ by: "@dev2", via: CONSOLE_CLIENT_NAME })).toEqual({ id: "h:@dev2", kind: "person", name: "@dev2" });
  });

  test("an unnamed console edit is someone, not a tool", () => {
    expect(historyActor({ by: null, via: CONSOLE_CLIENT_NAME })).toEqual({ id: "h:someone", kind: "person", name: "Someone" });
  });

  test("the replay draws every kind of app edit as the person", () => {
    const events = eventsFromHistory(
      [
        line({ kind: "revised", via: CONSOLE_CLIENT_NAME }),
        line({ kind: "added", paths: ["0-inbox/new.md"], via: CONSOLE_CLIENT_NAME }),
        line({ kind: "moved", paths: ["2-areas/a.md"], moves: [["0-inbox/a.md", "2-areas/a.md"]], via: CONSOLE_CLIENT_NAME }),
      ],
      "ws-p",
    );
    expect(events).toHaveLength(3);
    for (const e of events) expect(e.actor).toEqual({ id: "h:@dev2", kind: "person", name: "@dev2" });
  });

  test("a tool's line by the same person is still the tool's, named the way the feed names it", () => {
    expect(historyActor({ by: "@dev2", via: "Claude" })).toEqual({ id: "h:@dev2:Claude", kind: "agent", name: "@dev2's Claude" });
    expect(historyActor({ by: "@dev2", via: "Texts (iMessage)" }).kind).toBe("agent");
  });
});

describe("a live actor from the app is the person", () => {
  test("the console's client in the live view is drawn as the person, not a tool", () => {
    const view = {
      agents: [
        {
          id: "a:console",
          name: `@dev2's ${CONSOLE_CLIENT_NAME}`,
          color: null,
          at: 1_000,
          kind: "write",
          path: "1-projects/pricing.md",
          reads: 0,
          writes: 1,
          doing: "edit",
        },
      ],
      marks: [],
    } as unknown as AgentActivityView;
    const [actor] = actorsFromActivity(view, "ws-p", 2_000);
    expect(actor).toMatchObject({ kind: "person", name: "@dev2" });
  });

  test("a tool in the live view is still an agent, with its owner's name", () => {
    const view = {
      agents: [{ id: "a:claude", name: "@dev2's Claude", color: null, at: 1_000, kind: "read", path: "index.md", reads: 1, writes: 0, doing: "read" }],
      marks: [],
    } as unknown as AgentActivityView;
    expect(actorsFromActivity(view, "ws-p", 2_000)[0]).toMatchObject({ kind: "agent", name: "@dev2's Claude" });
  });
});

describe("stored reads", () => {
  test("a tool's stored read is an agent's read", () => {
    const [e] = eventsFromStoredReads(
      [{ at: 1_000, path: "index.md", tool: "read_note", by: "@dev2", via: "Claude" }],
      "ws-p",
    );
    expect(e!.actor).toEqual({ id: "h:@dev2:Claude", kind: "agent", name: "@dev2's Claude" });
  });

  test("a read the console made is a person's, never a robot's", () => {
    const [e] = eventsFromStoredReads(
      [{ at: 1_000, path: "index.md", tool: "read_note", by: "@dev2", via: CONSOLE_CLIENT_NAME }],
      "ws-p",
    );
    expect(e!.actor).toEqual({ id: "h:@dev2", kind: "person", name: "@dev2" });
  });
});
