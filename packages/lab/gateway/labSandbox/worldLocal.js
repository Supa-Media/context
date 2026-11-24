/**
 * MADE-UP GROUP CHATS ON MAIN (Dev, 2026-11-24: "and cant i just test reg? why does it have to be a pr", then "test
 * main": the people kept in the chat).
 *
 * On a pull request's preview a made-up chat's people are made in the preview's control plane (`world.js`). Here,
 * on the deployment the Lab runs on, nobody is made: the people live only in the test chat, each with a role in some of
 * the Lab user's own shared workspaces, and every text asks the control plane what a real chat of these people would
 * reach (`apps/convex/functions/lib/texLabWorldReach.ts`, by the rule real chats keep). The turn runs on the Lab user's
 * own token with that narrowed session, as every test chat on main does, so it can only ever reach less than the Lab
 * user's 1:1 test chat does. The chat object's group question (`/agent-texts/group`) is answered here, from the people
 * in the chat now, with Tex's one introduction kept in the chat object's storage.
 */

/** Whether made-up people are made on this deployment (a preview), and the workspaces they can be given roles in. */
export async function worldPlace(controlPlane, token) {
  const answer = await controlPlane.labSandbox(token, "worldWorkspaces", {});
  if (answer === null) return { error: [503, "the control plane did not answer"] };
  if (answer.status !== "ok") return { error: [403, answer.error ?? "Made-up group chats are for the Lab's developers."] };
  return { preview: answer.preview === true, slugs: (answer.workspaces ?? []).map((w) => w.slug), workspaces: answer.workspaces ?? [] };
}

const handleOf = (name) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "person";

/**
 * The chat's people with the numbers and handles a test chat names them by: a person on Context has a handle, made
 * from their name and never one anyone else here has (as a name or a handle); a guest and a person invited by number
 * have only a number. Someone who was here before keeps theirs. `{ people }`, as `makeWorld` answers.
 */
export async function localPeople(asked, before = []) {
  const assigned = new Set();
  const people = [];
  for (const [i, person] of asked.entries()) {
    const kept = before.find((p) => p.name === person.name);
    let handle = null;
    if (person.account === "on") {
      // Nobody else's name or handle here: a guest's name is how the chat names them.
      const others = new Set([...asked.filter((p) => p !== person).map((p) => p.name.toLowerCase()), ...assigned]);
      const base = kept?.account === "on" && kept.handle ? kept.handle : handleOf(person.name);
      handle = base;
      for (let n = 2; others.has(handle); n += 1) handle = `${base}-${n}`;
      assigned.add(handle);
    }
    // Numbers in the range kept for fiction (555-01xx), one per place in the chat's list, kept by someone back again.
    const phone = kept?.phone ?? `+1212555${String(100 + i).padStart(4, "0")}`;
    people.push({ ...person, phone, handle });
  }
  return { people };
}

/** The made-up chat's key: a hash of its own group id, so it names no real chat. */
export async function localGroupKey(groupId) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`lab-world:${groupId}`)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The people in the chat now, as the control plane is asked about them. */
export function hereNow(about) {
  const left = new Set(about.world?.left ?? []);
  return (about.world?.people ?? []).filter((p) => !left.has(p.name)).map(({ name, account, roles, invited }) => ({ name, account, ...(roles ? { roles } : {}), ...(invited ? { invited } : {}) }));
}

/**
 * The session a made-up chat's text runs on here: the Lab user's own, narrowed to what these people's chat reaches.
 * Asked again on every text, so a join or a leave changes it. Answers as the `session` action does, with what the chat
 * reached kept on `chat.world` for the reply row.
 */
export async function localSession(controlPlane, token, about) {
  // The chat's own group id: the control plane works its key out from it (the same as `localGroupKey`), never from us.
  const answer = await controlPlane.labSandbox(token, "worldReach", { chat: about.world?.groupId, people: hereNow(about) });
  if (answer === null) return { status: "unavailable", error: "the control plane did not answer" };
  if (answer.status !== "ok") return answer;
  return { status: "ok", session: answer.session, chat: { world: { reach: answer.reach ?? [], blocked: answer.blocked ?? [] } } };
}

/** Where a made-up chat on main keeps that Tex has introduced itself, in its chat object's storage. */
export const WORLD_INTRO_KEY = "lab:worldIntro";

/**
 * The chat object's group question in a made-up chat here: the Lab's own answer (`controlSwitch.js`, from the people
 * and numbers in the chat now) with what the chat reaches, how Tex speaks up, and its one introduction. What the
 * answer said is kept on `grant.last`, which the reply row shows. Anything else is the Lab's own answer.
 */
export function localControl({ about, chat, grant, storage }) {
  return async (path, body, own) => {
    if (path !== "/agent-texts/group" || body?.command !== undefined) return undefined;
    const speaksUp = about.world?.speaksUp;
    // "Off" is a muted chat, as the control plane answers one (`textGroups.ts`).
    const answer = speaksUp === "off" ? { status: "muted" } : await own(path, body);
    if (answer?.status !== "ready") return answer;
    const introduced = about.world?.introduced === true || (await storage.get(WORLD_INTRO_KEY)) === true;
    if (!introduced) await storage.put(WORLD_INTRO_KEY, true);
    const reach = chat?.world?.reach ?? [];
    const out = { ...answer, intro: !introduced, ...(speaksUp ? { engagement: speaksUp, engagementChosen: true } : {}) };
    grant.asked = [...(grant.asked ?? []), { path, status: out.status, ...(out.intro ? { intro: true } : {}) }].slice(-8);
    grant.last = { ...(grant.failures ? { failed: grant.failures } : {}), path, status: out.status, reach, blocked: chat?.world?.blocked ?? [], intro: out.intro || grant.last?.intro === true, guests: (out.guests ?? []).map((g) => g.label), asked: grant.asked };
    return out;
  };
}
