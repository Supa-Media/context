/**
 * A benchmark group chat (a test's `group: <shared workspace>`, `world.mjs`): the group grant the texting Worker
 * uses (`context_texts_group`, bound to the chat by `texChatId`) on that workspace, and the chat's key, its members
 * and each sender as hex hashes, as the Worker sends them (`src/agent/groupTurn.js` `groupOf`). Every person
 * `people.md` puts in the workspace is a member; the test's person is the one who tags Tex.
 *
 * Answers `{ group, tagger, chatToken }`: with no group named, `group` and `tagger` are null and the token is the
 * person's own texting one.
 */

import { createHash } from "node:crypto";

const hex = (words) => createHash("sha256").update(words).digest("hex");

export async function benchGroup({ name, bench, person, rows, ids, own, controlPlane, token }) {
  if (typeof name !== "string" || name === "") return { group: null, tagger: null, chatToken: token };
  const members = bench.people.filter((row) => row.workspace === name).map((row) => row.person.toLowerCase().replace(/[^a-z0-9-]/g, ""));
  if (!ids.has(name) || members.length < 2 || !members.includes(person.toLowerCase())) throw new Error(`group: ${name} is not a shared workspace ${person} is in with someone else (people.md)`);
  const group = { key: hex(`bench-group:${name}`), members: hex([...members].sort().join(",")), people: new Map(members.map((handle) => [handle, { handle, who: hex(`bench-person:${handle}`) }])) };
  const chatToken = `cat_group_${person.toLowerCase().replace(/[^a-z]/g, "")}_${"0".repeat(24)}`;
  await controlPlane.addGrant({
    workspaceId: ids.get(name),
    role: rows.find((row) => row.workspace === name)?.role === "owner" ? "owner" : "editor",
    userId: `user_bench_${own.workspace}`,
    accessToken: chatToken,
    scopes: ["context:read", "context:write"],
    clientId: "context_texts_group",
    texChatId: group.key,
  });
  return { group, tagger: group.people.get(person.toLowerCase()) ?? null, chatToken };
}
