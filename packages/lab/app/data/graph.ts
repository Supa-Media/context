/**
 * Ported verbatim from the Tex Architecture Lab artifact (tex.lc/lab): the
 * canvas graph of Tex's default architecture (mainGraph0, with NODE_INFO's goals and
 * logs applied by mainGraph), the node factory N, the wire styles, the icon paths,
 * the "when" choices and the add-step kinds. The graph itself is Tex's config (`mainGraph`).
 */
import { TEX_CONFIG } from "@context/tex/src/texConfig.cjs";
import { configStamp } from "@context/tex/src/texConfigStamp.cjs";
import { foldGroups, type GroupDefs } from "../engine/groups";
import type { LabEdge, LabGraph, LabNode } from "../types";
// Every architecture with a config of its own (Search, ...), in the Lab draft's shape (`architectures.cjs`).
import { ownGraphs } from "@context/tex/src/architectures.cjs";

export const BASE_SHA: string = "888afb0";
/** The stamp of the config this Lab was built with: a draft made from main keeps it, so Promote merges only its own changes. */
export const MAIN_STAMP: string = configStamp(TEX_CONFIG);

export const WIRES: Record<string, { name: string; dash: string; c: string; w?: number; tip: string; folded?: boolean }> = {
  // "Next", not the artifact's "Next step" (Dev2, 2026-11-14).
  wait:{name:"Next",dash:"",c:"--text2",tip:"Runs when this step is done; what follows waits for it"},
  uses:{name:"Helper",dash:"",c:"--accent",w:3,tip:"Used in the middle of this step, then hands back to it"},
  // Drawn and named as Background, and not offered as its own kind (Dev2, 2026-11-14: "we already have background, so
  // next, and background is really all we need"). The key stays, so configs and the sim's after-the-reply lane are unchanged.
  background:{name:"Background",dash:"7 5",c:"--m-api",tip:"Starts it and moves on; nobody waits for it",folded:true},
  job:{name:"Background",dash:"7 5",c:"--m-api",tip:"Starts it and moves on; nobody waits for it"},
  loop:{name:"Send back",dash:"5 4",c:"--bad",tip:"Sometimes sends the draft back"},
  // A provisional run (Dev2, 2026-11-17): the target starts without waiting for the source, whose output is its go, stop
  // or restart (`when` "stop:<tag>", "restart:<tag>"); until every go, it may do only what the wire's `allow` lets it.
  provisional:{name:"Provisional run",dash:"2 3",c:"--warn",tip:"Starts at once instead of waiting for this step, which can stop or restart it at any point; until it says go, the run may only read (or make writes that can be undone)"},
  // A generator (Dev2, 2026-11-16, the generators model): fire and forget; the target, an input step, starts a run of
  // its own, in this chat or another. Never part of this run: the sim and Replay leave it out.
  generator:{name:"Starts a new run",dash:"8 3 2 3",c:"--team",tip:"Fires and forgets: the target starts a run of its own, here or in another chat, and nothing in this run waits for it"}
};

/** The tags a provisional wire may stop or restart its step on: what Triage and Decide say (Dev2, 2026-11-17). */
export const PROVISIONAL_WHEN: Array<[string, string]> = [["running","A turn is running"],["quiet","Stay quiet"],["wait","Wait for more"]];
/** What a provisional run may do before its go; a wire with no `allow` is "revertible". */
export const PROVISIONAL_ALLOW: Array<[NonNullable<LabEdge["allow"]>, string, string]> = [["read","Read only","Only reads until its go"],["revertible","Revertible","Reads, and writes that can be undone; nothing that cannot be taken back"]];
/** Bursts that do not start a provisional run early (`unless` on the wire). The same list the texting Worker reads. */
export const PROVISIONAL_UNLESS: Array<[string, string, string]> = [["firstLook","First look","A chat Tex is not set up in"],["sms","SMS","An SMS"],["unpaired","One path only","The worker has the workflow or answer-first, not both"]];
/** A wire's name as its label and tooltip say it: a provisional one with what it may do before its go, and which bursts do not start it. */
export const wireName = (e: Pick<LabEdge, "mode" | "allow" | "unless">, wires = WIRES) => (e.mode === "provisional" && wires.provisional ? `${wires.provisional.name} (${e.allow === "read" ? "read only" : "revertible"}${e.unless?.length ? `, unless ${e.unless.join(", ")}` : ""})` : (wires[e.mode] || wires.wait).name);

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
  beat:'<path d="M3 12h4l2-5 4 10 2-5h6"/>',
  repeat:'<path d="M17 3l3 3-3 3"/><path d="M4 12V9a3 3 0 0 1 3-3h13"/><path d="M7 21l-3-3 3-3"/><path d="M20 12v3a3 3 0 0 1-3 3H4"/>',
  plug:'<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>',
  wire:'<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M7.5 16.5c3-1 2-8 9-9"/>'
};

export function N(id: string, label: string, o: Partial<LabNode>): LabNode {
  return Object.assign({id,label,goal:"",log:false,on:true,rounds:1,out:300,ctx:[],ms:0,timeoutS:0,areas:[],file:"",note:"",icon:"judge"},o) as LabNode;
}

export const NODE_INFO: Record<string, { goal: string; logs: string[] | null }> = {
 checkin:{goal:"Three times a day, look at what changed in their workspace, mail and calendar, and text them only what can't wait; most looks stay quiet. Runs the front door with its own read-only tools and setup model.",logs:["note (check-in)"]},
 routine:{goal:"Run a routine note under tex/routines/ on its schedule, as the person who wrote it, and text what it found unless it has nothing to say.",logs:["note (routine)","thinking","tool","judge"]},
 notify:{goal:"Another AI connected to Context asks Tex to text the person (send notify) because something needs them now; their settings decide whether it goes, and it is texted as written, with no model.",logs:["note (ping)"]},
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
 handback:{goal:"Make sure what a job hands back is true and finished before the person hears it.",logs:null},
 egress:{goal:"Let a step that widens who can see something, or acts in the person's name, run only when the person's own words ask for it; anything but a clear yes is a no.",logs:["judge (egress)"]},
 picture:{goal:"Draw a card or graphic, or make a photo with Gemini, for a texted answer; every one is looked at by Card check before it may go.",logs:["tool (picture)"]},
 nudge:{goal:"Every ten texts, or when an answer was about them, write what was learned into About me now instead of waiting for the dream.",logs:["step nudge"]},
 reflect:{goal:"After a hard or corrected turn, write down what worked as a learned skill for next time.",logs:["step reflect"]},
 nightly:{goal:"Start each night's work for a person: the dream and the summaries of their days, and housekeeping, each on the schedule the control plane keeps.",logs:["step nightly"]},
 dream:{goal:"Read the chat since the last dream and the memories that fit, and keep About me true: add what was learned, take out what is no longer so.",logs:["step dream"]},
 daysum:{goal:"Sum up each finished day of the chat not yet summed up, into the chat's ledger, for later turns.",logs:["step daysum"]},
 housekeep:{goal:"Tidy their workspace once a day within its time limit: fix what the health check names, change nothing it cannot undo, and log each change.",logs:["step housekeep"]}
};

/**
 * Main's graph is Tex's one config, `packages/tex/src/texConfig.json` (Dev2, 2026-11-13: "I want the config
 * generated by the lab to become the production code, and to be the only source of truth"). Each call hands back a
 * fresh copy, because the Lab edits the graph it is given.
 */
export function mainGraph(): LabGraph {return mainGraph0()}

/** The config's group definitions (the box of each folded group). */
export const GROUPS: GroupDefs = TEX_CONFIG.groups;

/**
 * A graph's group definitions: main's, with a draft's own over them (`graph.groups`, the `group` edit; 2026-11-16: a
 * draft that gathers steps into a new group names its box). A group a draft drops (`null`) falls back to main's.
 */
export function groupsOf(g: { groups?: Record<string, GroupDefs[string] | null> } | null | undefined): GroupDefs {
  const own = g?.groups;
  if (!own || typeof own !== "object") return GROUPS;
  const out: GroupDefs = { ...GROUPS };
  for (const [id, info] of Object.entries(own)) if (info && typeof info === "object") out[id] = info;
  return out;
}

/** The Lab's start graph: the config with each group folded into its box (Dev2, 2026-11-14: "Focus on it opens all eleven steps"). */
export function mainGraph0(): LabGraph {
  const c = JSON.parse(JSON.stringify(TEX_CONFIG)) as { nodes: LabNode[]; edges: LabGraph["edges"] };
  // Every other architecture's steps sit in main beside Tex's, each tagged with its page (`graph: "search"`, ...) so the
  // Lab draws them there (Dev2, 2026-11-21). Tex's own checks and Promote read only Tex's side (`texSideOf`).
  const own = ownGraphs();
  // Their configs keep only what they need; N fills in the rest of a canvas step's fields, as Tex's own steps have them.
  const ownNodes = own.nodes.map((n) => N(String(n.id), String(n.label), n as Partial<LabNode>));
  return foldGroups({ nodes: [...c.nodes, ...ownNodes], edges: [...c.edges, ...(own.edges as LabEdge[])] }, GROUPS);
}

export const WHEN: Array<[string, string]> = [["*","Always"],["action","After an action"],["lookup","Looking things up"],["email","An email"],["card","A card"],["stuck","Stuck"],["job","A job"],["group","Group chats"],["one","1:1 chats"],["down","Model down"],["big","Big ask"]];

export const KINDS: Array<[string, string, string, string]> = [["haiku-5-5","Model step","door","Haiku, Sonnet or Opus writes or decides"],["clef","Judge on an API","judge","Clef or GLM answers a typed question"],["code","Code step","code","No model, a fixed time"],["tool","Tool","tools","Called from inside a model step"],["run","New run","repeat","Starts a new run of the chat at an input step"]];
