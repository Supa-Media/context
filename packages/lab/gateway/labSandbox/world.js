/**
 * MADE-UP GROUP CHATS (Dev, 2026-11-24: "a place in labs where I can test out all these things and simulate a fake
 * group chat", with everyone on Context, a mix of people on Context and not, guests invited by number, different
 * workspace owners and Tex dropped into a chat already going; approved artboards in the project's
 * `group-chat-sim-artboards/`).
 *
 * `open { source: "world", world: { people, sponsor?, speaksUp?, introduced?, name?, start? } }` opens a test chat with
 * made-up people. It runs only on a pull request's preview: the control plane makes the people there
 * (`apps/convex/functions/texLabWorld.ts`, which refuses anywhere else), and every group question the chat object asks
 * the control plane (`/agent-texts/group`: who is here, what the chat reaches, who keeps a workspace out, who brought
 * Tex in, the one introduction) goes to the preview's real control plane, so Tex's real group rules decide. A turn then
 * runs on the grant that answer minted, with the test chat's sandboxed store: its reads are the preview's made-up
 * workspaces, and its writes stay in the test chat as every test chat's do.
 *
 * Everything else about the test chat (rows, the line's delays, steps, Retry, Back, Drop) is the ordinary test chat's.
 * `join` and `leave` change who is in the chat, as a real chat's people change: the next text carries the new list, and
 * the control plane is asked again with it.
 */

import { createControlPlane } from "../fromGateway/controlPlane.js";

export const WORLD_SOURCE = "world";
/** The seeded shared workspaces made-up people can be in (`texLabWorld.ts` `WORLD_WORKSPACES`). */
export const WORLD_WORKSPACES = Object.freeze(["lumio", "maison-solenne", "common-ground"]);
export const WORLD_SPEAKS_UP = Object.freeze(["off", "quiet", "attentive", "followAlong", "helpful"]);
export const MAX_WORLD_PEOPLE = 8;
/** Earlier texts a made-up chat may start from: said before Tex was added, so no turn runs on them. */
export const MAX_START = 40;
const ROLES = new Set(["owner", "editor", "member"]);
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} .'\-]{0,39}$/u;
/** Control-plane routes a made-up chat keeps answered by the Lab: the judge's meter and the old-number setting. */
const LAB_ANSWERED = new Set(["/agent-texts/decide/gate", "/agent-texts/decide/usage", "/agent-texts/old-line"]);

/** One person as the Lab asks for them, checked, or `{ error }`. */
function personOf(raw) {
  const name = typeof raw?.name === "string" ? raw.name.replace(/\s+/g, " ").trim() : "";
  if (!NAME.test(name)) return { error: "each person needs a name: letters, numbers, spaces, . ' - (at most 40)" };
  const account = raw?.account ?? "on";
  if (!["on", "off", "invited"].includes(account)) return { error: `${name}'s account is "on", "off" or "invited"` };
  const roles = {};
  for (const [slug, role] of Object.entries(raw?.roles ?? {})) {
    if (!WORLD_WORKSPACES.includes(slug)) return { error: `no made-up workspace is called ${slug}: ${WORLD_WORKSPACES.join(", ")}` };
    if (role === null || role === undefined || role === "" || role === "none") continue;
    if (!ROLES.has(role)) return { error: `${name}'s role in ${slug} is owner, editor or member` };
    roles[slug] = role;
  }
  if (account !== "on" && Object.keys(roles).length > 0) return { error: `${name} isn't on Context, so has no role in a workspace` };
  if (account === "invited") {
    const slug = raw?.invited?.slug;
    const role = raw?.invited?.role ?? "member";
    if (!WORLD_WORKSPACES.includes(slug) || !["editor", "member"].includes(role)) return { error: `${name} is invited by number: name the workspace (invited: { slug, role })` };
    return { person: { name, account, invited: { slug, role } } };
  }
  return { person: { name, account, ...(account === "on" ? { roles } : {}) } };
}

/** What `open` asks for a made-up chat, checked whole: `{ world }` or `{ error }`. */
export function worldInput(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { error: "world is { people: [{ name, account, roles?, invited? }], sponsor?, speaksUp?, introduced?, name?, start? }" };
  if (!Array.isArray(raw.people) || raw.people.length < 1 || raw.people.length > MAX_WORLD_PEOPLE) return { error: `a made-up chat has 1 to ${MAX_WORLD_PEOPLE} people besides Tex` };
  const people = [];
  const names = new Set();
  for (const given of raw.people) {
    const read = personOf(given);
    if (read.error) return read;
    const key = read.person.name.toLowerCase();
    if (["tex", "context", "you"].includes(key)) return { error: `"${read.person.name}" is Tex's or the Lab's name` };
    if (names.has(key)) return { error: `two people are called ${read.person.name}` };
    names.add(key);
    people.push(read.person);
  }
  let sponsor;
  if (raw.sponsor !== undefined && raw.sponsor !== null) {
    sponsor = typeof raw.sponsor === "number" ? raw.sponsor : people.findIndex((p) => p.name.toLowerCase() === String(raw.sponsor).toLowerCase());
    if (!Number.isInteger(sponsor) || sponsor < 0 || sponsor >= people.length || people[sponsor].account !== "on") return { error: "sponsor (who brought Tex in) is someone here on Context" };
  }
  if (raw.speaksUp !== undefined && !WORLD_SPEAKS_UP.includes(raw.speaksUp)) return { error: `speaksUp is ${WORLD_SPEAKS_UP.join(", ")}` };
  const start = [];
  for (const line of Array.isArray(raw.start) ? raw.start.slice(0, MAX_START) : []) {
    const who = people.find((p) => p.name.toLowerCase() === String(line?.as ?? "").trim().toLowerCase());
    const text = typeof line?.text === "string" ? line.text.trim().slice(0, 2_000) : "";
    if (who === undefined || text === "") return { error: "each start line is { as: a person here, text }" };
    start.push({ as: who.name, text });
  }
  const name = typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.replace(/\s+/g, " ").trim().slice(0, 60) : people.map((p) => p.name).join(", ");
  return { world: { people, ...(sponsor !== undefined ? { sponsor } : {}), ...(raw.speaksUp ? { speaksUp: raw.speaksUp } : {}), introduced: raw.introduced === true, name, start } };
}

/** The test chat's people as the rows name them: an account's handle, else their name. */
export const speakerKey = (person) => (typeof person.handle === "string" && person.handle !== "" ? person.handle : person.name);

/**
 * Asks the preview's control plane to make the chat's people (or bring them up to date), and answers them with their
 * numbers and handles: `{ people, groupKey }` or `{ error: [status, words] }`.
 */
export async function makeWorld(controlPlane, token, { sandboxId, line, groupId, world }) {
  const key = (sandboxId + sandboxId).slice(0, 32);
  const answer = await controlPlane.labSandbox(token, "world", { key, line, groupId, people: world.people, ...(world.sponsor !== undefined ? { sponsor: world.sponsor } : {}), ...(world.speaksUp ? { speaksUp: world.speaksUp } : {}), introduced: world.introduced === true });
  if (answer === null) return { error: [503, "the control plane did not answer"] };
  if (answer.status !== "ok") return { error: [answer.status === "bad_request" ? 400 : 403, answer.error ?? "Made-up group chats run only on a pull request's preview: set Code to #<PR>."] };
  const people = (answer.people ?? []).map((p, i) => ({ ...world.people[i], phone: p.phone, handle: p.handle ?? null }));
  return { people, groupKey: answer.groupKey };
}

/** `about` for a made-up chat, beside what every test chat keeps. */
export function worldAbout({ sandboxId, made, world, groupId }) {
  return {
    chat: `world:${sandboxId}`,
    kind: "group",
    owner: `world:${sandboxId}`,
    ledgerChat: made.groupKey,
    chatKey: made.groupKey,
    people: made.people.map((p) => ({ handle: speakerKey(p), name: p.name, account: p.account })),
    world: { name: world.name, groupId, groupKey: made.groupKey, introduced: world.introduced === true, ...(world.sponsor !== undefined ? { sponsor: world.sponsor } : {}), ...(world.speaksUp ? { speaksUp: world.speaksUp } : {}), people: made.people, left: [] },
  };
}

/** Rows for the texts said before Tex was added: shown in the chat, never run, never in Tex's memory. */
export function startRows(world, people, at, ids) {
  return world.start.map((line, i) => {
    const person = people.find((p) => p.name === line.as);
    const { id, eid } = ids(at - (world.start.length - i) * 60_000);
    return { id, eid, who: speakerKey(person), text: line.text, at: at - (world.start.length - i) * 60_000, prod: true, before: true };
  });
}

/** Whoever a made-up chat's text is from: a person here by handle or name; `{ speaker }` or `{ error }`. */
export function worldSpeaker(about, as) {
  const here = (about.world?.people ?? []).filter((p) => !(about.world.left ?? []).includes(p.name));
  if (typeof as !== "string" || as.trim() === "") return here.length > 0 ? { speaker: speakerKey(here[0]) } : { error: [400, "nobody is in this chat"] };
  const asked = as.trim().toLowerCase();
  const person = here.find((p) => p.name.toLowerCase() === asked || (p.handle ?? "").toLowerCase() === asked);
  if (person === undefined) return { error: [400, `${as.trim()} isn't in this chat: add them first (join)`] };
  return { speaker: speakerKey(person) };
}

/** A made-up chat's addresses: Tex's line, the chat's group id, and the numbers of the people in it now. */
export function worldAddress(about, lineNumber) {
  const left = new Set(about.world.left ?? []);
  const phones = new Map(about.world.people.filter((p) => !left.has(p.name)).map((p) => [speakerKey(p), p.phone]));
  return { line: lineNumber, chatId: about.world.groupId, groupId: about.world.groupId, phones };
}

/**
 * The control plane for a made-up chat's object: its group questions go to the preview's real control plane, with the
 * same secret the chat object uses there (`packages/tex/gateway/texChat.js` `chatEnv`). A grant it mints is kept for
 * the turn (`grant`), and the chat object is handed the test text's own token in its place, so the turn still comes
 * back through the test chat. `null` for a route the Lab answers itself.
 */
export function worldControl(env, grant, labToken, fetchImpl = (input, init) => fetch(input, init)) {
  const base = typeof env?.CONTROL_PLANE_URL === "string" ? env.CONTROL_PLANE_URL.replace(/\/+$/, "") : "";
  const secret = typeof env?.AGENT_WORKER_SECRET === "string" ? env.AGENT_WORKER_SECRET : "";
  return async (path, body) => {
    if (!path.startsWith("/agent-texts/") || LAB_ANSWERED.has(path)) return undefined;
    if (base === "" || secret === "") return { status: "refused" };
    const response = await fetchImpl(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify(body ?? {}) });
    const answer = await response.json().catch(() => null);
    if (answer === null || typeof answer !== "object") return { status: "refused" };
    grant.last = { path, status: answer.status ?? null, reach: answer.reach ?? [], blocked: answer.blocked ?? [], intro: answer.intro === true, guests: (answer.guests ?? []).map((g) => g.label) };
    if (typeof answer.accessToken !== "string") return answer;
    grant.token = answer.accessToken;
    grant.payload = null;
    return { ...answer, accessToken: labToken };
  };
}

/** The session a made-up chat's turn runs on: the one its grant's token resolves to on the preview. */
export async function worldPayload(env, grant) {
  if (typeof grant.token !== "string") return null;
  if (grant.payload) return grant.payload;
  grant.payload = await createControlPlane(env).resolveSession(grant.token);
  return grant.payload;
}

/**
 * `join { name, account?, roles?, invited? }` and `leave { name }`: who is in the chat changes, as a real chat's people
 * change. A newcomer is made on the preview first; the change is a row the chat shows ("Sam was added"), and the next
 * text carries the new list. `{ chat, row }` or `{ error }`.
 */
export async function changePeople({ controlPlane, token, about, input, newRow }) {
  if (about.source !== WORLD_SOURCE) return { error: [400, "only a made-up group chat's people can change"] };
  const world = about.world;
  const left = new Set(world.left ?? []);
  const by = worldSpeaker(about, input.as);
  if (input.op === "leave") {
    const name = String(input.name ?? "").trim().toLowerCase();
    const person = world.people.find((p) => p.name.toLowerCase() === name && !left.has(p.name));
    if (person === undefined) return { error: [404, `${input.name} isn't in this chat`] };
    if (world.people.length - left.size <= 1) return { error: [400, "the last person here can't leave"] };
    const chat = { ...about, world: { ...world, left: [...left, person.name] } };
    return { chat, row: { ...newRow(), who: "Lab", kind: "people", text: `${person.name} left the conversation`, change: "left", name: person.name } };
  }
  const read = personOf({ ...input, name: input.name });
  if (read.error) return { error: [400, read.error] };
  const back = world.people.find((p) => p.name.toLowerCase() === read.person.name.toLowerCase());
  if (back !== undefined && !left.has(back.name)) return { error: [400, `${back.name} is already here`] };
  if (world.people.length >= MAX_WORLD_PEOPLE && back === undefined) return { error: [400, `a made-up chat has at most ${MAX_WORLD_PEOPLE} people`] };
  const asked = back === undefined ? [...world.people.map(({ phone: _p, handle: _h, ...p }) => p), read.person] : world.people.map(({ phone: _p, handle: _h, ...p }) => (p.name === back.name ? read.person : p));
  const made = await makeWorld(controlPlane, token, { sandboxId: about.sandboxId, line: lineNumberOf(about), groupId: world.groupId, world: { ...world, people: asked } });
  if (made.error) return made;
  const chat = { ...about, people: made.people.map((p) => ({ handle: speakerKey(p), name: p.name, account: p.account })), world: { ...world, people: made.people, left: [...left].filter((n) => n !== read.person.name) } };
  const adder = by.speaker ? (made.people.find((p) => speakerKey(p) === by.speaker)?.name ?? "Someone") : "Someone";
  return { chat, row: { ...newRow(), who: "Lab", kind: "people", text: `${adder} added ${read.person.name}`, change: "added", name: read.person.name } };
}

/** The line a made-up chat's group id is hashed with: Tex's line, as the turn's address carries it (`chatRun.js`). */
export const lineNumberOf = (about) => about?.line?.number ?? "";
