/**
 * AN AGENT OWNER IS A WORD THE WORKSPACE CHOSE, OPTIONALLY SOMEBODY'S.
 *
 * Asked for by the owner (2026-09-28) after the picker offered "Context Sentry
 * incident inbox" as an agent: the agents are a short written list, Claude
 * and Codex to start, that anybody who can edit adds to by typing a name, and
 * an owner line may say whose one it is (`@shay's Claude`) or not.
 *
 * What has teeth: the list is read from the nearest front note that declares
 * it and otherwise the defaults; a new name lands in the projects folder's
 * front note so every project under it offers it; a name that would break the
 * one-line list or an owner line is refused; and an owner line is read back as
 * the agent and whose, whatever its case.
 */

import { describe, expect, test } from "@jest/globals";
import { agentName, agentOwner, agentShown, knownAgent, ownerNote, parseAgentOwner } from "../features/console/files/agentOwners";
import { DEFAULT_AGENTS, agentsHome, folderAgents, withAgent } from "../features/console/files/folderPage/agents";
import { matchingAgents } from "../features/console/files/folderPage/useAgents";
import { ownerRows, whoseRows, type OwnerResults } from "../features/console/files/owners";
import type { ListNote } from "../features/console/files/listBlock/model";

const note = (path: string, properties: ListNote["properties"] = {}): ListNote => ({ path, updatedAt: 1, properties });

describe("the list", () => {
  test("is Claude and Codex until a front note says otherwise", () => {
    expect(folderAgents("1-projects/web", [])).toEqual({ list: DEFAULT_AGENTS, note: null });
    expect(DEFAULT_AGENTS).toEqual(["Claude", "Codex"]);
  });

  test("comes from the nearest front note above that declares one, as a line or a list", () => {
    const notes = [
      note("1-projects/overview.md", { agents: "Claude, Codex, Cursor, cursor" }),
      note("1-projects/web/overview.md", { status: "active" }),
      note("2-areas/README.md", { agents: ["Devin"] }),
    ];
    expect(folderAgents("1-projects/web", notes)).toEqual({ list: ["Claude", "Codex", "Cursor"], note: "1-projects/overview.md" });
    expect(folderAgents("2-areas", notes)).toEqual({ list: ["Devin"], note: "2-areas/README.md" });
  });

  test("a new name goes to the projects folder's front note, made if missing", () => {
    expect(agentsHome("1-projects/web", [])).toEqual({ target: "1-projects/overview.md", creates: true });
    expect(agentsHome("1-projects/web", [note("1-projects/index.md")])).toEqual({ target: "1-projects/index.md", creates: false });
    expect(agentsHome("notes/ideas", [])).toEqual({ target: "notes/ideas/overview.md", creates: true });
    expect(agentsHome("", [])).toBeNull();
  });

  test("adding a name it already holds, in any case, changes nothing", () => {
    expect(withAgent(["Claude", "Codex"], "cursor")).toEqual(["Claude", "Codex", "cursor"]);
    expect(withAgent(["Claude", "Codex"], "CLAUDE")).toEqual(["Claude", "Codex"]);
    expect(knownAgent(["Claude"], " claude ")).toBe("Claude");
  });

  test("a name that would break the list or an owner line is refused", () => {
    expect(agentName("  Cursor  ")).toEqual({ name: "Cursor" });
    for (const bad of ["", "   ", "a, b", "x: y", "#tag", "[x]", "@shay", "Shay's Claude", "x".repeat(41)]) {
      expect("problem" in agentName(bad)).toBe(true);
    }
  });

  test("the search finds agents by any part of the name", () => {
    expect(matchingAgents(["Claude", "Codex", "Cursor"], "c")).toEqual(["Claude", "Codex", "Cursor"]);
    expect(matchingAgents(["Claude", "Codex", "Cursor"], "ur")).toEqual(["Cursor"]);
    expect(matchingAgents(["Claude", "Codex"], "")).toEqual(["Claude", "Codex"]);
  });
});

describe("an owner line", () => {
  test("says the agent, and whose when somebody's", () => {
    expect(agentOwner("Claude", null)).toBe("Claude");
    expect(agentOwner("Claude", "@shay")).toBe("@shay's Claude");
  });

  test("is read back as the agent and whose", () => {
    const list = ["Claude", "Codex"];
    expect(parseAgentOwner("claude", list)).toEqual({ agent: "Claude", whose: null, note: null });
    expect(parseAgentOwner("@shay's Claude", list)).toEqual({ agent: "Claude", whose: "@shay", note: null });
    expect(parseAgentOwner("@illuminate's codex", list)).toEqual({ agent: "Codex", whose: "@illuminate", note: null });
    expect(parseAgentOwner("'s Claude", list)).toBeNull();
    expect(parseAgentOwner("Cursor", list)).toBeNull();
    expect(parseAgentOwner("@seyi", list)).toBeNull();
  });

  test("keeps the thread an agent noted after it, and is shown without it", () => {
    const list = ["Claude", "Codex"];
    expect(parseAgentOwner("Claude (faster CI/CD project thread)", list)).toEqual({
      agent: "Claude",
      whose: null,
      note: "faster CI/CD project thread",
    });
    expect(parseAgentOwner("Seyi's Codex (release)", list)).toEqual({ agent: "Codex", whose: "Seyi", note: "release" });
    expect(agentShown("Claude (faster CI/CD project thread)", list)).toBe("Claude");
    expect(agentShown("Claude", list)).toBeNull();
    // A person's bracket is theirs to write; only an agent's note is hidden.
    expect(agentShown("Jon (contractor)", list)).toBeNull();
    expect(ownerNote("Claude ()")).toEqual({ name: "Claude ()", note: null });
    expect(ownerNote("Claude (a) b")).toEqual({ name: "Claude (a) b", note: null });
  });
});

describe("the picker's rows", () => {
  const results: OwnerResults = {
    people: [
      { value: "@seyi", isMe: true },
      { value: "@shay", isMe: false },
    ],
    agents: ["Claude", "Codex"],
    truncated: false,
  };
  const choices = (rows: ReturnType<typeof ownerRows>) => rows.filter((row) => row.kind === "choice");

  test("an agent row is checked for its somebody's owner, and says whose", () => {
    const claude = choices(ownerRows("", "@shay's Claude", results)).find((row) => row.label === "Claude");
    expect(claude).toMatchObject({ checked: true, detail: "@shay's", agent: "Claude" });
    expect(choices(ownerRows("", "@shay's Claude", results)).some((row) => row.detail === "Not a member")).toBe(false);
  });

  test("offers to add a typed name only to somebody who may, and never one it has", () => {
    const add = (query: string, canAdd: boolean) => ownerRows(query, "", results, null, { canAdd }).filter((row) => row.kind === "add");
    expect(add("Cursor", true)).toEqual([{ kind: "add", name: "Cursor", label: "Add “Cursor” as an agent" }]);
    expect(add("Cursor", false)).toEqual([]);
    expect(add("claude", true)).toEqual([]);
    expect(add("a, b", true)).toEqual([]);
    expect(add("", true)).toEqual([]);
  });

  test("whose: the agent alone first, then each person's, the current one checked", () => {
    expect(whoseRows("Claude", "@shay's Claude", results)).toEqual([
      { kind: "choice", value: "Claude", label: "Just Claude", detail: "anyone’s", checked: false },
      { kind: "choice", value: "@seyi's Claude", label: "@seyi's Claude", detail: "you", checked: false },
      { kind: "choice", value: "@shay's Claude", label: "@shay's Claude", checked: true },
    ]);
  });
});
