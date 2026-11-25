/**
 * Group commands and after-turn lines, with node `did` wired (Dev2, 2026-11-25: "Tex's code never writes what Tex
 * says"; docs/decisions/texting-assistant/no-scripted-wording.md). The command still runs in code; then the chat's own
 * turn gets the facts, and Tex's words go, never the fixed line. A muted chat runs no model, so "Tex, stop" keeps its line.
 *
 * Sabotage (temporary local edits, reverted): `told` in `answerGroup` sending the fallback always fails four of these.
 * "A did turn never starts another" holds twice over: a routine turn runs no invite, and `tellTex` refuses a did turn.
 */

import { describe, expect, it } from "vitest";
import { TEX_CONFIG } from "../../../packages/tex/src/texConfig.cjs";
import { acceptGroup, drainGroup, GROUP_LINES } from "./groupInbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { LINES, setup } from "./groupWorld.testing";

const { groupId } = LINES[0];
const withDid = { ...TEX_CONFIG, nodes: [...(TEX_CONFIG as { nodes: unknown[] }).nodes, { id: "did", on: true }] };
const isDid = (body: Record<string, unknown>) => body.event === "did";
const commandOf = (body: Record<string, unknown>) => (body.command as { kind?: string } | undefined)?.kind;

function world(control: (kind: string | undefined) => Record<string, unknown> | undefined, agent?: (body: Record<string, unknown>) => unknown) {
  const w = setup(groupId, {
    controlFor: (body) => control(commandOf(body)),
    agent: agent ?? ((body) => (isDid(body) ? { answer: `told ${JSON.stringify(body.did)}` } : { answer: "an answer" })),
  });
  w.deps.texGraph = withDid;
  return w;
}

describe("a group command's result is Tex's to say, from the facts", () => {
  it('"Tex, start" is told as facts', async () => {
    const storage = new MemoryStorage();
    const w = world((kind) => (kind === "start" ? { status: "started" } : undefined));
    await acceptGroup(storage, w.message("Tex, start"), 0);
    await drainGroup(storage, w.deps);
    expect(w.asks.filter(isDid).map((body) => body.did)).toEqual([{ action: "unmute", status: "started" }]);
    expect(w.texts).toEqual([`told ${JSON.stringify({ action: "unmute", status: "started" })}`]);
    expect(w.texts).not.toContain(GROUP_LINES.started);
  });

  it('"Tex, add everyone here to @studio" said as a command is told as facts', async () => {
    const storage = new MemoryStorage();
    const w = world((kind) => (kind === "invite" ? { status: "invited", slug: "studio", count: 2, role: "editor" } : undefined));
    await acceptGroup(storage, w.message("Tex add everyone here to @studio"), 0);
    await drainGroup(storage, w.deps);
    expect(w.asks.filter(isDid).map((body) => body.did)).toEqual([{ action: "invite", status: "invited", workspace: "@studio", people: 2, role: "editor" }]);
    expect(w.texts).not.toContain(GROUP_LINES.invited("studio", 2, "editor"));
  });

  it('"what can you see" is told as facts', async () => {
    const storage = new MemoryStorage();
    const w = world(() => undefined);
    await acceptGroup(storage, w.message("Tex what can you see here"), 0);
    await drainGroup(storage, w.deps);
    const facts = w.asks.filter(isDid).map((body) => body.did as Record<string, unknown>);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ action: "what_tex_sees", status: "read" });
  });

  it('"Tex, stop" keeps its fixed line: a muted chat runs no model', async () => {
    const storage = new MemoryStorage();
    const w = world((kind) => (kind === "stop" ? { status: "stopped" } : undefined));
    await acceptGroup(storage, w.message("Tex, stop"), 0);
    await drainGroup(storage, w.deps);
    expect(w.texts).toEqual([GROUP_LINES.stopped]);
    expect(w.asks.filter(isDid)).toHaveLength(0);
  });

  it("a did turn never starts another: what it set off goes in its old line", async () => {
    const storage = new MemoryStorage();
    const w = world(
      (kind) => (kind === "invite" ? { status: "invited", slug: "studio", count: 1, role: "member" } : undefined),
      (body) => (isDid(body) ? { answer: "Done, and again.", invite: { slug: "studio", role: "member" } } : { answer: "Sharing it.", invite: { slug: "studio", role: "member" } }),
    );
    await acceptGroup(storage, w.message("Tex can you share @studio with everyone here"), 0);
    for (let round = 0; round < 4; round++) await drainGroup(storage, w.deps);
    expect(w.asks.filter(isDid)).toHaveLength(1);
  });

  it("two commands at once each reach Tex, in order, and nothing is dropped", async () => {
    const storage = new MemoryStorage();
    const w = world((kind) => (kind === "start" ? { status: "started" } : kind === "invite" ? { status: "invited", slug: "studio", count: 1, role: "member" } : undefined));
    await acceptGroup(storage, w.message("Tex, start"), 0);
    await acceptGroup(storage, w.message("Tex add everyone here to @studio"), 0);
    for (let round = 0; round < 4; round++) await drainGroup(storage, w.deps);
    expect(w.asks.filter(isDid).map((body) => (body.did as { action: string }).action)).toEqual(["unmute", "invite"]);
    expect(w.texts).toHaveLength(2);
  });
});
