/**
 * `tex_dev`'s actions on Tex's test conversations (Dev2, 2026-11-15: "make sure that through the MCP it's easy for an
 * agent to see and modify and change training, dev sets ... and the different properties"; "a lot of conversations
 * that I have personally with Tex are just going to turn into golden or training sets"). The Lab's Testing tab
 * (prototype https://claude.ai/artifact/GAScQuRxZyASpH8xes4n9K) does the same with the same edits
 * (`packages/shared/src/texSetOps.cjs`), so whatever a person does there an agent does here.
 *
 * A conversation is read as the repo has it (`apps/mcp/bench/sets`, bundled as `texSetsRepo.generated.json`) with
 * the Lab's draft over it (`functions/texSets.ts`); Promote opens the pull request that writes the drafts back. The
 * Test Set is never here: it is people only, in the eval service, and every action refuses it.
 *
 * Importing a real chat turns it into a new Training or Dev conversation only rewritten: `set_import` hands the chat's
 * texts with the rules, and `set_create` with `from_chat` reads them again and refuses a conversation that copies a
 * line or a name from them (Dev2, 2026-11-12: examples from real chats are never verbatim).
 */

import REPO from "../../../../packages/shared/src/texSetsRepo.generated.json" with { type: "json" };
import { BENCH_PEOPLE, check, KINDS, labelFields, missingTest, ratio, unitTests } from "../../../../packages/shared/src/texSets.cjs";
import { WHY } from "../../../../packages/shared/src/textDecide.cjs";
import { MAX_OPS, OPEN_SETS } from "../../../../packages/shared/src/texSetOps.cjs";
import { TEX_CONFIG } from "../agent/texConfig.js";
import { toolError } from "../tools/results.js";
import { openChat } from "./probe.js";
import { testSetSummary } from "../http/texTestSet.js";

const WHY_LIST = Object.keys(WHY);
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const TEST_REFUSED = "The Test Set is people only: written and read by hand in the Lab, never shown to an agent. tex_dev reads and writes Training and Dev only.";
/** A chat import reads at most this many texts. */
export const MAX_IMPORT = 60;
/** Words in a row shared with a real text that make a line a copy of it. */
export const COPY_RUN = 6;

const parse = (s) => {
  try {
    return typeof s === "string" ? JSON.parse(s) : s;
  } catch {
    return null;
  }
};

/** The nodes a message can be labelled for: every step of the config with output fields. */
export const labelNodes = () => TEX_CONFIG.nodes.filter((n) => Array.isArray(n.outSchema) && n.outSchema.length > 0);

const problemsOf = (c) => check(c, TEX_CONFIG, { why: WHY_LIST });

function summary(c, draft) {
  const labels = (c.msgs || []).reduce((a, m) => a + Object.keys(m.labels || {}).length, 0);
  const nodes = [...new Set((c.msgs || []).flatMap((m) => Object.keys(m.labels || {})))];
  return {
    id: c.id,
    title: c.title,
    set: c.set,
    kind: c.kind,
    members: c.members,
    messages: (c.msgs || []).length,
    stars: unitTests(c).length,
    labels,
    nodes,
    ...(c.from ? { from: c.from } : {}),
    ...(draft ? { draft: { rev: draft.rev, by: draft.by, via: draft.via, ...(draft.removed ? { removed: true } : {}), ...(draft.isNew ? { isNew: true } : {}), ...(draft.promote ? { promote: draft.promote } : {}) } } : {}),
    problems: problemsOf(c).length,
  };
}

/** Normalised words of a line, for the copy check. */
const words = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/**
 * Whether a written conversation copies a real chat: a line sharing `COPY_RUN` words in a row with a real text (or a
 * line of three words or more equal to one: "ok thanks" is anyone's), or a speaker named as a real person in it. Answers the problems, empty when rewritten.
 */
export function copiesOf(convo, source) {
  const out = [];
  const real = source.map((t) => words(t.text));
  const runs = new Set();
  for (const w of real) for (let i = 0; i + COPY_RUN <= w.length; i++) runs.add(w.slice(i, i + COPY_RUN).join(" "));
  const whole = new Set(real.filter((w) => w.length >= 3).map((w) => w.join(" ")));
  (convo.msgs || []).forEach((m, i) => {
    const w = words(m.text);
    if (w.length > 0 && whole.has(w.join(" "))) return out.push(`message ${i + 1} is a real text word for word`);
    for (let j = 0; j + COPY_RUN <= w.length; j++)
      if (runs.has(w.slice(j, j + COPY_RUN).join(" "))) return out.push(`message ${i + 1} copies ${COPY_RUN} words in a row from a real text`);
  });
  const names = new Set(source.flatMap((t) => (t.tex ? [] : words(t.who))).filter((n) => n.length > 1));
  for (const who of convo.members || []) if (words(who).some((w) => names.has(w))) out.push(`${who} is a real person's name in that chat: invent another`);
  return out;
}

/** A chat's texts, oldest first, as `set_import` shows them: who, whether Tex, the words. */
export async function sourceTexts(env, page, args, ledgerOf) {
  const { chat, place, ledger } = openChat(env, page, args.chat, ledgerOf);
  if (ledger === null) return { chat: chat.key, texts: [] };
  const limit = Math.max(1, Math.min(MAX_IMPORT, Number(args.limit) || 30));
  const read = await ledger.read(place.name, { before: Number.isSafeInteger(args.before) ? args.before : Number.MAX_SAFE_INTEGER, kinds: ["text"], limit, jobs: false });
  const texts = (read.entries ?? [])
    .filter((e) => e.kind === "text" && typeof e.text === "string")
    .sort((a, b) => a.at - b.at)
    .map((e, i) => ({ n: i + 1, who: e.from?.kind === "tex" ? "Tex" : (e.from?.name ?? "Someone"), ...(e.from?.kind === "tex" ? { tex: true } : {}), text: e.text, seq: e.seq }));
  return { chat: chat.key, texts, ...(Number.isSafeInteger(read.before) ? { before: read.before } : {}) };
}

/**
 * The actions for one connection. `plane(action, args)` is the tool's call to the control plane, `json` its answer
 * shape, `page()` the person's Tex page (for chats), `env` and `ledgerOf` to read a chat. Null for another action.
 */
export function createSetActions({ plane, json, page, env, ledgerOf, repo = REPO.sets }) {
  const repoById = new Map(repo.map((c) => [c.id, c]));

  async function overlay() {
    const { answer, error } = await plane("set_drafts");
    if (error) return { error };
    const drafts = new Map((answer.drafts ?? []).map((d) => [d.id, d]));
    const convs = [];
    for (const c of repo) {
      const d = drafts.get(c.id);
      convs.push({ convo: d ? (parse(d.conv) ?? c) : c, draft: d ?? null });
    }
    for (const d of drafts.values()) if (!repoById.has(d.id)) convs.push({ convo: parse(d.conv), draft: d });
    return { convs: convs.filter((x) => x.convo), drafts };
  }

  async function one(id) {
    if (typeof id !== "string" || !ID.test(id)) return { error: toolError("Name the conversation: { id } (sets lists them).") };
    const o = await overlay();
    if (o.error) return o;
    const hit = o.convs.find((x) => x.convo.id === id);
    return hit ? hit : { error: toolError(`There is no Training or Dev conversation ${id}; sets lists them (the Test Set is never shown here).`) };
  }

  // One pooled split over every scope; per scope only a warning, never a failure, when a scope has no Test cases
  // (Dev2, 2026-11-17), from the Test Set's counts by step: the same counts the Lab's Testing tab reads, no words.
  const ratioOf = async (convs) => {
    const live = convs.filter((x) => !x.draft?.removed).map((x) => x.convo);
    const r = ratio(live);
    const td = r.counts.training + r.counts.dev;
    const testByNode = (await testSetSummary(env))?.counts?.byNode ?? null;
    const noTest = missingTest(live, testByNode);
    return {
      training: r.counts.training, dev: r.counts.dev, test: "counted by the eval service, never shown here", devShare: td ? Math.round((r.counts.dev * 100) / td) : 0, target: "60/20/20 over starred unit tests, pooled across every scope; Training:Dev 3:1 here",
      ...(testByNode ? { noTest, ...(noTest.length ? { warning: `${noTest.map((x) => x.scope).join(", ")}: unit tests in Training or Dev and none in the Test Set (a warning, never a failure)` } : {}) } : { noTest: "the Test Set's counts could not be read just now" }),
    };
  };

  const edit = async (id, ops, rev) => {
    const hit = await one(id);
    if (hit.error) return hit.error;
    const base = hit.draft ? undefined : repoById.get(id);
    const { answer, error } = await plane("set_edit", { id, rev: typeof rev === "number" ? rev : (hit.draft?.rev ?? 0), ops, ...(base ? { base } : {}) });
    if (error) return error;
    if (answer.status === "conflict") return json({ refused: "someone changed the same thing since your revision; nothing was saved", pieces: answer.keys, rev: answer.rev, now: parse(answer.conv), next: answer.next });
    const convo = parse(answer.conv);
    return json({ id, rev: answer.rev, kept: answer.said, problems: problemsOf(convo), then: "set_promote opens the pull request that writes it into the repo" });
  };

  return async function setAction(action, args = {}) {
    switch (action) {
      case "sets": {
        if (args.set === "test") return toolError(TEST_REFUSED);
        const o = await overlay();
        if (o.error) return o.error;
        const q = typeof args.q === "string" ? args.q.toLowerCase() : null;
        const rows = o.convs
          .filter((x) => !args.set || x.convo.set === args.set)
          .filter((x) => !args.node || (x.convo.msgs || []).some((m) => (m.labels || {})[args.node]))
          .filter((x) => args.starred !== true || unitTests(x.convo).length > 0)
          .filter((x) => args.drafts !== true || x.draft)
          .filter((x) => !q || `${x.convo.title} ${x.convo.id} ${x.convo.from ?? ""}`.toLowerCase().includes(q))
          .map((x) => summary(x.convo, x.draft));
        const limit = Math.max(1, Math.min(500, Number(args.limit) || 200));
        return json({ ratio: await ratioOf(o.convs), shown: Math.min(rows.length, limit), of: rows.length, sets: rows.slice(0, limit), next: "set_get { id } reads one whole; set_fields shows what a label can hold" });
      }
      case "set_get": {
        const hit = await one(args.id);
        if (hit.error) return hit.error;
        return json({ conversation: hit.convo, rev: hit.draft?.rev ?? 0, draft: hit.draft ? { by: hit.draft.by, via: hit.draft.via, removed: hit.draft.removed, isNew: hit.draft.isNew, promote: hit.draft.promote } : null, unitTests: unitTests(hit.convo), problems: problemsOf(hit.convo) });
      }
      case "set_ratio": {
        const o = await overlay();
        return o.error ?? json(await ratioOf(o.convs));
      }
      case "set_fields": {
        const nodes = args.node ? labelNodes().filter((n) => n.id === args.node) : labelNodes();
        if (!nodes.length) return toolError(`No node "${args.node}" with output fields in Tex's config.`);
        return json({
          nodes: nodes.map((n) => ({ node: n.id, label: n.label ?? n.id, ...labelFields(n, { why: WHY_LIST }) })),
          every: { star: "true makes this message × node a unit test", run: '"must" | "must not" (absent: not checked)', any: 'a pick of "any" skips that field' },
          message: { kinds: KINDS, to: "a react, reply, edit or delete points at an earlier message by id", tex: "a Tex row is what Tex should have said, history for later rows, never a test; no Tex row after a person's message means Tex stays quiet" },
          rec: "rec[node] on a person's message is that node's recorded run on main: the frozen input for the nodes it feeds when no label on the upstream node says otherwise",
          sets: OPEN_SETS,
          ops: `set_edit takes up to ${MAX_OPS} ops: title, kind, members, set, add {msg, after?}, edit {msg, field, value}, remove {msg}, move {msg, before}, label {msg, node, value|null}, field {msg, node, field, value|null}, rec {msg, node, value|null}, put {convo}; edit {msg, field: "pics", value: [{url, type?, name?}] | null} sets a message's pictures (https addresses, at most 6); edit {msg, field: "via", value: checkin|routine|notify|job} changes a trigger row's input and edit {msg, field: "state", value: done|running|failed|waiting|stuck|null} a job row's state; the Lab's addMsg/editMsg/removeMsg/moveMsg spellings work too`,
        });
      }
      case "set_edit": {
        if (!Array.isArray(args.ops)) return toolError("set_edit takes { id, rev, ops: [...] }; set_fields lists the ops.");
        if (args.ops.some((o) => o?.op === "set" && o.value === "test") || args.ops.some((o) => o?.op === "put" && o.convo?.set === "test")) return toolError(TEST_REFUSED);
        return await edit(args.id, args.ops, args.rev);
      }
      case "set_move": {
        if (args.set === "test") return toolError(TEST_REFUSED);
        if (!OPEN_SETS.includes(args.set)) return toolError('set_move takes { id, set: "training" | "dev" }.');
        return await edit(args.id, [{ op: "set", value: args.set }], args.rev);
      }
      case "set_create": {
        const convo = args.conv && typeof args.conv === "object" ? args.conv : null;
        if (convo?.set === "test" || args.set === "test") return toolError(TEST_REFUSED);
        if (convo) {
          const problems = problemsOf(convo);
          if (problems.length) return toolError(`This conversation would not be sound: ${problems.slice(0, 8).join("; ")}`);
        }
        if (args.from_chat) {
          if (!convo) return toolError("An imported chat is created whole: set_create { conv, from_chat: { chat, before?, limit? } } with the conversation rewritten.");
          const p = await page();
          if (p.error) return p.error;
          let src;
          try {
            src = await sourceTexts(env, p.page, args.from_chat, ledgerOf);
          } catch {
            return toolError("That chat's texts could not be read again to check the rewrite.");
          }
          const copies = copiesOf(convo, src.texts);
          if (copies.length) return toolError(`Not saved: examples from real chats are never verbatim. ${copies.join("; ")}. Rewrite with invented names, places and details, keeping only the shape and the right call.`);
        }
        const { answer, error } = await plane("set_create", { ...(convo ? { conv: convo } : { id: args.id, title: args.title, set: args.set, kind: args.kind, members: args.members }), repoIds: [...repoById.keys()] });
        return error ?? json({ id: answer.id, rev: answer.rev, then: "set_edit adds messages and labels; set_promote writes it into the repo" });
      }
      case "set_delete": {
        const hit = await one(args.id);
        if (hit.error) return hit.error;
        if (args.confirm !== true) return toolError(`Deleting ${args.id} ${hit.draft?.isNew ? "drops it for everyone now" : "removes its file at the next Promote"}. Send it again with confirm: true.`);
        const { answer, error } = await plane("set_remove", { id: args.id, ...(hit.draft ? {} : { base: repoById.get(args.id) }) });
        return error ?? json({ id: args.id, deleted: answer.deleted, undo: "set_restore { id } until it is promoted" });
      }
      case "set_restore": {
        const { answer, error } = await plane("set_remove", { id: args.id, restore: true });
        return error ?? json({ id: answer.id, restored: true, note: "the draft is gone: the conversation reads as the repo has it" });
      }
      case "set_history": {
        if (typeof args.id !== "string" || !ID.test(args.id)) return toolError("set_history takes { id }.");
        const { answer, error } = await plane("set_history", { id: args.id });
        if (error) return error;
        const from = repoById.has(args.id) && !answer.isNew ? [{ rev: 0, said: ["the repo's copy"], restorable: true }] : [];
        return json({ id: args.id, rev: answer.rev, revs: [...answer.revs, ...from], next: "set_back { id, to } puts a revision back as a new one (0: the repo's copy); set_back { id, to: rev - 1 } undoes the last change" });
      }
      case "set_back": {
        if (typeof args.id !== "string" || !ID.test(args.id) || !Number.isSafeInteger(args.to)) return toolError("set_back takes { id, to } (a revision from set_history; 0 is the repo's copy).");
        const { answer, error } = await plane("set_back", { id: args.id, to: args.to });
        if (error) return error;
        const convo = parse(answer.conv);
        return json({ id: args.id, rev: answer.rev, restored: args.to, ...(convo ? { problems: problemsOf(convo) } : {}), undo: "set_history lists the revision before this one; set_back to it undoes this" });
      }
      case "set_promote": {
        const o = await overlay();
        if (o.error) return o.error;
        const ids = Array.isArray(args.ids) ? args.ids : [...o.drafts.keys()];
        const bad = o.convs.filter((x) => ids.includes(x.convo.id) && !x.draft?.removed).flatMap((x) => problemsOf(x.convo).map((p) => `${x.convo.id}: ${p}`));
        if (bad.length) return toolError(`These would be refused: ${bad.slice(0, 10).join("; ")}`);
        const { answer, error } = await plane("set_promote", { ids });
        return error ?? json({ asked: answer.asked, then: answer.then });
      }
      case "set_import": {
        const p = await page();
        if (p.error) return p.error;
        let src;
        try {
          src = await sourceTexts(env, p.page, args, ledgerOf);
        } catch (error) {
          return toolError(error?.status === 404 ? "There is no such chat; chats lists yours." : "That chat's texts could not be read just now.");
        }
        return json({
          chat: src.chat,
          texts: src.texts.map(({ seq: _s, ...t }) => t),
          ...(src.before ? { older: `before: ${src.before} reads the texts before these` } : {}),
          rules: [
            "Rewrite it, never copy it: invent every name, place, number and detail, and reword every line, keeping only the shape of the chat and what Tex should have done.",
            `A line that shares ${COPY_RUN} words in a row with a real text, or a member named as someone in the chat, is refused.`,
            `Its people are the bench's (${BENCH_PEOPLE.join(", ")}), each cast by role, since every Front door test runs in its person's bench world; a group needs a shared bench workspace with them all.`,
            "Put it in Training (examples Tex's steps read) or Dev (replayed for tuning); the Test Set is people only.",
            "Keep Tex rows as what Tex should have said, drop a Tex row where Tex should have stayed quiet, and label the moments that matter (set_fields), starring the ones that are unit tests.",
          ],
          next: `set_create { conv, from_chat: { chat: "${src.chat}"${Number.isSafeInteger(args.before) ? `, before: ${args.before}` : ""}${args.limit ? `, limit: ${args.limit}` : ""} } }`,
        });
      }
      default:
        return null;
    }
  };
}
