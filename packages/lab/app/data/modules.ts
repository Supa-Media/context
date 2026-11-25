/**
 * Ported verbatim from the Tex Architecture Lab artifact (tex.lc/lab): the
 * prompt modules and their base token counts (BASE_MODULES), which of them are stable,
 * their about text (MOD_ABOUT), where each one's source lives (SRC_KINDS, MOD_SRC). Tex's prompt modules' words
 * are the repository's (packages/tex/src/texPrompt, since 2026-11-14), shown from labData.generated.ts.
 */
import { TEX_CONFIG } from "@context/tex/src/texConfig.cjs";
import type { LabModule } from "../types";

/**
 * One Training module per step that runs a model (Dev2, 2026-11-15: "the context module to put in the training
 * set"): `train:<nodeId>` is that step's Training labels as examples (`packages/tex/src/texTraining.cjs`). A step
 * reads its own by listing `train:<its id>` in its reads, another step's by listing that one's.
 */
const TRAIN_NODES = (TEX_CONFIG.nodes as Array<{ id: string; label: string; model: string }>).filter((n) => n.model !== "code");
const TRAIN_MODULES: Record<string, LabModule> = Object.fromEntries(TRAIN_NODES.map((n) => ["train:" + n.id, { name: "Training · " + n.label, tok: 0 } as LabModule]));
const TRAIN_ABOUT: Record<string, string> = Object.fromEntries(TRAIN_NODES.map((n) => ["train:" + n.id, `${n.label}'s labels on the Training Set's conversations, shown as examples: the chat before, the message, and what ${n.label} should output.`]));
const TRAIN_SRC: Record<string, [string, string]> = Object.fromEntries(TRAIN_NODES.map((n) => ["train:" + n.id, ["training", `labels on ${n.id} in apps/mcp/bench/sets/training/*.json`]]));

/**
 * The chat's history, read in two modules whose span and cap are their key (Dev2, 2026-11-17: "number of days or all",
 * and "the character cutoff", all config; `packages/tex/gateway/agent/weekHistory.js`): `chat:<days|all>:<chars>` is the chat
 * word for word over that many days, `summaries:<days|all>:<chars>` each earlier day's summary with its read_day line.
 * Any span and cap is a module; a step lists the one it reads.
 */
const SPAN_KEY = /^(chat|summaries):(\d{1,4}|all):(\d{1,7})$/;
export function spanModule(key: string): { mod: LabModule; about: string; src: [string, string] } | null {
  const m = SPAN_KEY.exec(key);
  if (!m) return null;
  const span = m[2] === "all" ? "all days" : m[2] === "1" ? "today" : `${m[2]} days`;
  const cap = `${Math.round(Number(m[3]) / 1000)}k chars`;
  if (m[1] === "chat") return { mod: { name: `Chat word for word · ${span} · ${cap}`, tok: Math.ceil(Number(m[3]) / 4) } as LabModule, about: `The chat word for word over ${span} (from midnight, in the chat's time zone), newest kept within ${cap}, with its pictures inline by id; the same in every chat, 1:1 or group.`, src: ["chat", "chat ledger: texts and replies from midnight that many days back; pictures from the chat's kept picture notes"] };
  return { mod: { name: `Chat day summaries · ${span} · ${cap}`, tok: Math.ceil(Number(m[3]) / 4) } as LabModule, about: `Each day before the chat's word-for-word days that has a summary (Chat day summaries), within ${span}, newest kept within ${cap}; each ends with the read_day call that opens that day whole.`, src: ["chat", "chat ledger: day entries written by Chat day summaries (chatDays) and Day summaries (daysum)"] };
}
/**
 * A step's Training as whole conversations (Dev2, 2026-11-17): `train:<nodeId>:all:<chars>` is every Training
 * conversation that node has a label in, whole, its labels under their messages, as many as fit in that many characters.
 */
const WHOLE_TRAIN_KEY = /^train:([A-Za-z][A-Za-z0-9]{0,47}):all:([1-9]\d{0,6})$/;
export function wholeTrainModule(key: string): { mod: LabModule; about: string; src: [string, string] } | null {
  const m = WHOLE_TRAIN_KEY.exec(key);
  if (!m) return null;
  const label = TRAIN_NODES.find((n) => n.id === m[1])?.label ?? m[1];
  const cap = `${Math.round(Number(m[2]) / 1000)}k chars`;
  return {
    mod: { name: `Training · ${label} · whole chats · ${cap}`, tok: Math.ceil(Number(m[2]) / 4) } as LabModule,
    about: `Every Training conversation with a ${label} label, whole, each label under the message it is on; conversations that would pass ${cap} are left out whole.`,
    src: ["training", `labels on ${m[1]} in apps/mcp/bench/sets/training/*.json, whole conversations`],
  };
}
const WHOLE_TRAIN_KEYS = [...new Set((TEX_CONFIG.nodes as Array<{ ctx?: string[] }>).flatMap((n) => n.ctx ?? []).filter((k) => WHOLE_TRAIN_KEY.test(k)))];
const WHOLE_TRAIN_MODULES: Record<string, LabModule> = Object.fromEntries(WHOLE_TRAIN_KEYS.map((k) => [k, wholeTrainModule(k)!.mod]));
const SPAN_KEYS = [...new Set((TEX_CONFIG.nodes as Array<{ ctx?: string[] }>).flatMap((n) => n.ctx ?? []).filter((k) => SPAN_KEY.test(k)))];
const SPAN_MODULES: Record<string, LabModule> = Object.fromEntries(SPAN_KEYS.map((k) => [k, spanModule(k)!.mod]));


export const BASE_MODULES: Record<string, LabModule> = {
  "p-about-tex":{name:"Prompt · About Tex",tok:279}, "p-rules":{name:"Prompt · Rules",tok:977}, "p-tools":{name:"Prompt · Your tools",tok:1163}, "p-working":{name:"Prompt · How to answer",tok:2705}, "p-sound-like-a-person":{name:"Prompt · Sound like a person",tok:482}, "p-pictures":{name:"Prompt · Answer with a picture",tok:917}, "p-how-you-talk":{name:"Prompt · How you talk",tok:1065},
  prompt:{name:"Tex's prompt (all seven)",tok:7600}, map:{name:"How Tex works",tok:1500}, caps:{name:"Capability list",tok:3000}, tools:{name:"Tool list",tok:6000},
  hist:{name:"Chat, last 24-30 h",tok:4000}, histAll:{name:"Entire chat history",tok:40000}, threads:{name:"Open threads",tok:600}, groups:{name:"Their group chats",tok:300}, chatSearch:{name:"Search this chat",tok:150}, devShare:{name:"Shared with developers",tok:80}, about:{name:"About me",tok:1000},
  date:{name:"Date and time",tok:60}, skills:{name:"Skills index",tok:800}, skillsAll:{name:"Entire skill repo",tok:60000}, ask:{name:"The open ask",tok:300},
  brief:{name:"Job brief",tok:500}, ledger:{name:"Turn ledger",tok:2500}, draft:{name:"Draft reply",tok:300},
  groupBrief:{name:"Group brief",tok:600}, recent:{name:"Last few texts",tok:500}, own:{name:"Its own instructions",tok:1200},
  ...TRAIN_MODULES, ...WHOLE_TRAIN_MODULES, ...SPAN_MODULES
};

export const MOD_ABOUT: Record<string, string> = {"p-about-tex":"One of Tex's prompt modules, in the order the step's reads list them.", "p-rules":"One of Tex's prompt modules, in the order the step's reads list them.", "p-tools":"One of Tex's prompt modules, in the order the step's reads list them.", "p-working":"One of Tex's prompt modules, in the order the step's reads list them.", "p-sound-like-a-person":"One of Tex's prompt modules, in the order the step's reads list them.", "p-pictures":"One of Tex's prompt modules, in the order the step's reads list them.", "p-how-you-talk":"One of Tex's prompt modules, in the order the step's reads list them.",prompt:"The system prompt every front-door turn starts with.",map:"The short map of how Tex works (docs/architecture/tex.md section 1).",caps:"capabilities.js: what Tex can and can't do in this chat.",tools:"The tool definitions the model may call.",hist:"The chat's last day or so, newest last.",histAll:"Every message in this chat since it began.",threads:"Open threads the classifier keeps.",chatSearch:"Offers search_chat (search { query, args: { history: true, who, since, until } }): whole-word search over every text this chat's ledger keeps, back to its first, each hit with its day, time, speaker and the day: fetch that opens it. Every chat, 1:1 or group.",groups:"A 1:1 only: the group chats the person is in with Tex, and the read-only group_chats tool that searches them, reads a day word for word and reads each day's summary.",devShare:"A group chat only: whether the chat is shared with the developers who build Tex, who said yes and who hasn't.",about:"The person's about-me note.",date:"Today's date and time (withToday).",skills:"One line per skill in the repo.",skillsAll:"Every skill file in full.",ask:"The request being worked on.",brief:"The job's brief: goal, limits, who asked.",ledger:"The turn ledger: what this turn already did.",draft:"The reply about to go.",groupBrief:"Tex's open work, chat rules and guest names.",recent:"The last few texts only.",own:"The step's own instructions.",...TRAIN_ABOUT,...Object.fromEntries(WHOLE_TRAIN_KEYS.map((k) => [k, wholeTrainModule(k)!.about])),...Object.fromEntries(SPAN_KEYS.map((k) => [k, spanModule(k)!.about]))};

export const SRC_KINDS: Record<string, { name: string; tip: string; icon: string; edit: string }> = {
 chat:{name:"The chat's record",tip:"A view of the chat's one ledger. Change the view on Conversations.",icon:"text",edit:"How to cut the view"},
 store:{name:"Tex's store",tip:"A note or ledger in the person's or group's own store. A run uses the test person's copy, never a real one.",icon:"door",edit:"Sample for a run"},
 prompt:{name:"Tex's prompt words",tip:"A file beside Tex's config (packages/tex/src/texPrompt). Promote writes your words there in a pull request, and the replay gate runs.",icon:"thread",edit:"New words"},
 ailc:{name:"@context-lc ai folder",tip:"A note in @context-lc ai/production. A run puts your text in the bench's copy, never the live note.",icon:"thread",edit:"New text for the note"},
 training:{name:"Training Set",tip:"A step's labels on the Training conversations (apps/mcp/bench/sets/training), shown to the steps that read it as examples. Change them on the Testing tab; Promote writes them in a pull request, and the replay gate runs.",icon:"star",edit:"Which labels to change"},
 code:{name:"Code",tip:"Written in the repo. A change here is a code change.",icon:"code",edit:"New text, or what to change"},
 derived:{name:"Built each turn",tip:"Made by code from the turn itself. Change how it's built, not its text.",icon:"router",edit:"How to build it instead"},
 special:{name:"Special",tip:"Read in its own way, not pasted whole into the prompt.",icon:"star",edit:"What to change"}};

export const MOD_SRC: Record<string, [string, string]> = {"p-about-tex":["prompt","packages/tex/src/texPrompt/about-tex.md"], "p-rules":["prompt","packages/tex/src/texPrompt/rules.md"], "p-tools":["prompt","packages/tex/src/texPrompt/tools.md"], "p-working":["prompt","packages/tex/src/texPrompt/working.md"], "p-sound-like-a-person":["prompt","packages/tex/src/texPrompt/sound-like-a-person.md"], "p-pictures":["prompt","packages/tex/src/texPrompt/pictures.md"], "p-how-you-talk":["prompt","packages/tex/src/texPrompt/how-you-talk.md"],prompt:["prompt","packages/tex/src/texPrompt/<module>.md, in the order Tex's config lists them"],map:["code","texArchitecture.generated.js (from docs/architecture/tex.md)"],caps:["code","packages/tex/gateway/agent/capabilities.js"],tools:["code","tool definitions (sixTools.js, commandTools.js …)"],
 hist:["chat","chat ledger: thread list + last 24 h word for word + older up to 80k chars"],histAll:["chat","chat ledger, whole: only through earlier_texts / earlier_chat / read_thread"],threads:["chat","threads ledger (<chat>.threads), written by the classifier"],chatSearch:["chat","chat ledger, whole: only through search_chat (chatSearch.js)"],groups:["chat","control plane (textGroups.homeUsers on their own 1:1 grant) + each group's ledger, through group_chats"],devShare:["chat","control plane (texReviewSharing yeses of the chat's homeUsers, texLabShared.ts devShareOf), on every group turn"],about:["store","tex/about.md, or tex/groups/<id>/about.md"],
 date:["derived","withToday"],skills:["special","the setup's skills: lines in read_skill's description; a body is read only when asked"],skillsAll:["ailc","ai/production/skills/*.md"],ask:["derived","the text being answered"],
 brief:["derived","the job's record (background.js)"],ledger:["derived","this turn's ledger so far"],draft:["derived","the reply about to go"],
 groupBrief:["derived","brief entries kept in the chat's ledger when a group turn ends (judgeBrief.js)"],recent:["chat","chat ledger, last few texts"],own:["code","the step's own prompt in its file"],...TRAIN_SRC,...Object.fromEntries(WHOLE_TRAIN_KEYS.map((k) => [k, wholeTrainModule(k)!.src])),...Object.fromEntries(SPAN_KEYS.map((k) => [k, spanModule(k)!.src]))};
