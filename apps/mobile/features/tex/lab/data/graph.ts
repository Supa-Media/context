/**
 * Ported verbatim from the Tex Architecture Lab artifact (tex.lc/lab): the
 * canvas graph of Tex's default architecture (mainGraph0, with NODE_INFO's goals and
 * logs applied by mainGraph), the node factory N, the wire styles, the icon paths,
 * the "when" choices and the add-step kinds. The graph itself is Tex's config (`mainGraph`).
 */
import TEX_CONFIG from "@context/shared/src/texConfig.json";
import type { LabGraph, LabNode } from "../types";

export const BASE_SHA: string = "888afb0";

export const WIRES: Record<string, { name: string; dash: string; c: string; w?: number; tip: string }> = {
  wait:{name:"Next step",dash:"",c:"--text2",tip:"Runs when this step is done, before the reply"},
  uses:{name:"Helper",dash:"",c:"--accent",w:3,tip:"Used in the middle of this step, then hands back to it"},
  // Not the artifact's faint grey dots, which read as "Next step" (Dev2, 2026-11-14: "next step and after sending seems like its the same?").
  behind:{name:"After sending",dash:"1 5",c:"--team",w:2.2,tip:"Runs once the reply has gone; nobody waits for it"},
  job:{name:"Background",dash:"7 5",c:"--m-api",tip:"Starts a job; the reply doesn't wait"},
  loop:{name:"Send back",dash:"5 4",c:"--bad",tip:"Sometimes sends the draft back"}
};

export const ICONS: Record<string, string> = {
  text:'<path d="M4 5h16v11H9l-5 4z"/>',
  judge:'<circle cx="12" cy="12" r="8"/><path d="M8.5 12.3l2.4 2.4 4.6-5"/>',
  door:'<path d="M6 20V4h9l3 2.5V20"/><path d="M4 20h16"/><circle cx="13.5" cy="12" r=".9" fill="currentColor"/>',
  tools:'<path d="M14.7 6.3a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3z"/><path d="M14.7 6.3L17 4"/>',
  advisor:'<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3z"/>',
  code:'<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12"/>',
  send:'<path d="M4 12l16-8-6 16-3-7z"/><path d="M11 13l9-9"/>',
  job:'<rect x="4" y="7.5" width="16" height="11.5" rx="2"/><path d="M9 7.5V5.5h6v2M4 12.5h16"/>',
  router:'<path d="M6 4v5a4 4 0 0 0 4 4h8M14 9l4 4-4 4"/>',
  shield:'<path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/>',
  mail:'<rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M4 7l8 6 8-6"/>',
  card:'<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M5 17l5-4 3 2.5 3-2.5 3 3"/>',
  thread:'<path d="M5 6h14M5 12h10M5 18h6"/>',
  star:'<path d="M12 4l2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z"/>',
  queue:'<path d="M4 7h16M4 12h16M4 17h10"/>',
  trash:'<path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/>',
  emoji:'<circle cx="12" cy="12" r="8"/><path d="M9 14c1.5 1.5 4.5 1.5 6 0M9.5 10h.01M14.5 10h.01"/>',
  wire:'<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M7.5 16.5c3-1 2-8 9-9"/>'
};

export function N(id: string, label: string, o: Partial<LabNode>): LabNode {
  return Object.assign({id,label,goal:"",log:false,on:true,rounds:1,out:300,ctx:[],ms:0,timeoutS:0,areas:[],file:"",note:"",icon:"judge"},o) as LabNode;
}

export const NODE_INFO: Record<string, { goal: string; logs: string[] | null }> = {
 text:{goal:"Take every text, picture or tapback from iMessage or WhatsApp and get it into the chat's record before anything decides about it.",logs:["text"]},
 decide:{goal:"Choose, from labelled examples, whether this text gets an answer, a reaction, a short wait or nothing, so Tex never answers what wasn't for it.",logs:["judge (moment)"]},
 react:{goal:"Put Decide's tapback on their text straight away, so a thanks or a win gets a reaction without a reply.",logs:null},
 lanes:{goal:"Keep one turn per chat at a time (groups up to three side by side) so two answers never race each other.",logs:null},
 door:{goal:"Gather what the turn needs (who's asking, the chat's home, settings, history) in code, before any model runs.",logs:null},
 router:{goal:"Send a plain lookup to a cheaper path and keep the front door for changes and thinking.",logs:null},
 fd:{goal:"Write Tex's answer: read the chat, call the tools that do the work, and draft the reply.",logs:["thinking","said","tool","reply","judge (code)"]},
 fallback:{goal:"Answer when the front door's model is down, so a text never goes unanswered.",logs:null},
 planner:{goal:"Break a big ask into steps before the front door starts, so it doesn't wander.",logs:null},
 tools:{goal:"Do the actual work in Context and the world: read, write, manage and send. Added only in code.",logs:["tool"]},
 advisor:{goal:"Think harder when the front door is stuck, and say what to try next.",logs:["tool (ask_advisor)"]},
 checks:{goal:"Catch what code can prove wrong in a draft (a claim with no call behind it, a missing link) before a model looks.",logs:["judge (code)"]},
 mail:{goal:"Read an email before it goes and stop one that is wrong, rude or to the wrong person.",logs:["mail_check"]},
 card:{goal:"Check a card's fields match what was asked before it is shown.",logs:null},
 reviewer:{goal:"Read the draft as the person would and send it back when it misses, so they never get a wrong or lazy answer.",logs:["judge"]},
 send:{goal:"Deliver the answer: the texts, any card, and a reaction, as the chat's service allows.",logs:["reply (via the turn)"]},
 classifier:{goal:"File each text into a conversation thread after the reply, so later turns see a short index instead of everything.",logs:["threads ledger"]},
 selfreview:{goal:"Look back at a sent answer and note what to do better next time.",logs:null},
 job:{goal:"Do long work (browsing, forms, many steps) without holding up the reply.",logs:["job"]},
 jobcheck:{goal:"Check a job's work as it goes and steer it when it drifts.",logs:["advisor (check)"]},
 mailadv:{goal:"Decide what to tell the person when a job gets mail it can't handle alone.",logs:null},
 handback:{goal:"Make sure what a job hands back is true and finished before the person hears it.",logs:null}
};

/**
 * Main's graph is Tex's one config, `packages/shared/src/texConfig.json` (Dev2, 2026-11-13: "I want the config
 * generated by the lab to become the production code, and to be the only source of truth"). Each call hands back a
 * fresh copy, because the Lab edits the graph it is given.
 */
export function mainGraph(): LabGraph {return mainGraph0()}

export function mainGraph0(): LabGraph {const c=JSON.parse(JSON.stringify(TEX_CONFIG)) as {nodes:LabNode[];edges:LabGraph["edges"]};return {nodes:c.nodes,edges:c.edges}}

export const WHEN: Array<[string, string]> = [["*","Always"],["action","After an action"],["lookup","Looking things up"],["email","An email"],["card","A card"],["stuck","Stuck"],["job","A job"],["group","Group chats"],["one","1:1 chats"],["down","Model down"],["big","Big ask"]];

export const KINDS: Array<[string, string, string, string]> = [["haiku-5-5","Model step","door","Haiku, Sonnet or Opus writes or decides"],["clef","Judge on an API","judge","Clef or GLM answers a typed question"],["code","Code step","code","No model, a fixed time"],["tool","Tool","tools","Called from inside a model step"]];
