/**
 * A benchmark group chat (a test's `group: <shared workspace>`, `world.mjs`): the group grant the texting Worker
 * uses (`context_texts_group`, bound to the chat by `texChatId`) on that workspace, and the chat's key, its members
 * and each sender as hex hashes, as the Worker sends them (`src/agent/groupTurn.js` `groupOf`). Every person
 * `people.md` puts in the workspace is a member; the test's person is the one who tags Tex.
 *
 * The grant holds the tagger's own role in the workspace, as production's asker reach does
 * (`apps/convex/functions/lib/textGroupReach.ts` `askerReach`): a member's tag reads the workspace and never writes it.
 * Until 2026-11-26 the bench raised a member to editor, so `groups.md` case 2 could never test the read-only chat.
 * `tag` names the chat's tokens apart when one world has several groups (a 1:1's groups, `crossWorld.mjs`).
 *
 * Answers `{ group, tagger, chatToken }` (`group.home`: its home's folder, `group.homeToken`: a grant on it alone): with no group named, `group` and `tagger` are null and the token is the
 * person's own texting one.
 */

import { createHash } from "node:crypto";

const hex = (words) => createHash("sha256").update(words).digest("hex");

/** A bench group's home folder in the pin, named as a chat's home is (`tex/groups/<words>`, letters and hyphens). */
export const benchHome = (name) => `tex/groups/bench-${String(name).toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 4).join("-") || "group"}`;

/** The tagger's role in the group's workspace, as `people.md` gives it: owner, editor or member, never raised. */
export const taggerRole = (role) => (role === "owner" || role === "editor" ? role : "member");

export async function benchGroup({ name, bench, person, rows, ids, own, controlPlane, token, tag = "" }) {
  if (typeof name !== "string" || name === "") return { group: null, tagger: null, chatToken: token };
  const members = bench.people.filter((row) => row.workspace === name).map((row) => row.person.toLowerCase().replace(/[^a-z0-9-]/g, ""));
  if (!ids.has(name) || members.length < 2 || !members.includes(person.toLowerCase())) throw new Error(`group: ${name} is not a shared workspace ${person} is in with someone else (people.md)`);
  const group = { key: hex(`bench-group:${name}`), members: hex([...members].sort().join(",")), people: new Map(members.map((handle) => [handle, { handle, who: hex(`bench-person:${handle}`) }])) };
  const who = `${person.toLowerCase().replace(/[^a-z]/g, "")}${String(tag).toLowerCase().replace(/[^a-z]/g, "")}`;
  const chatToken = `cat_group_${who}_${"0".repeat(24)}`;
  await controlPlane.addGrant({
    workspaceId: ids.get(name),
    role: taggerRole(rows.find((row) => row.workspace === name)?.role),
    userId: `user_bench_${own.workspace}`,
    accessToken: chatToken,
    scopes: ["context:read", "context:write"],
    clientId: "context_texts_group",
    texChatId: group.key,
    // Its home in the pin, as the control plane mints a chat's setup row (`liveGrants.ts` `groupSetupRow`): the chat's
    // memory, about-us note and pictures live there (`chatHome.js`).
    alsoMemberOf: [{ workspaceId: "ws_pinned", role: "editor", setupOnly: true, grantedNames: ["#reads-as-chat"], chatHome: benchHome(name) }],
  });
  // A home-only grant for the chat (`liveGrants.ts`), for what the bench keeps in the home as an earlier turn did
  // (`earlierPictures.mjs`): its one row is the home.
  const homeToken = `cat_home_${who}_${"0".repeat(24)}`;
  await controlPlane.addGrant({ workspaceId: "ws_pinned", role: "editor", userId: `user_bench_${own.workspace}`, accessToken: homeToken, scopes: ["context:read", "context:write"], clientId: "context_texts_group", grantedNames: ["#reads-as-chat"], homeOnly: true, chatHome: benchHome(name), texChatId: group.key });
  return { group: { ...group, home: benchHome(name), homeToken }, tagger: group.people.get(person.toLowerCase()) ?? null, chatToken };
}

/**
 * A case's `- shared here: calendar of @priya` / `mail of @priya` lines (`load.mjs`): whose calendar or mail the chat
 * was given, as the Worker names a share (`groupCalendar.js`, `groupMail.js`). The bench has one calendar and one
 * mailbox, so the share is that one under the member's name. `{ calendar, mail }`, each null when none is shared.
 */
export function chatShares({ group, shares = [], flags, mailbox = null }) {
  if (!group) return { calendar: null, mail: null };
  const of = (kind) => shares.filter((share) => share.kind === kind);
  const calendar = of("calendar").map((share) => ({ handle: share.handle, address: (flags.calendarAddress ??= `${share.handle}@calendar.bench.invalid`) }));
  const mail = of("mail").map((share) => ({ handle: share.handle, address: mailbox ?? `${share.handle}@bench.invalid` }));
  return { calendar: calendar.length > 0 ? calendar : null, mail: mail.length > 0 ? mail : null };
}

/**
 * The asker's own connected Gmail not yet shared with the chat, as the control plane names it on the group's ready
 * answer (`askerMail`, `apps/convex/functions/lib/textGroupMail.ts`): the bench's one mailbox is the test person's,
 * so only their own texts carry it. `null` when there is none to name.
 */
export function askerMailOf({ group, asker, mailbox = null, shared = null }) {
  if (!group || !asker || !mailbox) return null;
  return (shared ?? []).some((row) => row.address === mailbox) ? null : [mailbox];
}

/** A group chat's member cards, seeded where production keeps them (`memberCards.mjs`). */
export { seedMemberCards } from "./memberCards.mjs";
