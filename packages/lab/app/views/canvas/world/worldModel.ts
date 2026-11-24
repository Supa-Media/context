/**
 * Made-up group chats in the Lab (Dev, 2026-11-24, approved artboards `group-chat-sim-artboards/` 01 and 02): the
 * ready-made scenarios, the setup's people and settings as the `open` the gateway takes (`labSandbox/world.js`
 * `worldInput`), and what Tex can see with these people.
 *
 * "Tex can see" here is only the setup's and the strip's estimate, worked out in the browser so it changes as you
 * edit: a workspace counts only if everyone here is in it or invited to it by number, and Tex gets the lowest role
 * among them (a member means read-only). Personal workspaces never count. On main the workspaces are the Lab user's own
 * shared ones and the scenarios are placed on them in order (`setWorkspaces`). Once a text has run, the control plane
 * says what the chat reached and who kept a workspace out (a reply row's `group`), and that answer wins
 * (`seeChips`). Pure: no React, no gateway.
 */

/** A workspace's slug: on a preview one of its seeded three, on main one of the Lab user's own shared workspaces. */
export type Slug = string;
export type Role = "owner" | "editor" | "member";
export type Account = "on" | "off" | "invited";
export type SpeaksUp = "off" | "quiet" | "attentive" | "followAlong" | "helpful";
export type WorldPerson = { name: string; account: Account; roles?: Partial<Record<Slug, Role>>; invited?: { slug: Slug; role: "editor" | "member" } };
export type StartLine = { as: string; text: string };
/** A made-up chat as the setup holds it. `sponsor` is a name; `preset` the scenario it was filled in from. */
export type WorldDraft = { name: string; people: WorldPerson[]; sponsor: string; speaksUp: SpeaksUp; introduced: boolean; start: StartLine[]; preset?: string; then?: WorldPerson };

/** The preview's seeded shared workspaces (`apps/convex/functions/texLabWorld.ts` `WORLD_WORKSPACES`), in order. */
export const PREVIEW_WORKSPACES: ReadonlyArray<{ slug: Slug; name: string }> = [
  { slug: "lumio", name: "Lumio" },
  { slug: "maison-solenne", name: "Maison Solenne" },
  { slug: "common-ground", name: "Common Ground" },
];
/** Most workspace columns the setup shows. */
export const MAX_WORKSPACES = 4;
let current: ReadonlyArray<{ slug: Slug; name: string }> = PREVIEW_WORKSPACES;
/**
 * The workspaces made-up people can have roles in: the preview's three, or on main the Lab user's own shared ones
 * (`worldStore.ts` `loadWorkspaces`; the pin and personal workspaces are never offered). Null puts the preview's back.
 */
export function setWorkspaces(list: ReadonlyArray<{ slug: Slug; name: string }> | null) {
  current = list === null ? PREVIEW_WORKSPACES : list.slice(0, MAX_WORKSPACES);
}
export const workspaces = () => current;
export const MAX_PEOPLE = 8;
export const wsName = (slug: string) => current.find((w) => w.slug === slug)?.name ?? PREVIEW_WORKSPACES.find((w) => w.slug === slug)?.name ?? slug;
/** A scenario's workspace (written with the preview's slugs) as the one in its place here, or null when there's none. */
const placed = (slug: Slug): Slug | null => {
  const i = PREVIEW_WORKSPACES.findIndex((w) => w.slug === slug);
  return i < 0 ? slug : (current[i]?.slug ?? null);
};
/** A scenario's words with its first workspace named as the one in its place here. */
export const placedWords = (text: string) => {
  const name = current[0]?.name;
  return name ? text.replace(/Lumio/g, () => name) : text;
};

export const SPEAKS_UP: ReadonlyArray<{ v: SpeaksUp; w: string; tip: string }> = [
  { v: "off", w: "Off", tip: 'Off: Tex says nothing here until someone says "Tex, start". The same as "Tex, stop".' },
  { v: "quiet", w: "Quiet", tip: 'Quiet: answers only when tagged. Off is "Tex, stop".' },
  { v: "attentive", w: "Attentive", tip: 'Attentive: answers when asked or tagged, and joins in when it clearly helps. Quiet answers only when tagged; Off is "Tex, stop".' },
  { v: "followAlong", w: "Follow along", tip: 'Follow along: keeps up with plans and lists as they change, and offers to help with them. Off is "Tex, stop".' },
  { v: "helpful", w: "Helpful", tip: 'Helpful: joins in whenever it has something useful to add. Off is "Tex, stop".' },
];
export const speaksUpWord = (v: SpeaksUp) => SPEAKS_UP.find((x) => x.v === v)?.w ?? v;
export const ACCOUNT_WORDS: Record<Account, string> = { on: "On Context", off: "Not on Context", invited: "Invited by number" };

export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
export const initial = (name: string) => (name.trim()[0] ?? "?").toUpperCase();

/** One person's role in a workspace: their own as a member, their invitation's, or none. */
export function roleIn(p: WorldPerson, slug: Slug): { role: Role; invited: boolean } | null {
  if (p.account === "on") return p.roles?.[slug] ? { role: p.roles[slug] as Role, invited: false } : null;
  if (p.account === "invited" && p.invited?.slug === slug) return { role: p.invited.role, invited: true };
  return null;
}

const RANK: Record<Role, number> = { member: 0, editor: 1, owner: 2 };

export type SeeChip = { kind: "home" } | { kind: "ok"; slug: Slug; name: string; edit: boolean | null; note: string } | { kind: "out"; slug: Slug; name: string; by: string[]; was?: "read-only" | "can edit" };

const list = (xs: string[]) => xs.join(", ");

/** Each workspace with these people: who keeps it out, else the lowest role among them. */
export function seeEstimate(people: WorldPerson[]): Array<Exclude<SeeChip, { kind: "home" }>> {
  return current.map(({ slug, name }) => {
    const roles = people.map((p) => ({ p, r: roleIn(p, slug) }));
    const out = roles.filter((x) => x.r === null).map((x) => firstName(x.p.name));
    if (!people.length || out.length) return { kind: "out" as const, slug, name, by: out };
    const low = Math.min(...roles.map((x) => RANK[x.r!.role]));
    const lowest = roles.filter((x) => RANK[x.r!.role] === low);
    const who = lowest.map((x) => firstName(x.p.name));
    if (low > 0) return { kind: "ok" as const, slug, name, edit: true, note: "can edit" };
    const invited = lowest.every((x) => x.r!.invited);
    return { kind: "ok" as const, slug, name, edit: false, note: `read-only: ${list(who)} ${who.length > 1 ? "are" : "is"} ${invited ? "invited as a member" : who.length > 1 ? "members" : "a member"}` };
  });
}

/** What the preview's control plane said of one turn's chat (a reply row's `group`, `labSandbox/world.js`). */
export type GroupAnswer = { path?: string; status?: string | null; reach: string[]; blocked: Array<{ slug: string; who: string; why: string }>; intro?: boolean; guests?: string[] };

/** A reply row's `group`, read defensively; null when it has none. */
export function groupOf(v: unknown): GroupAnswer | null {
  if (!v || typeof v !== "object") return null;
  const g = v as Record<string, unknown>;
  const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  const blocked = Array.isArray(g.blocked)
    ? g.blocked.flatMap((b) =>
        b && typeof b === "object" && typeof (b as Record<string, unknown>).slug === "string"
          ? [{ slug: String((b as Record<string, unknown>).slug), who: String((b as Record<string, unknown>).who ?? ""), why: String((b as Record<string, unknown>).why ?? "") }]
          : [],
      )
    : [];
  return { ...(typeof g.path === "string" ? { path: g.path } : {}), status: typeof g.status === "string" ? g.status : null, reach: strs(g.reach), blocked, intro: g.intro === true, guests: strs(g.guests) };
}

/**
 * The chips the strip and the setup show, in order: visible workspaces, then the ones kept out, then this chat's
 * notes (first instead when Tex sees no workspace). With a `group` answer its reach and blockers decide (handles
 * named through `nameOf`); the estimate only fills in the role words. `before` marks a workspace a change took away.
 */
export function seeChips(people: WorldPerson[], group: GroupAnswer | null = null, nameOf: (h: string) => string = (h) => h, before: WorldPerson[] | null = null): SeeChip[] {
  const est = seeEstimate(people);
  const ws = est.map((c): Exclude<SeeChip, { kind: "home" }> => {
    if (!group) return c;
    if (group.reach.includes(c.slug)) return c.kind === "ok" ? c : { kind: "ok", slug: c.slug, name: c.name, edit: null, note: "visible" };
    const named = group.blocked.filter((b) => b.slug === c.slug).map((b) => firstName(nameOf(b.who)));
    return { kind: "out", slug: c.slug, name: c.name, by: named.length ? [...new Set(named)] : c.kind === "out" ? c.by : [] };
  });
  if (before) {
    const was = seeEstimate(before);
    for (const [i, c] of ws.entries()) {
      const w = was[i];
      if (c.kind === "out" && w.kind === "ok") ws[i] = { ...c, was: w.edit ? "can edit" : "read-only" };
    }
  }
  const ok = ws.filter((c) => c.kind === "ok");
  const out = ws.filter((c) => c.kind === "out").sort((a, b) => Number(!!(b as { was?: string }).was) - Number(!!(a as { was?: string }).was));
  return ok.length ? [...ok, ...out, { kind: "home" }] : [{ kind: "home" }, ...out];
}

/** A line with some words bold, for a change callout. */
export type Seg = { t: string; b?: boolean };

/** What a join or a leave changes about what Tex can see, as a callout under the event; null when nothing changes. */
export function changeWords(before: WorldPerson[], after: WorldPerson[], who: WorldPerson | null, change: "added" | "left", guest?: string): Seg[] | null {
  const a = seeEstimate(before);
  const b = seeEstimate(after);
  const lost = b.filter((c, i) => c.kind === "out" && a[i].kind === "ok").map((c) => c.name);
  const won = b.filter((c, i) => c.kind === "ok" && a[i].kind === "out").map((c) => c.name);
  const segs: Seg[] = [];
  if (lost.length && who) {
    const nm = firstName(who.name);
    const off = who.account === "off" ? ` isn't on Context${guest ? ` (Tex sees ${guest})` : ""} and` : "";
    segs.push({ t: `${nm}${off} isn't in ${list(lost)} or invited to it, so ` }, { t: `Tex can't see ${list(lost)}`, b: true }, { t: " from the next text on." });
  }
  if (won.length) segs.push({ t: segs.length ? " " : "" }, { t: `Tex can now see ${list(won)}`, b: true }, { t: change === "left" ? ` from the next text on: everyone left is in it.` : " from the next text on." });
  return segs.length ? segs : null;
}

/** The setup's own check before it opens: words for the first problem, or null. */
export function draftProblem(d: WorldDraft): string | null {
  if (d.people.length < 1 || d.people.length > MAX_PEOPLE) return `A made-up chat has 1 to ${MAX_PEOPLE} people besides Tex`;
  const seen = new Set<string>();
  for (const p of d.people) {
    const n = p.name.trim();
    if (!/^[\p{L}\p{N}][\p{L}\p{N} .'-]{0,39}$/u.test(n)) return "Each person needs a name: letters, numbers, spaces, . ' -";
    if (["tex", "context", "you"].includes(n.toLowerCase())) return `"${n}" is Tex's or the Lab's name`;
    if (seen.has(n.toLowerCase())) return `Two people are called ${n}`;
    seen.add(n.toLowerCase());
    if (p.account === "invited" && !p.invited) return `${n} is invited by number: pick the workspace`;
  }
  if (d.sponsor && !d.people.some((p) => p.name === d.sponsor && p.account === "on")) return "Whoever brings Tex in is someone here on Context";
  return null;
}

/** One person as `open` and `join` take them. */
export function personInput(p: WorldPerson): Record<string, unknown> {
  if (p.account === "on") return { name: p.name.trim(), account: "on", roles: Object.fromEntries(Object.entries(p.roles ?? {}).filter(([, r]) => !!r)) };
  if (p.account === "invited") return { name: p.name.trim(), account: "invited", ...(p.invited ? { invited: p.invited } : {}) };
  return { name: p.name.trim(), account: "off" };
}

/** The setup as `open`'s `world` (`labSandbox/world.js` `worldInput`). */
export function worldPayload(d: WorldDraft): Record<string, unknown> {
  const on = d.people.filter((p) => p.account === "on");
  const sponsor = on.find((p) => p.name === d.sponsor)?.name ?? on[0]?.name;
  return {
    name: d.name.trim() || d.people.map((p) => firstName(p.name)).join(", "),
    people: d.people.map(personInput),
    ...(sponsor ? { sponsor } : {}),
    speaksUp: d.speaksUp,
    introduced: d.introduced,
    start: d.start.filter((l) => l.text.trim() && d.people.some((p) => p.name === l.as)),
  };
}

const P = {
  alpha: (roles: WorldPerson["roles"] = { lumio: "owner", "maison-solenne": "editor" }): WorldPerson => ({ name: "Alpha Morgan", account: "on", roles }),
  beta: (roles: WorldPerson["roles"] = { lumio: "editor", "maison-solenne": "member", "common-ground": "editor" }): WorldPerson => ({ name: "Beta Chen", account: "on", roles }),
  gamma: (roles: WorldPerson["roles"] = { lumio: "member", "common-ground": "member" }): WorldPerson => ({ name: "Gamma Ellis", account: "on", roles }),
  delta: (roles: WorldPerson["roles"] = { "maison-solenne": "owner", "common-ground": "editor" }): WorldPerson => ({ name: "Delta Brooks", account: "on", roles }),
  sam: (): WorldPerson => ({ name: "Sam", account: "off" }),
  priya: (invited?: WorldPerson["invited"]): WorldPerson => (invited ? { name: "Priya", account: "invited", invited } : { name: "Priya", account: "off" }),
};

const DINNER: StartLine[] = [
  ["Delta Brooks", "Saturday still on? I'm cooking"],
  ["Alpha Morgan", "yes!! what are we making"],
  ["Delta Brooks", "thinking roast chicken, maybe leeks"],
  ["Beta Chen", "I can bring wine"],
  ["Alpha Morgan", "I'll do dessert"],
  ["Delta Brooks", "pear tart? the one from last time"],
  ["Alpha Morgan", "yes that one"],
  ["Beta Chen", "what time?"],
  ["Delta Brooks", "7, at mine"],
  ["Beta Chen", "perfect"],
  ["Alpha Morgan", "should we invite Sam?"],
  ["Delta Brooks", "sure, I'll add him later"],
].map(([as, text]) => ({ as, text }));

/** The ready-made scenarios of the picker's Made-up chats tab (artboard 01), each a whole setup. */
export const SCENARIOS: ReadonlyArray<{ id: string; title: string; says: string; size: string; needs: number; draft: WorldDraft }> = [
  {
    id: "everyone",
    needs: 1,
    title: "Everyone on Context",
    says: "Three teammates, all members of Lumio",
    size: "3 people",
    draft: { name: "Lumio launch", people: [P.alpha(), P.beta(), P.gamma()], sponsor: "Alpha Morgan", speaksUp: "attentive", introduced: false, start: [] },
  },
  {
    id: "mixed",
    needs: 0,
    title: "Mixed: one person not on Context",
    says: "Sam has no account; Tex sees a guest",
    size: "3 people",
    draft: { name: "Saturday dinner", people: [P.alpha(), P.beta(), P.sam()], sponsor: "Alpha Morgan", speaksUp: "attentive", introduced: false, start: [] },
  },
  {
    id: "only-you",
    needs: 0,
    title: "Only you on Context",
    says: "Alpha and two friends without accounts",
    size: "3 people",
    draft: { name: "Saturday hike", people: [P.alpha(), P.sam(), P.priya()], sponsor: "Alpha Morgan", speaksUp: "attentive", introduced: false, start: [] },
  },
  {
    id: "invited",
    needs: 1,
    title: "Guest invited by number",
    says: "Priya has no account but an invite to Lumio",
    size: "3 people",
    draft: { name: "Lumio launch, with Priya", people: [P.alpha(), P.beta(), P.priya({ slug: "lumio", role: "member" })], sponsor: "Alpha Morgan", speaksUp: "attentive", introduced: false, start: [] },
  },
  {
    id: "owners",
    needs: 3,
    title: "Different owners",
    says: "Each person owns or edits a different workspace",
    size: "4 people",
    draft: {
      name: "Four workspaces",
      people: [P.alpha({ lumio: "owner" }), P.beta({ "maison-solenne": "owner", lumio: "editor" }), P.gamma({ "common-ground": "owner", lumio: "editor" }), P.delta({ lumio: "editor", "maison-solenne": "editor", "common-ground": "editor" })],
      sponsor: "Alpha Morgan",
      speaksUp: "attentive",
      introduced: false,
      start: [],
    },
  },
  {
    id: "going",
    needs: 0,
    title: "Tex dropped into a chat already going",
    says: "Starts after 12 texts about Saturday's dinner",
    size: "3 people",
    draft: { name: "Saturday dinner", people: [P.delta(), P.alpha(), P.beta()], sponsor: "Delta Brooks", speaksUp: "followAlong", introduced: false, start: DINNER },
  },
  {
    id: "joins",
    needs: 0,
    title: "Someone joins who isn't a member",
    says: "Sam is added after Tex has answered once",
    size: "3, then 4",
    draft: { name: "Saturday dinner", people: [P.delta(), P.alpha(), P.beta()], sponsor: "Delta Brooks", speaksUp: "followAlong", introduced: false, start: DINNER.slice(0, 2), then: P.sam() },
  },
];

/** A person's roles and invitation moved onto the workspaces here, by place; one with no workspace in its place has none. */
function placedPerson(p: WorldPerson): WorldPerson {
  const roles = Object.fromEntries(Object.entries(p.roles ?? {}).flatMap(([slug, role]) => (placed(slug) ? [[placed(slug), role]] : [])));
  const inv = p.invited && placed(p.invited.slug) ? { slug: placed(p.invited.slug) as Slug, role: p.invited.role } : null;
  if (p.account === "invited" && !inv) return { name: p.name, account: "off" };
  return { name: p.name, account: p.account, ...(p.account === "on" ? { roles } : {}), ...(inv ? { invited: inv } : {}) };
}

/** How many workspaces a scenario needs to be what it says: fewer here and the picker offers it disabled. */
export const scenarioNeeds = (id: string): number => SCENARIOS.find((x) => x.id === id)?.needs ?? 0;

/** A scenario's setup, copied so the setup can change it, on the workspaces here. */
export const scenarioDraft = (id: string): WorldDraft | null => {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) return null;
  const d = JSON.parse(JSON.stringify(s.draft)) as WorldDraft;
  return { ...d, name: placedWords(d.name), people: d.people.map(placedPerson), ...(d.then ? { then: placedPerson(d.then) } : {}), preset: s.title };
};

/** A blank setup: "+ New group chat…". */
export const blankDraft = (): WorldDraft => ({ name: "", people: [P.alpha({}), P.beta({})], sponsor: "Alpha Morgan", speaksUp: "attentive", introduced: false, start: [] });

/** Made-up people the Add someone popover offers, besides the ones here, on the workspaces here. */
export const otherPeople = (): WorldPerson[] => [P.alpha(), P.beta(), P.gamma(), P.delta(), P.sam(), P.priya()].map(placedPerson);

/** A stand-in number for the setup's name cell (555-01XX: the chat gives each person their own). */
export const standInNumber = (i: number) => `555-01${String(40 + ((i * 7) % 60)).padStart(2, "0")}`;
