/**
 * TEX ASKS TEX ACROSS CHATS, IN THE LAB (Dev2, 2026-11-17: "before saying you are done with a feature, make sure you
 * use the lab to test that it works"; the feature: `apps/agent/src/crossChat.ts`, `agent/crossChat.js`, decision
 * `docs/decisions/texting-assistant/cross-chat-asks.md`).
 *
 * A test text's turn that asks Tex in one of the person's group chats (`ask_chat`, through the Cross-chat gate) hands
 * the ask to its chat object, which sends it to the other chat's object as production does. In a test chat that object
 * is never the real one: `jobs.js` keeps what was sent (`crossOut`), and this carries it, after the asking turn is done:
 *
 *   1. the group's own linked test chat, opened once on the real chat's copy and kept for this test chat
 *      (`meta linked:<key>`), takes the ask as its chat object takes one (`/cross-ask`): a row naming the ask, and a run
 *      of its own (node "Another chat asks"), whose answer goes back instead of being texted there;
 *   2. that answer reaches this test chat's object (`/cross-answer`), which settles the ask and starts this chat's own
 *      run with it (node "Another chat asks", kind answer): a row naming who answered, and Tex's text to them.
 *
 * Every run is a test chat's run like any other (real models, real reads, writes kept in the test chat), so each shows
 * in the Lab and through `tex_dev` with its own run card; the asking text's reply row names the linked test chat and
 * both rows (`cross`). Nothing reaches the real group. One hop, as in production: an ask-run asks nobody. A chat shared
 * with the developers never asks: its person's groups are theirs.
 */

/** The most asks one test text's turn carries (production's gate allows one open ask per pair). */
export const MAX_CROSS = 3;

const text = (value, most) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, most) : "");

/**
 * Carries each ask `cross` holds (`runChatTurn`'s answer), never throwing. `asker` is the asking test chat:
 * `{ stub, about, sandboxId, replyId, payload, chat, config }`. `deps`:
 *   - `linked(key)`: the group's linked test chat, opened or kept: `{ stub, about, sandboxId, payload, chat }` or null;
 *   - `run(target, row, inbound)`: claims the target for `row`, adds it, and runs its turn (`runChatTurn`), answering
 *     its `{ cross }`; null when it could not start;
 *   - `newRow()`: a new row's `{ id, eid, at }`.
 */
export async function followCross(cross, asker, deps) {
  const asks = (Array.isArray(cross) ? cross : []).filter((out) => out?.path === "/cross-ask" && typeof out.body?.groupId === "string").slice(0, MAX_CROSS);
  if (asks.length === 0 || asker?.about?.shared === true) return [];
  const done = [];
  for (const ask of asks) {
    const linked = await deps.linked(ask.body.groupId).catch(() => null);
    if (linked === null) {
      done.push({ id: ask.body.id, outcome: "no_chat" });
      continue;
    }
    // The person asking, as they are in the group: their own handle when the group has them, else its first person.
    const handles = (linked.about.people ?? []).map((p) => p?.handle).filter((h) => typeof h === "string" && h !== "");
    const own = (asker.about.people ?? []).map((p) => p?.handle).find((h) => handles.includes(h));
    const who = own ?? handles[0] ?? "someone";
    const what = text(ask.body.what, 600);
    const askRow = { ...deps.newRow(), who, text: `(Tex in their 1:1 asks) ${what}`, prod: false, from: "cross", cross: { kind: "ask", sandboxId: asker.sandboxId, id: ask.body.id } };
    const asked = await deps.run(linked, askRow, (address) => ({
      path: "/cross-ask",
      body: { ...ask.body, groupId: address.groupId, line: address.line, asker: address.phones.get(who) ?? [...address.phones.values()][0] },
    })).catch(() => null);
    const back = (asked?.cross ?? []).find((out) => out?.path === "/cross-answer" && out.body?.id === ask.body.id);
    if (!back) {
      // Production would wait out its ten minutes and say it timed out; here what ran is shown, and nothing is made up.
      done.push({ id: ask.body.id, outcome: asked === null ? "not_run" : "no_answer", sandboxId: linked.sandboxId, ask: askRow.id });
      continue;
    }
    const name = text(linked.about.name ?? linked.chat?.name ?? "the group", 80) || "the group";
    const answer = (Array.isArray(back.body.texts) ? back.body.texts : []).map((t) => text(t, 1_000)).filter(Boolean).join(" ");
    const answerRow = { ...deps.newRow(), who: `Tex in ${name}`, text: `(${back.body.state === "answered" ? "answered" : "refused"}) ${answer || text(back.body.why, 300)}`.trim(), prod: false, from: "cross", cross: { kind: "answer", sandboxId: linked.sandboxId, id: ask.body.id } };
    const answered = await deps.run(asker, answerRow, () => ({ path: "/cross-answer", body: back.body })).catch(() => null);
    done.push({ id: ask.body.id, outcome: answered === null ? "answer_not_run" : "answered", sandboxId: linked.sandboxId, ask: askRow.id, answer: answerRow.id });
  }
  return done;
}
