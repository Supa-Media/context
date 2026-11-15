/**
 * Ported verbatim from the Tex Architecture Lab artifact (tex.lc/lab): the
 * prompt modules and their base token counts (BASE_MODULES), which of them are stable,
 * their about text (MOD_ABOUT), where each one's source lives (SRC_KINDS, MOD_SRC). Tex's prompt modules' words
 * are the repository's (packages/shared/src/texPrompt, since 2026-11-14), shown from labData.generated.ts.
 */
import TEX_CONFIG from "@context/shared/src/texConfig.json";
import type { LabModule } from "../types";

/**
 * One Training module per step that runs a model (Dev2, 2026-11-15: "the context module to put in the training
 * set"): `train:<nodeId>` is that step's Training labels as examples (`packages/shared/src/texTraining.cjs`). A step
 * reads its own by listing `train:<its id>` in its reads, another step's by listing that one's.
 */
const TRAIN_NODES = (TEX_CONFIG.nodes as Array<{ id: string; label: string; model: string }>).filter((n) => n.model !== "code");
const TRAIN_MODULES: Record<string, LabModule> = Object.fromEntries(TRAIN_NODES.map((n) => ["train:" + n.id, { name: "Training · " + n.label, tok: 0 } as LabModule]));
const TRAIN_ABOUT: Record<string, string> = Object.fromEntries(TRAIN_NODES.map((n) => ["train:" + n.id, `${n.label}'s labels on the Training Set's conversations, shown as examples: the chat before, the message, and what ${n.label} should output.`]));
const TRAIN_SRC: Record<string, [string, string]> = Object.fromEntries(TRAIN_NODES.map((n) => ["train:" + n.id, ["training", `labels on ${n.id} in apps/mcp/bench/sets/training/*.json`]]));

export const STABLE: Set<string> = new Set(["p-about-tex","p-rules","p-tools","p-working","p-sound-like-a-person","p-pictures","p-how-you-talk","prompt","map","caps","tools","skills","skillsAll","own",...Object.keys(TRAIN_MODULES)]);

export const BASE_MODULES: Record<string, LabModule> = {
  "p-about-tex":{name:"Prompt · About Tex",tok:279}, "p-rules":{name:"Prompt · Rules",tok:977}, "p-tools":{name:"Prompt · Your tools",tok:1163}, "p-working":{name:"Prompt · How to answer",tok:2705}, "p-sound-like-a-person":{name:"Prompt · Sound like a person",tok:482}, "p-pictures":{name:"Prompt · Answer with a picture",tok:917}, "p-how-you-talk":{name:"Prompt · How you talk",tok:1065},
  prompt:{name:"Tex's prompt (all seven)",tok:7600}, map:{name:"How Tex works",tok:1500}, caps:{name:"Capability list",tok:3000}, tools:{name:"Tool list",tok:6000},
  hist:{name:"Chat, last 24-30 h",tok:4000}, histAll:{name:"Entire chat history",tok:40000}, threads:{name:"Open threads",tok:600}, about:{name:"About me",tok:1000},
  date:{name:"Date and time",tok:60}, skills:{name:"Skills index",tok:800}, skillsAll:{name:"Entire skill repo",tok:60000}, ask:{name:"The open ask",tok:300},
  brief:{name:"Job brief",tok:500}, ledger:{name:"Turn ledger",tok:2500}, draft:{name:"Draft reply",tok:300},
  groupBrief:{name:"Group brief",tok:600}, recent:{name:"Last few texts",tok:500}, own:{name:"Its own instructions",tok:1200},
  ...TRAIN_MODULES
};

export const MOD_ABOUT: Record<string, string> = {"p-about-tex":"One of Tex's prompt modules, in the order the step's reads list them.", "p-rules":"One of Tex's prompt modules, in the order the step's reads list them.", "p-tools":"One of Tex's prompt modules, in the order the step's reads list them.", "p-working":"One of Tex's prompt modules, in the order the step's reads list them.", "p-sound-like-a-person":"One of Tex's prompt modules, in the order the step's reads list them.", "p-pictures":"One of Tex's prompt modules, in the order the step's reads list them.", "p-how-you-talk":"One of Tex's prompt modules, in the order the step's reads list them.",prompt:"The system prompt every front-door turn starts with.",map:"The short map of how Tex works (docs/architecture/tex.md section 1).",caps:"capabilities.js: what Tex can and can't do in this chat.",tools:"The tool definitions the model may call.",hist:"The chat's last day or so, newest last.",histAll:"Every message in this chat since it began.",threads:"Open threads the classifier keeps.",about:"The person's about-me note.",date:"Today's date and time (withToday).",skills:"One line per skill in the repo.",skillsAll:"Every skill file in full.",ask:"The request being worked on.",brief:"The job's brief: goal, limits, who asked.",ledger:"The turn ledger: what this turn already did.",draft:"The reply about to go.",groupBrief:"Tex's open work, chat rules and guest names.",recent:"The last few texts only.",own:"The step's own instructions.",...TRAIN_ABOUT};

export const SRC_KINDS: Record<string, { name: string; tip: string; icon: string; edit: string }> = {
 chat:{name:"The chat's record",tip:"A view of the chat's one ledger. Change the view on Conversations.",icon:"text",edit:"How to cut the view"},
 store:{name:"Tex's store",tip:"A note or ledger in the person's or group's own store. A run uses the test person's copy, never a real one.",icon:"door",edit:"Sample for a run"},
 prompt:{name:"Tex's prompt words",tip:"A file beside Tex's config (packages/shared/src/texPrompt). Promote writes your words there in a pull request, and the replay gate runs.",icon:"thread",edit:"New words"},
 ailc:{name:"@context-lc ai folder",tip:"A note in @context-lc ai/production. A run puts your text in the bench's copy, never the live note.",icon:"thread",edit:"New text for the note"},
 training:{name:"Training Set",tip:"A step's labels on the Training conversations (apps/mcp/bench/sets/training), shown to the steps that read it as examples. Change them on the Testing tab; Promote writes them in a pull request, and the replay gate runs.",icon:"star",edit:"Which labels to change"},
 code:{name:"Code",tip:"Written in the repo. A change here is a code change.",icon:"code",edit:"New text, or what to change"},
 derived:{name:"Built each turn",tip:"Made by code from the turn itself. Change how it's built, not its text.",icon:"router",edit:"How to build it instead"},
 special:{name:"Special",tip:"Read in its own way, not pasted whole into the prompt.",icon:"star",edit:"What to change"}};

export const MOD_SRC: Record<string, [string, string]> = {"p-about-tex":["prompt","packages/shared/src/texPrompt/about-tex.md"], "p-rules":["prompt","packages/shared/src/texPrompt/rules.md"], "p-tools":["prompt","packages/shared/src/texPrompt/tools.md"], "p-working":["prompt","packages/shared/src/texPrompt/working.md"], "p-sound-like-a-person":["prompt","packages/shared/src/texPrompt/sound-like-a-person.md"], "p-pictures":["prompt","packages/shared/src/texPrompt/pictures.md"], "p-how-you-talk":["prompt","packages/shared/src/texPrompt/how-you-talk.md"],prompt:["prompt","packages/shared/src/texPrompt/<module>.md, in the order Tex's config lists them"],map:["code","texArchitecture.generated.js (from docs/architecture/tex.md)"],caps:["code","apps/mcp/src/agent/capabilities.js"],tools:["code","tool definitions (sixTools.js, commandTools.js …)"],
 hist:["chat","chat ledger: thread list + last 24 h word for word + older up to 80k chars"],histAll:["chat","chat ledger, whole: only through earlier_texts / earlier_chat / read_thread"],threads:["chat","threads ledger (<chat>.threads), written by the classifier"],about:["store","tex/about.md, or tex/groups/<id>/about.md"],
 date:["derived","withToday"],skills:["special","the setup's skills: lines in read_skill's description; a body is read only when asked"],skillsAll:["ailc","ai/production/skills/*.md"],ask:["derived","the text being answered"],
 brief:["derived","the job's record (background.js)"],ledger:["derived","this turn's ledger so far"],draft:["derived","the reply about to go"],
 groupBrief:["derived","brief entries kept in the chat's ledger when a group turn ends (judgeBrief.js)"],recent:["chat","chat ledger, last few texts"],own:["code","the step's own prompt in its file"],...TRAIN_SRC};
