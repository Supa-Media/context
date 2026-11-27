/**
 * Guest names node "guestNames" (on the shelf, `texNodeShelf.json`; Dev2, 2026-11-27): after a group reply, the
 * chat's newest lines are read for the names the chat gives the people Tex knows only by number
 * (`guestNamePass.js`), and each one found is kept in the chat's ledger, where every turn reads names. Meant for a
 * `background` wire after Text them, so nobody waits for it. Only in a group chat with a ledger; one small model call,
 * and only when someone still unnamed spoke lately. Its output is counts, never a name.
 */
import { aiGatewayConfig } from "../../aiGateway.js";
import { guestHashes, nameGuestsFromChat } from "../../guestNamePass.js";
import { ledgerPlace, ONE_TO_ONE_CHAT } from "../../ledger.js";

export default async function guestNames(_input, io) {
  const t = io.ctx.turn ?? {};
  const place = ledgerPlace(t.session);
  if (t.group == null || place === null || place.chat === ONE_TO_ONE_CHAT || typeof t.store?.texLedger !== "function") return { outcome: "none" };
  try {
    // Members' handles and names (`groupNames.js` `namesOf`): no guest is given one of them.
    const handles = Array.isArray(t.group.people) ? t.group.people.filter((handle) => typeof handle === "string") : [];
    const names = Array.isArray(t.group.names) ? t.group.names.map((entry) => entry?.name).filter((name) => typeof name === "string") : [];
    const others = [...handles, ...names].filter((name) => name !== "" && !/^guest-/.test(name));
    const out = await nameGuestsFromChat({
      ledger: t.store.texLedger(place.owner.chat ?? null),
      chat: place.chat,
      config: aiGatewayConfig(t.env),
      metadata: { feature: "guest-names", workspace: String(t.session?.workspaceId ?? ""), client: "guestNames" },
      others,
      hashes: await guestHashes(t.group.numbers),
    });
    console.log(JSON.stringify({ event: "guest_names", ...out }));
    return out;
  } catch (error) {
    return { outcome: "failed", where: typeof error?.name === "string" ? error.name : "error" };
  }
}
