/**
 * A bench group chat's member cards (`docs/decisions/texting-assistant/member-cards.md`): each member's own
 * `tex/group-card.md`, when their bench workspace (or the conversation's world) has one, put where production keeps it,
 * a note in their own Tex object with its key in the desk's keys (`texStore/desk.js` `readCard`), and the chat's token
 * answered with every member's personal workspace, as the control plane names them (`lib/texIdentity/cards.ts`).
 *
 * A card here is written as the person's own Tex would write it from About me (`agent/groupCard.js`); the writer itself
 * is tested on its own. Without the `fd -> memberCards` wire nothing reads them, so main's runs are unchanged.
 */

import { GROUP_CARD_PATH } from "../../../packages/tex/gateway/agent/groupCard.js";
import { DESK_KEYS_KEY } from "../../../packages/tex/gateway/texStore/desk.js";
import { texBucket, texStoreStub } from "../../../packages/tex/gateway/texStore/wire.js";

const handleOf = (person) => person.toLowerCase().replace(/[^a-z0-9-]/g, "");

/** One stable note key per card, in the shape the desk accepts (`notes/<uuid v7>.md`). */
const cardKey = (i) => `notes/0190a1b2-c3d4-7e5f-8a9b-${String(i).padStart(12, "0")}.md`;

/** Seed the cards of `group`'s members and name them for `chatToken`. Answers the handles that have a card. */
export async function seedMemberCards({ bench, group, ids, env, controlPlane, chatToken }) {
  if (group === null || group === undefined || controlPlane?.memberCards?.homes === undefined) return [];
  const homes = [];
  const carded = [];
  for (const [i, handle] of [...group.people.keys()].entries()) {
    const own = bench.people.find((row) => row.personal && handleOf(row.person) === handle);
    const workspaceId = own === undefined ? undefined : ids.get(own.workspace);
    if (workspaceId === undefined) continue;
    homes.push({ handle, workspaceId });
    const text = bench.workspaces[own.workspace]?.files?.[GROUP_CARD_PATH];
    if (typeof text !== "string") continue;
    const bucket = texBucket(texStoreStub(env, { person: workspaceId }));
    const key = cardKey(i);
    await bucket.put(key, new TextEncoder().encode(text));
    await bucket.put(DESK_KEYS_KEY, new TextEncoder().encode(JSON.stringify({ v: 1, direct: { card: key } })));
    carded.push(handle);
  }
  controlPlane.memberCards.homes.set(chatToken, homes);
  return carded;
}
