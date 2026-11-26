/**
 * A BENCH 1:1's GROUP CHATS, AND TEX ASKING TEX IN THEM (`ask_chat`; `packages/tex/gateway/agent/crossChat.js`,
 * decision `docs/decisions/texting-assistant/cross-chat-asks.md`). The bench's half of what the Lab's test chats do
 * (`packages/lab/gateway/labSandbox/crossRuns.js`), in one world, through the real gateway:
 *
 *   - a test's `groups: band` gives the person's 1:1 their group chats: each its own group grant (`groupChat.mjs`), and
 *     the 1:1 token's list from the control plane (`texterGroups`, the stub's `memberCards.mjs`), so the 1:1's
 *     `ask_chat` and `group_chats` name them as production does; the 1:1's turns carry the Worker's `crossCounts`;
 *   - an ask the Cross-chat gate let go (`crossAsks` on the 1:1's reply) runs in the group's chat as the Worker starts
 *     it (`packages/tex/worker/crossChat.ts`: `event: "chat_ask"`, cause `cross_chat`, as the asker's tag), and its
 *     answer (`crossBack`) starts the 1:1's own run (`event: "chat_answer"`), which texts the person.
 *
 * One hop, as in production: the group's run has no `ask_chat`. Nothing here decides who may ask whom; the gateway's
 * gate does. Every scenario is invented (`bench/ai/workspaces/people.md`).
 */

import worker from "../src/index.js";
import { createWorkerCtx } from "../test/workerCtx.mjs";
import { benchGroup } from "./groupChat.mjs";
import { readStream, workerEvents } from "./workerWire.mjs";
import { realNow } from "./clock.mjs";
import { addSpend } from "./jobDelivery.mjs";

/** The most asks one conversation carries to another chat (the Lab's `MAX_CROSS` is per text). */
export const MAX_CROSS_ASKS = 2;

/** Where a 1:1's ask comes from, as the texting Worker names it to the other chat (`crossChat.ts`). */
const FROM_ONE = "their own 1:1 chat with you";

/** A group chat's name, as the control plane names a chat from its workspace: "band" is "Band". */
export const groupName = (workspace) => String(workspace).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** A test's `groups:` line: the shared workspaces whose chats the person's 1:1 is in, by name. */
export function groupNames(value) {
  return String(value ?? "").split(",").map((name) => name.trim()).filter(Boolean);
}

/**
 * The 1:1's group chats: a group grant for each, and the 1:1 token's list. `[]` when the test names none. Each chat is
 * `{ workspace, name, group, tagger, chatToken }`.
 */
export async function oneToOneGroups({ names, bench, person, rows, ids, own, controlPlane, token }) {
  const chats = [];
  for (const workspace of names) {
    const { group, tagger, chatToken } = await benchGroup({ name: workspace, bench, person, rows, ids, own, controlPlane, token, tag: workspace });
    chats.push({ workspace, name: groupName(workspace), group, tagger, chatToken });
  }
  if (chats.length > 0) {
    controlPlane.memberCards.groups.set(
      token,
      chats.map((chat) => ({ key: chat.group.key, name: chat.name, people: [...chat.group.people.keys()].filter((handle) => handle !== chat.tagger.handle), lastSeenAt: 0 })),
    );
  }
  return chats;
}

/**
 * What the 1:1's turns send and how its asks are carried. `text(message, attachments, options)` is the world's own
 * 1:1 turn (`world.mjs`), `spent(from)` its spend since a report count, `reports()` that count now.
 */
export function crossChats({ env, chats, text, spent, reports }) {
  const open = new Set(); // the pairs with an ask out, as the Worker holds them (`crossChat.ts` `crossCounts`)
  let asked = 0;
  const events = new Map(chats.map((chat) => [chat.group.key, workerEvents({ env, token: chat.chatToken, group: chat.group })]));
  const unanswered = new Map(chats.map((chat) => [chat.group.key, []])); // each group's texts since Tex last spoke there, as the Worker sends them (`groupModelTurn.ts` `group.chat`)
  const byWorkspace = (workspace) => chats.find((chat) => chat.workspace === workspace) ?? null;
  const byKey = (key) => chats.find((chat) => chat.group.key === key) ?? null;

  return {
    on: chats.length > 0,
    /** The Worker's counts on a 1:1 text (`body.crossCounts`), or nothing when the person has no groups. */
    counts: () => (chats.length > 0 ? { crossCounts: { hour: asked, day: asked, open: [...open] } } : {}),

    /** What was said in one of the person's groups before the test (`- earlier in band @priya: "..."`), posted to its ledger. */
    async earlier(lines) {
      for (const line of lines) {
        const chat = byWorkspace(line.chat);
        if (!chat) throw new Error(`"earlier in ${line.chat}": the test's groups: line names no such group`);
        const sender = chat.group.people.get(line.who);
        if (!sender) throw new Error(`@${line.who} is not in the ${line.chat} workspace (people.md)`);
        const wire = events.get(chat.group.key);
        await wire.postEvents([wire.textedEvent(line.text, sender)]);
        unanswered.get(chat.group.key).push({ from: sender.handle, text: line.text });
      }
    },

    /**
     * One ask the gate let go, carried as the Worker carries it: the group's run, then the 1:1's run with its answer.
     * Answers `{ chat, what, do, state, said, posted, groupMs, groupSpend, answer }`: `said` the group run's words back, `answer`
     * the 1:1 turn (`world.text`'s result) or null when the ask could not be carried.
     */
    async carry(ask) {
      const chat = ask?.to?.kind === "group" ? byKey(ask.to.key) : null;
      if (chat === null) return { chat: ask?.to?.name ?? null, what: String(ask?.what ?? ""), do: ask?.do === true, state: "not_run", said: [], posted: null, groupMs: 0, groupSpend: null, answer: null };
      asked += 1;
      open.add(ask.pair);
      const started = realNow();
      const before = reports();
      const { ctx, settle } = createWorkerCtx();
      const streamed = await worker.fetch(
        new Request("https://mcp.bench.invalid/agent", {
          method: "POST",
          headers: { Authorization: `Bearer ${chat.chatToken}`, "Content-Type": "application/json", Accept: "application/x-ndjson" },
          body: JSON.stringify({
            question: ask.what,
            group: { key: chat.group.key, members: chat.group.members, from: chat.tagger.handle, people: [...chat.group.people.keys()], cause: "cross_chat", chat: unanswered.get(chat.group.key) },
            event: "chat_ask",
            crossChat: { kind: "ask", id: ask.id, from: FROM_ONE, what: ask.what, do: ask.do === true },
          }),
        }),
        env,
        ctx,
      );
      const { response, body } = await readStream(streamed);
      await settle();
      const groupMs = realNow() - started;
      const groupSpend = spent(before);
      const back = response.status === 200 && body?.crossBack?.id === ask.id ? body.crossBack : null;
      // A do-ask's one signed line is posted in the group, as the Worker sends it there (`post_in_chat`, `crossChat.ts`).
      const posted = typeof body?.crossPost === "string" && body.crossPost.trim() !== "" ? body.crossPost : null;
      if (posted !== null) {
        const wire = events.get(chat.group.key);
        await wire.postEvents([{ ...wire.textedEvent(posted), from: { kind: "tex" }, delivered: true }]);
      }
      // Production waits out ten minutes and says it timed out; the bench says what ran and makes nothing up.
      const state = back === null ? "no_answer" : back.state;
      const said = back === null ? [] : (back.texts ?? []).map(String);
      const crossChat = { kind: "answer", id: ask.id, from: chat.name, what: ask.what, state: back === null ? "timeout" : back.state, texts: said, ...(back?.why ? { why: back.why } : {}), key: chat.group.key };
      const answer = await text(ask.what, [], { byCode: true, event: { event: "chat_answer", crossChat } });
      open.delete(ask.pair);
      return { chat: chat.name, what: ask.what, do: ask.do === true, state, said, posted, groupMs, groupSpend, answer };
    },
  };
}

/**
 * The lines a carried ask adds to the conversation the judge reads: a silent marker with what the other chat's Tex
 * answered back (the person never saw it; the judge needs it to tell a relayed answer from an invented one), then
 * what Tex texted the person with it.
 */
export function crossLines(carried) {
  const back = carried.said.length > 0 ? `: "${carried.said.join(" ")}"` : carried.state === "no_answer" ? ", but no answer came back" : ` (${carried.state})`;
  const posted = carried.posted ? ` It posted in that chat: "${carried.posted}".` : "";
  const lines = [{ from: "assistant", text: `(Later: Tex in the ${carried.chat} chat took the ask "${carried.what}" and answered back${back}.${posted} The person did not see this.)`, silent: true, later: "another chat's answer" }];
  const said = carried.answer?.ok ? String(carried.answer.answer ?? "").trim() : "";
  if (said !== "") lines.push({ from: "assistant", text: said, later: `texted when Tex in the ${carried.chat} chat answered` });
  return lines;
}

/** Carry a turn's asks to the other chats and put what came back into the conversation (`crossWorld.mjs`). Its time is kept apart from the reply's, as a job's is. */
export async function carryInto(world, asks, { conversation, totals }) {
  totals.cross ??= [];
  for (const ask of asks.slice(0, Math.max(0, MAX_CROSS_ASKS - totals.cross.length))) {
    const carried = await world.crossAsk(ask);
    if (carried.groupSpend) addSpend(totals, carried.groupSpend);
    totals.jobMs += carried.groupMs ?? 0;
    if (carried.answer) {
      addSpend(totals, carried.answer);
      totals.traces.push(carried.answer.trace ?? []);
      totals.jobMs += carried.answer.ms ?? 0;
    }
    totals.cross.push({ chat: carried.chat, state: carried.state, do: carried.do });
    conversation.push(...crossLines(carried));
  }
}
