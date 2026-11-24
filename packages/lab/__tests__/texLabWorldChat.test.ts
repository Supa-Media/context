/**
 * Made-up group chats in the Lab (Dev, 2026-11-24, approved artboards `group-chat-sim-artboards/`): the scenarios as
 * the `open` the gateway takes (`labSandbox/world.js` `worldInput`), the setup's "Tex can see" estimate, the preview's
 * own answer winning over it, and the Chat view's rows: runs of bubbles, events for joins, leaves and Undo Send, the
 * why line under each person's text, Tex's quiet turns folded into it, and Tex typing while a turn runs.
 *
 * Every name, number and message here is invented. This repository is public.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-24):
 *  1. seeEstimate taking the highest role instead of the lowest -> "a member makes it read-only" fails;
 *  2. seeEstimate counting an invitation as membership in every workspace -> "an invitation by number counts" fails;
 *  3. chatEntries keeping Tex's quiet row as a bubble -> "a stay-quiet is the why line" fails;
 *  4. seeChips ignoring the group answer -> "the preview's answer wins" fails;
 *  5. worldNow not naming a guest label -> "the preview's guest label is named as the person with no account" fails.
 */
import { describe, expect, test } from "@jest/globals";
import type { SandboxRow } from "@context/lab/app/engine/sandbox";
import { changeWords, draftProblem, scenarioDraft, SCENARIOS, seeChips, seeEstimate, worldPayload, type WorldPerson } from "@context/lab/app/views/canvas/world/worldModel";
import { chatEntries, peopleAfter, whyOf } from "@context/lab/app/views/canvas/world/chatModel";
import { worldNow } from "@context/lab/app/views/canvas/world/worldView";

const people = (id: string) => scenarioDraft(id)!.people;

describe("scenarios and the open they make", () => {
  test("the picker has the seven ready-made chats, each a valid setup", () => {
    expect(SCENARIOS.map((s) => s.title)).toEqual([
      "Everyone on Context",
      "Mixed: one person not on Context",
      "Only you on Context",
      "Guest invited by number",
      "Different owners",
      "Tex dropped into a chat already going",
      "Someone joins who isn't a member",
    ]);
    for (const s of SCENARIOS) expect(draftProblem(scenarioDraft(s.id)!)).toBeNull();
  });

  test("a setup becomes worldInput's shape: roles only for people on Context, an invitation for a guest by number", () => {
    const w = worldPayload(scenarioDraft("invited")!);
    expect(w).toEqual({
      name: "Lumio launch, with Priya",
      people: [
        { name: "Alpha Morgan", account: "on", roles: { lumio: "owner", "maison-solenne": "editor" } },
        { name: "Beta Chen", account: "on", roles: { lumio: "editor", "maison-solenne": "member", "common-ground": "editor" } },
        { name: "Priya", account: "invited", invited: { slug: "lumio", role: "member" } },
      ],
      sponsor: "Alpha Morgan",
      speaksUp: "attentive",
      introduced: false,
      start: [],
    });
    const going = worldPayload(scenarioDraft("going")!);
    expect((going.start as unknown[]).length).toBe(12);
  });

  test("the setup refuses what the gateway would", () => {
    const d = scenarioDraft("everyone")!;
    expect(draftProblem({ ...d, people: [...d.people, { name: "Tex", account: "off" }] })).toMatch(/Tex's/);
    expect(draftProblem({ ...d, people: [...d.people, { name: "Beta Chen", account: "off" }] })).toMatch(/Two people/);
    expect(draftProblem({ ...d, people: [...d.people, { name: "Rui", account: "invited" }] })).toMatch(/invited by number/);
    expect(draftProblem({ ...d, sponsor: "Nobody" })).toMatch(/brings Tex in/);
  });
});

describe("what Tex can see", () => {
  test("a member makes it read-only; anyone missing keeps it out", () => {
    const e = seeEstimate(people("everyone"));
    expect(e[0]).toEqual({ kind: "ok", slug: "lumio", name: "Lumio", edit: false, note: "read-only: Gamma is a member" });
    expect(e[1]).toMatchObject({ kind: "out", slug: "maison-solenne", by: ["Gamma"] });
    expect(e[2]).toMatchObject({ kind: "out", slug: "common-ground", by: ["Alpha"] });
    const chips = seeChips(people("everyone"));
    expect(chips[chips.length - 1]).toEqual({ kind: "home" });
  });

  test("an invitation by number counts, only for its own workspace", () => {
    const e = seeEstimate(people("invited"));
    expect(e[0]).toMatchObject({ kind: "ok", note: "read-only: Priya is invited as a member" });
    expect(e[1]).toMatchObject({ kind: "out", by: ["Priya"] });
  });

  test("someone not on Context keeps every workspace out, and this chat's notes come first", () => {
    const chips = seeChips(people("mixed"));
    expect(chips[0]).toEqual({ kind: "home" });
    expect(chips.slice(1).every((c) => c.kind === "out" && c.by.includes("Sam"))).toBe(true);
  });

  test("the preview's answer wins over the estimate, its handles named", () => {
    const chips = seeChips(people("everyone"), { reach: [], blocked: [{ slug: "lumio", who: "gamma-x1", why: "not_member" }] }, (h) => (h === "gamma-x1" ? "Gamma Ellis" : h));
    expect(chips.find((c) => c.kind !== "home" && c.slug === "lumio")).toMatchObject({ kind: "out", by: ["Gamma"] });
    expect(chips[0]).toEqual({ kind: "home" });
  });

  test("the preview's guest label is named as the person with no account", () => {
    const ps = people("mixed");
    const known = Object.fromEntries(ps.map((p) => [p.name.toLowerCase(), p]));
    const group = { reach: [], blocked: [{ slug: "lumio", who: "guest-6ce3", why: "no_account" }], guests: ["guest-6ce3"] };
    const now = worldNow({ rows: [{ id: "r", who: "Tex", tex: true, text: "hi", at: 0, group }], handles: {} }, { opened: ps, known, rolesKnown: true });
    expect(now.chips?.find((c) => c.kind === "out" && c.slug === "lumio")).toMatchObject({ by: ["Sam"] });
  });

  test("a join that takes a workspace away marks it, and says so", () => {
    const before = people("joins");
    const sam: WorldPerson = { name: "Sam", account: "off" };
    const after = [...before, sam];
    const chips = seeChips(after, null, undefined, before);
    expect(chips.find((c) => c.kind === "out" && c.slug === "maison-solenne")).toMatchObject({ was: "read-only", by: ["Sam"] });
    const words = changeWords(before, after, sam, "added", "guest-6ce3");
    expect(words?.map((s) => s.t).join("")).toBe("Sam isn't on Context (Tex sees guest-6ce3) and isn't in Maison Solenne or invited to it, so Tex can't see Maison Solenne from the next text on.");
    expect(
      changeWords(after, before, sam, "left")
        ?.map((s) => s.t)
        .join(""),
    ).toMatch(/Tex can now see Maison Solenne/);
  });
});

const at = Date.UTC(2026, 10, 24, 14, 41);
const row = (r: Partial<SandboxRow> & { id: string }): SandboxRow => ({ who: "", text: "", at, ...r });
const step = (node: string, out: unknown, ms: number | null = 3) => ({ node, out: typeof out === "string" ? out : JSON.stringify(out), ms, ok: true, ...(typeof out === "string" ? {} : { data: out }) });

describe("the Chat view", () => {
  const rows: SandboxRow[] = [
    row({ id: "1", who: "Gamma Ellis", text: "ok launch is thursday" }),
    row({
      id: "2",
      who: "Gamma Ellis",
      text: "pricing copy is done",
      reactions: [{ who: "Beta Chen", emoji: "❤️" }],
      steps: [step("triage", { to: "judge", why: "not tagged" }), step("decide", { verdict: "quiet", why: "a burst of updates; nothing asked of Tex" }, 600)],
    }),
    row({ id: "2r", who: "Tex", tex: true, reply: "2", quiet: true }),
    row({ id: "3", who: "Beta Chen", text: "@Tex what's left before Thursday?", steps: [step("triage", { to: "tex", why: "asked by name" })] }),
    row({ id: "3r", who: "Tex", tex: true, reply: "3", text: "From Lumio's launch checklist, 3 things are left:\n\nPress kit · Beta" }),
    row({ id: "4", who: "Lab", kind: "people", change: "added", name: "Sam", text: "Delta Brooks added Sam" }),
    row({ id: "5", who: "Beta Chen", text: "wrong chat", unsent: true }),
    row({ id: "6", who: "Beta Chen", kind: "unsend", on: "5", text: "" }),
    row({ id: "7", who: "Alpha Morgan", text: "@Tex can you draft the status email?", replyTo: "2", steps: [step("triage", { to: "tex", why: "asked by name" })] }),
  ];
  const entries = chatEntries(rows, { as: "Beta Chen", running: "7", hotWords: "Front door", now: at, world: { opened: people("everyone"), known: { sam: { name: "Sam", account: "off" } } } });

  test("a run of bubbles from one sender, a time line first", () => {
    expect(entries[0]).toMatchObject({ t: "time", day: "Today" });
    const g = entries[1];
    expect(g).toMatchObject({ t: "run", who: "Gamma Ellis", side: "in" });
    if (g.t !== "run") throw new Error("run");
    expect(g.items.map((b) => b.text)).toEqual(["ok launch is thursday", "pricing copy is done"]);
    expect(g.items[1].reactions).toEqual([{ who: "Beta Chen", emoji: "❤️" }]);
  });

  test("a stay-quiet is the why line, never a bubble of Tex's", () => {
    const g = entries[1];
    if (g.t !== "run") throw new Error("run");
    expect(g.items[1].why).toMatchObject({ yes: false, by: "Decide", reason: "a burst of updates; nothing asked of Tex" });
    expect(entries.filter((e) => e.t === "run" && e.tex).length).toBe(2); // the answer and the typing dots
  });

  test("texting as Beta puts Beta on the right; Tex's answer is one bubble a part", () => {
    expect(entries[2]).toMatchObject({ t: "run", who: "Beta Chen", side: "out" });
    const tex = entries[3];
    if (tex.t !== "run") throw new Error("run");
    expect(tex.items.map((b) => b.text)).toEqual(["From Lumio's launch checklist, 3 things are left:", "Press kit · Beta"]);
  });

  test("joins and Undo Send are centered event lines, a join with what it changes", () => {
    const ev = entries.filter((e) => e.t === "event").map((e) => (e.t === "event" ? e.text : ""));
    expect(ev).toEqual(["Delta added Sam to the conversation.", "Beta unsent a message."]);
    const join = entries.find((e) => e.t === "event" && e.id === "4");
    expect(join && join.t === "event" ? join.change?.some((s) => s.b && /Tex can't see Lumio/.test(s.t)) : false).toBe(true);
    expect(JSON.stringify(entries)).not.toContain("wrong chat");
  });

  test("a reply quotes its text; a running turn shows Tex typing with the step running", () => {
    const a = entries.find((e) => e.t === "run" && e.who === "Alpha Morgan");
    if (!a || a.t !== "run") throw new Error("run");
    expect(a.items[0].quote).toEqual({ who: "Gamma Ellis", text: "pricing copy is done" });
    expect(a.items[0].why).toMatchObject({ yes: true, running: true, reason: "asked by name; running now", by: "Triage" });
    const last = entries[entries.length - 1];
    expect(last).toMatchObject({ t: "run", who: "Tex" });
    if (last.t !== "run") throw new Error("run");
    expect(last.items[0]).toMatchObject({ kind: "typing", note: "Front door" });
  });

  test("Delivered stays under your newest text while others text after it", () => {
    const mine = entries.filter((e) => e.t === "run" && e.side === "out");
    const last = mine[mine.length - 1];
    if (!last || last.t !== "run") throw new Error("run");
    expect(last.items[last.items.length - 1].status).toBe("Delivered");
    expect(entries.flatMap((e) => (e.t === "run" ? e.items : [])).filter((b) => b.status).length).toBe(1);
  });

  test("a time line after five quiet minutes, none between texts closer than that", () => {
    const t0 = at - 60 * 60_000;
    const r = [row({ id: "a", who: "Gamma Ellis", text: "one", at: t0 }), row({ id: "b", who: "Gamma Ellis", text: "two", at: t0 + 4 * 60_000 }), row({ id: "c", who: "Gamma Ellis", text: "three", at: t0 + 10 * 60_000 })];
    expect(chatEntries(r, { as: "Beta Chen", running: null, now: at }).filter((e) => e.t === "time").length).toBe(2);
  });

  test("who is here follows the people rows, and a text that never ran has no why line", () => {
    expect(peopleAfter(people("everyone"), { sam: { name: "Sam", account: "off" } }, rows).map((p) => p.name)).toEqual(["Alpha Morgan", "Beta Chen", "Gamma Ellis", "Sam"]);
    expect(whyOf(row({ id: "x", who: "Delta", text: "hi", prod: true }), [], false)).toBeNull();
    expect(whyOf(row({ id: "y", who: "Delta", text: "hi", steps: [step("decide", "act: respond")] }), [row({ id: "yr", tex: true, who: "Tex", text: "Hello" })], false)).toMatchObject({ yes: true, by: "Decide" });
  });
});
