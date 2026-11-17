/**
 * A benchmark group chat (a test's `group: <shared workspace>`, `world.mjs`): the group grant the texting Worker
 * uses (`context_texts_group`, bound to the chat by `texChatId`) on that workspace, and the chat's key, its members
 * and each sender as hex hashes, as the Worker sends them (`src/agent/groupTurn.js` `groupOf`). Every person
 * `people.md` puts in the workspace is in the chat; the test's person is the one who tags Tex. The grant's role
 * there is the lowest role anyone in the chat holds (`textGroupReach.ts`), not the tagger's.
 *
 * Answers `{ group, tagger, chatToken }` (`group.home`: its home's folder, `group.homeToken`: a grant on it alone): with no group named, `group` and `tagger` are null and the token is the
 * person's own texting one.
 */

import { createHash } from "node:crypto";

const hex = (words) => createHash("sha256").update(words).digest("hex");

/** member < editor < owner, as `textGroupReach.ts` ranks a chat's roles. */
const ROLE_RANK = { member: 0, editor: 1, owner: 2 };

/**
 * The role a group chat holds in `workspace`: the lowest role anyone in the chat holds there
 * (`textGroupReach.ts` `lowest`). One member makes the chat read-only. The tagger's own role
 * does not raise it.
 */
export function groupRole(people, workspace) {
  const ranks = (people ?? []).filter((row) => row?.workspace === workspace && row.personal !== true && ROLE_RANK[row.role] !== undefined).map((row) => row.role);
  if (ranks.length === 0) return "member";
  return ranks.reduce((low, role) => (ROLE_RANK[role] < ROLE_RANK[low] ? role : low));
}

/** A bench group's home folder in the pin, named as a chat's home is (`tex/groups/<words>`, letters and hyphens). */
export const benchHome = (name) => `tex/groups/bench-${String(name).toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 4).join("-") || "group"}`;

export async function benchGroup({ name, bench, person, ids, own, controlPlane, token }) {
  if (typeof name !== "string" || name === "") return { group: null, tagger: null, chatToken: token };
  const members = bench.people.filter((row) => row.workspace === name).map((row) => row.person.toLowerCase().replace(/[^a-z0-9-]/g, ""));
  if (!ids.has(name) || members.length < 2 || !members.includes(person.toLowerCase())) throw new Error(`group: ${name} is not a shared workspace ${person} is in with someone else (people.md)`);
  const group = { key: hex(`bench-group:${name}`), members: hex([...members].sort().join(",")), people: new Map(members.map((handle) => [handle, { handle, who: hex(`bench-person:${handle}`) }])) };
  const chatToken = `cat_group_${person.toLowerCase().replace(/[^a-z]/g, "")}_${"0".repeat(24)}`;
  await controlPlane.addGrant({
    workspaceId: ids.get(name),
    role: groupRole(bench.people, name),
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
  const homeToken = `cat_home_${person.toLowerCase().replace(/[^a-z]/g, "")}_${"0".repeat(24)}`;
  await controlPlane.addGrant({ workspaceId: "ws_pinned", role: "editor", userId: `user_bench_${own.workspace}`, accessToken: homeToken, scopes: ["context:read", "context:write"], clientId: "context_texts_group", grantedNames: ["#reads-as-chat"], homeOnly: true, chatHome: benchHome(name), texChatId: group.key });
  return { group: { ...group, home: benchHome(name), homeToken }, tagger: group.people.get(person.toLowerCase()) ?? null, chatToken };
}
