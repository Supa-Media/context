/**
 * A made-up group chat's own state in the Lab, beside the test chat's (`engine/sandbox.ts`): who it opened with and
 * everyone who joined since (their accounts and roles, which the gateway's rows don't carry), the setup while it is
 * open, and whether the Chat view fills the page. Opening, joining and leaving go through the test chat's own calls;
 * the people the preview made (their handles) are read back with `about`, so texts and rows name them.
 */
import { useSyncExternalStore } from "react";
import { callSandboxRoute, changePeople, openSandbox, sandbox, sandboxChanged, type SandboxSource } from "../../../engine/sandbox";
import { setDockView } from "../../../engine/sandboxPlay";
import { personInput, setWorkspaces, workspaces, worldPayload, type SpeaksUp, type WorldDraft, type WorldPerson } from "./worldModel";

export type WorldState = {
  /** The chat open now: who it opened with, everyone ever known by lowercased name, and its settings. */
  opened: WorldPerson[] | null;
  known: Record<string, WorldPerson>;
  /** Whether the people's roles are known (false for a chat attached by its id): the estimate needs them. */
  rolesKnown: boolean;
  settings: { name: string; sponsor: string; speaksUp: SpeaksUp; introduced: boolean; preset?: string; then?: WorldPerson } | null;
  /** The setup in the dock, and what it was filled in from (Undo my changes). */
  draft: WorldDraft | null;
  base: WorldDraft | null;
  fill: boolean;
  /** The test chat whose people were read back last. */
  synced: string | null;
  problem: string | null;
  /** Whose workspaces the setup offers: the preview's seeded three, or main's (the Lab user's own), once read. */
  workspacesFor: "preview" | "main" | null;
  /** Why the Lab user's workspaces couldn't be read, and how many they have (the setup shows at most four). */
  workspacesProblem: string | null;
  workspacesTotal: number | null;
};

export const world: WorldState = { opened: null, known: {}, rolesKnown: false, settings: null, draft: null, base: null, fill: false, synced: null, problem: null, workspacesFor: null, workspacesProblem: null, workspacesTotal: null };

const subs = new Set<() => void>();
let ver = 0;
const emit = () => {
  ver++;
  subs.forEach((f) => f());
};
export function useWorld(): WorldState {
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => ver,
    () => ver,
  );
  return world;
}

const keyOf = (name: string) => name.trim().toLowerCase();
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/**
 * The workspaces made-up people can have roles in for the Code chosen: on a pull request the preview's three, on main
 * the Lab user's own shared ones (the gateway's `worlds`), read once and shared by every caller while it is read. A
 * read answered after Code changed is dropped. A failed read offers none and says why (`workspacesProblem`); the
 * answer is whether made-up chats can be opened now.
 */
let reading: Promise<boolean> | null = null;
export async function loadWorkspaces(main: boolean): Promise<boolean> {
  if (!main) {
    setWorkspaces(null);
    world.workspacesFor = "preview";
    world.workspacesProblem = null;
    world.workspacesTotal = null;
    emit();
    return true;
  }
  if (world.workspacesFor === "main") return true;
  reading ??= (async () => {
    try {
      const b = await callSandboxRoute("worlds", {});
      if (sandbox.code !== "main") return false;
      const list = Array.isArray(b.workspaces) ? (b.workspaces as Array<Record<string, unknown>>).map((x) => ({ slug: String(x.slug ?? ""), name: String(x.name ?? x.slug ?? "") })).filter((x) => x.slug) : [];
      setWorkspaces(list);
      world.workspacesFor = "main";
      world.workspacesTotal = list.length;
      world.workspacesProblem = null;
      return true;
    } catch (e) {
      if (sandbox.code !== "main") return false;
      setWorkspaces([]);
      world.workspacesFor = null;
      world.workspacesProblem = e instanceof Error ? e.message : "Couldn't read your workspaces";
      return false;
    } finally {
      reading = null;
      emit();
    }
  })();
  return await reading;
}

/** The setup, filled in from a scenario, a blank chat, or the chat open now ("Set up"). */
export function openSetup(d: WorldDraft) {
  world.draft = clone(d);
  world.base = clone(d);
  world.problem = null;
  emit();
}
export function editSetup(f: (d: WorldDraft) => void) {
  if (!world.draft) return;
  f(world.draft);
  world.draft = { ...world.draft };
  emit();
}
/** The setup's roles and invitations kept only where there is such a workspace here (after Code changed). */
export function fitDraft() {
  if (!world.draft) return;
  const here = new Set(workspaces().map((w) => w.slug));
  const fit = (p: WorldPerson): WorldPerson => {
    const roles = Object.fromEntries(Object.entries(p.roles ?? {}).filter(([slug]) => here.has(slug)));
    if (p.account === "invited" && !(p.invited && here.has(p.invited.slug))) return { name: p.name, account: "off" };
    return { ...p, ...(p.account === "on" ? { roles } : {}) };
  };
  const people = world.draft.people.map(fit);
  if (JSON.stringify(people) === JSON.stringify(world.draft.people)) return;
  world.draft = { ...world.draft, people };
  emit();
}
export function undoSetup() {
  if (world.base) world.draft = clone(world.base);
  emit();
}
export function closeSetup() {
  world.draft = null;
  world.base = null;
  emit();
}
export function setFill(on: boolean) {
  world.fill = on;
  emit();
}

/** The setup of the chat open now, for "Set up": its people as they are now, its settings as it opened. */
export function currentDraft(people: WorldPerson[]): WorldDraft | null {
  const s = world.settings;
  if (!s) return null;
  return { name: s.name, people: clone(people), sponsor: s.sponsor, speaksUp: s.speaksUp, introduced: s.introduced, start: [], ...(s.preset ? { preset: s.preset } : {}) };
}

/** Open a made-up chat from a setup (or a scenario): the Chat view, the people it opened with kept for the estimate. */
export async function openWorld(d: WorldDraft, versionId: string) {
  const w = worldPayload(d);
  world.opened = clone(d.people);
  world.known = Object.fromEntries(d.people.map((p) => [keyOf(p.name), clone(p)]));
  if (d.then) world.known[keyOf(d.then.name)] = clone(d.then);
  world.rolesKnown = true;
  world.settings = { name: String(w.name), sponsor: String(w.sponsor ?? ""), speaksUp: d.speaksUp, introduced: d.introduced, ...(d.preset ? { preset: d.preset } : {}), ...(d.then ? { then: clone(d.then) } : {}) };
  world.draft = null;
  world.base = null;
  world.synced = null;
  world.problem = null;
  emit();
  setDockView("chat");
  const source: SandboxSource = { kind: "world", name: String(w.name), world: w };
  await openSandbox(source, versionId);
  await syncPeople();
}

/**
 * The people the preview made, by handle (`about`): the composer's "Texting as", and rows named by name. A chat
 * attached by its id learns who is in it (and their accounts) here; their roles it can't, so the estimate waits for
 * the first answer.
 */
export async function syncPeople() {
  if (sandbox.source.kind !== "world" || !sandbox.id) return;
  // While the preview starts, the people it opened with stand in, so "Texting as" can be picked before the first text
  // (found 2026-11-24: the row stayed empty until the preview answered). Their handles come when it does.
  if (sandbox.preview?.starting) {
    if (!sandbox.people.length && world.opened?.length) {
      sandbox.people = world.opened.map((p) => p.name);
      if (!sandbox.people.includes(sandbox.as)) sandbox.as = sandbox.people[0] ?? "";
      sandboxChanged();
      emit();
    }
    return;
  }
  const id = sandbox.id;
  try {
    const b = await callSandboxRoute("about", { sandboxId: id });
    if (sandbox.id !== id || !Array.isArray(b.people)) return;
    const ps = (b.people as Array<Record<string, unknown>>)
      .map((p) => ({ handle: String(p.handle ?? p.name ?? ""), name: String(p.name ?? p.handle ?? ""), account: p.account === "off" || p.account === "invited" ? p.account : "on" }))
      .filter((p) => p.name);
    if (!world.opened) {
      world.opened = ps.map((p) => ({ name: p.name, account: p.account as WorldPerson["account"] }));
      world.known = Object.fromEntries(world.opened.map((p) => [keyOf(p.name), p]));
      world.rolesKnown = false;
      world.settings = { name: sandbox.source.name, sponsor: "", speaksUp: "attentive", introduced: false };
    }
    for (const p of ps) if (!world.known[keyOf(p.name)]) world.known[keyOf(p.name)] = { name: p.name, account: p.account as WorldPerson["account"] };
    sandbox.people = ps.map((p) => p.name);
    sandbox.handles = Object.fromEntries(ps.map((p) => [p.name, p.handle]));
    const nameOf = new Map(ps.map((p) => [p.handle, p.name]));
    sandbox.rows.forEach((r) => (r.who = nameOf.get(r.who) ?? r.who));
    if (!sandbox.people.includes(sandbox.as)) sandbox.as = sandbox.people[0] ?? "";
    world.synced = id;
    sandboxChanged();
    emit();
  } catch (e) {
    world.problem = e instanceof Error ? e.message : "Couldn't read who is in this chat";
    emit();
  }
}

/** Someone joins now, added by `by` (a name here), as a real chat's people change; a row the chat shows. */
export async function joinPerson(p: WorldPerson, by: string) {
  world.known[keyOf(p.name)] = clone(p);
  await changePeople("join", { ...personInput(p), as: sandbox.handles[by] ?? by });
  if (!sandbox.problem) await syncPeople();
}

/** Someone leaves the chat now. */
export async function leavePerson(name: string) {
  await changePeople("leave", { name, as: sandbox.handles[name] ?? name });
  if (!sandbox.problem) await syncPeople();
}

/** For tests. */
export function resetWorld() {
  Object.assign(world, { opened: null, known: {}, rolesKnown: false, settings: null, draft: null, base: null, fill: false, synced: null, problem: null, workspacesFor: null, workspacesProblem: null, workspacesTotal: null });
  setWorkspaces(null);
  emit();
}
