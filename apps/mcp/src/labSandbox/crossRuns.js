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
 *
 * The trip is two more turns after the asking one, so it runs in the asking test chat's own object (`cross.carry`),
 * whose `waitUntil` keeps it for up to 15 minutes: a Worker stops a request's `waitUntil` 30 s after it answers, which
 * cut the answer's run short in production (2026-11-17, sandbox run t1794925338233000003: sent, never finished). The
 * caller's token rides in that one call and is held in memory for the trip only, never stored.
 */

import { callSandbox, sandboxStub } from "./object.js";
import { RUNNING_STALE_MS } from "./harness.js";
import { createControlPlane } from "../controlPlane.js";

const CHAT_KEY = /^[0-9a-f]{64}$/;
const SANDBOX_ID = /^[0-9a-f]{16}$/;

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

/** `followCross` after a test row's run (`done`, its `{ cross }`), its outcome kept on the asking reply row. Never throws. */
export async function carryCross(done, asker, deps) {
  try {
    const carried = await followCross(done?.cross, asker, deps);
    if (carried.length > 0) await callSandbox(asker.stub, "row.patch", { id: asker.replyId, patch: { cross: carried } });
  } catch {
    /* the asking run's own row stands; what did not run shows as not run */
  }
}

/**
 * What `followCross` needs of the route: a group's linked test chat (opened once on that chat, kept with the asking
 * test chat as `linked:<key>`, and only for a group the caller is in now), and a run of a row in a test chat, claimed
 * and counted as a sent text is. `open` is the route's own open of a test chat, `count` its daily count of sent texts.
 */
export function crossDeps({ env, controlPlane, token, who, origin, runTurn, config, asker, open, newRow, count }) {
  const sessionOf = async (chat) => {
    const answer = await controlPlane.labSandbox(token, "session", { chat });
    return answer?.status === "ok" ? answer : null;
  };
  return {
    newRow,
    linked: async (key) => {
      const listed = (Array.isArray(who.chats) ? who.chats : []).find((chat) => chat?.key === key);
      if (!CHAT_KEY.test(key) || !listed) return null;
      const session = await sessionOf(key);
      if (session === null) return null;
      const kept = (await callSandbox(asker.stub, "state", {})).meta?.[`linked:${key}`];
      let sandboxId = typeof kept === "string" && SANDBOX_ID.test(kept) && (await callSandbox(sandboxStub(env, who.userId, kept), "exists", {})).exists ? kept : null;
      if (sandboxId === null) {
        const opened = await (await open(env, controlPlane, token, who, { source: "chat", chatId: key, versionId: asker.about.versionId, by: "cross-chat ask" }, origin)).json();
        if (typeof opened?.sandboxId !== "string") return null;
        sandboxId = opened.sandboxId;
        await callSandbox(asker.stub, "meta", { key: `linked:${key}`, value: sandboxId });
      }
      const stub = sandboxStub(env, who.userId, sandboxId);
      const about = (await callSandbox(stub, "state", {})).meta?.chat;
      return about ? { stub, about: { ...about, name: String(listed.name ?? "the group") }, sandboxId, payload: session.session, chat: session.chat ?? null } : null;
    },
    run: async (target, row, inbound) => {
      if (!(await count(`sends:${new Date().toISOString().slice(0, 10)}`)).ok) return null;
      if (!(await callSandbox(target.stub, "claim", { msgId: row.id, staleMs: RUNNING_STALE_MS })).ok) return null;
      await callSandbox(target.stub, "row.add", { row });
      return await runTurn({ env, stub: target.stub, about: target.about, row, payload: target.payload, token, config, origin, chat: target.chat, inbound });
    },
  };
}

/** The asking test chat as the object is told it: everything but its stub, which the object finds by its own id. */
const askerOf = ({ stub: _stub, ...asker }) => asker;

/**
 * `followCross` with the route's own pieces (`route.js` `open`, `newIds` and its turn), its outcome kept on the asking
 * reply row. `carry` is `{ env, controlPlane, token, who, origin, config, asker }`; `max` is the daily count of sent
 * texts (`route.js` `DAILY_SENDS`). Never throws.
 */
export async function carryFrom(done, carry, { open, newRow, runTurn, max }) {
  const { env, who, asker } = carry;
  const count = (key) => callSandbox(sandboxStub(env, who.userId, "index0000000000"), "count", { key, max });
  await carryCross(done, asker, crossDeps({ ...carry, runTurn, open, newRow, count }));
}

/**
 * Hands a turn's asks (`done.cross`) to the asking test chat's object, which carries them after this request is gone
 * (`objectCarry`); an object that cannot keep them leaves them to this request (`fallback`, `carryFrom`'s pieces).
 * Nothing to carry asks nothing. Never throws.
 */
export async function carryInObject(done, carry, fallback) {
  const { token, who, origin, config, asker } = carry;
  if (!(Array.isArray(done?.cross) && done.cross.some((out) => out?.path === "/cross-ask"))) return;
  if (asker?.about?.shared === true) return;
  const holder = { userId: who.userId, chats: Array.isArray(who.chats) ? who.chats : [] };
  const handed = await callSandbox(asker.stub, "cross.carry", { cross: done.cross, token, who: holder, origin, config, asker: askerOf(asker) }).catch(() => null);
  if (handed?.carrying !== true) await carryFrom(done, carry, fallback);
}

/**
 * The object's side of `cross.carry`: the trip, kept running by the object (`state.waitUntil`) and answered at once.
 * `pieces()` loads the route's `open`, `newIds` and `DAILY_SENDS` and the turn (`chatRun.js` `runTestText`) when asked, since the
 * route imports the object. Answers `{ carrying }`.
 */
export function objectCarry(env, state, body, pieces) {
  const { cross, token, who, origin, config, asker } = body ?? {};
  if (!Array.isArray(cross) || typeof token !== "string" || typeof who?.userId !== "string" || typeof asker?.sandboxId !== "string" || typeof state?.waitUntil !== "function") return { carrying: false };
  const stub = sandboxStub(env, who.userId, asker.sandboxId);
  if (stub === null) return { carrying: false };
  const trip = (async () => {
    const { open, newIds, runTurn, max } = await pieces();
    await carryFrom({ cross }, { env, controlPlane: createControlPlane(env), token, who, origin, config, asker: { ...asker, stub } }, { open, newRow: newIds, runTurn, max });
  })().catch(() => {});
  state.waitUntil(trip);
  return { carrying: true };
}

/**
 * A test row's whole run, handed to the test chat's own object (`text.run`), which keeps it (`state.waitUntil`) after
 * the request that sent the text has answered: its turn, every background job it starts (up to `jobs.js`
 * `JOB_LIMIT_MS`), and its asks of other chats. A Worker stops a request's `waitUntil` 30 s after it answers, which cut
 * every job longer than that short in production (2026-11-17, jobs j6401134c and j25f68f92: `carry_on`, then nothing).
 * The caller's token rides in this one call and is held in memory for the run only, never stored. Answers whether the
 * object took it; one that did not leaves the run to the request (`addRow`). Never throws.
 */
export async function runInObject(turn, carry) {
  const { token, who, origin, config, asker } = carry;
  const holder = { userId: who.userId, chats: Array.isArray(who.chats) ? who.chats : [] };
  const handed = await callSandbox(asker.stub, "text.run", { turn, token, who: holder, origin, config, asker: askerOf(asker) }).catch(() => null);
  return handed?.running === true;
}

/**
 * The object's side of `text.run`: the turn (`pieces().runTurn`, `chatRun.js` `runTestText`), then its asks of other
 * chats carried here too (`carryFrom`), kept running by the object and answered at once. `turn` is the run's
 * `{ about, row, payload, chat }`. Answers `{ running }`.
 */
export function objectRun(env, state, body, pieces) {
  const { turn, token, who, origin, config, asker } = body ?? {};
  if (typeof turn?.row?.id !== "string" || typeof turn?.about !== "object" || turn.about === null || typeof token !== "string" || typeof who?.userId !== "string" || typeof asker?.sandboxId !== "string" || typeof state?.waitUntil !== "function") return { running: false };
  const stub = sandboxStub(env, who.userId, asker.sandboxId);
  if (stub === null) return { running: false };
  const run = (async () => {
    const { open, newIds, runTurn, max } = await pieces();
    const controlPlane = createControlPlane(env);
    const done = await runTurn({ env, stub, about: turn.about, row: turn.row, payload: turn.payload, token, config, origin, chat: turn.chat ?? null });
    await carryFrom(done, { env, controlPlane, token, who, origin, config, asker: { ...asker, stub } }, { open, newRow: newIds, runTurn, max });
  })().catch((error) => console.log(JSON.stringify({ event: "lab_sandbox_object_run", ok: false, reason: String(error?.name ?? "error").slice(0, 40) })));
  state.waitUntil(run);
  return { running: true };
}
