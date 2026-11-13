/**
 * Ported verbatim from the Tex Architecture Lab artifact (tex.lc/lab): the
 * canvas graph of Tex's default architecture (mainGraph0, with NODE_INFO's goals and
 * logs applied by mainGraph), the node factory N, the wire styles, the icon paths,
 * the "when" choices and the add-step kinds.
 */
import type { LabGraph, LabNode } from "../types";

export const BASE_SHA: string = "7188420";

export const WIRES: Record<string, { name: string; dash: string; c: string; w?: number; tip: string }> = {
  wait:{name:"Next step",dash:"",c:"--text2",tip:"Runs when this step is done, before the reply"},
  uses:{name:"Helper",dash:"",c:"--accent",w:3,tip:"Used in the middle of this step, then hands back to it"},
  behind:{name:"After sending",dash:"2 4",c:"--dim",tip:"Runs once the reply has gone; nobody waits for it"},
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

export function mainGraph(): LabGraph {const g=mainGraph0();for(const n of g.nodes){const i=NODE_INFO[n.id]||{};n.goal=i.goal||"";n.log=!!i.logs}return g}

export function mainGraph0(): LabGraph {return {
 nodes:[
  N("text","A text arrives",{kind:"input",model:"code",icon:"text",x:0,y:330,file:"apps/agent"}),
  N("decide","Decide",{model:"clef",out:40,outSchema:[{name:"act",type:"choice",options:"quiet, respond, wait"},{name:"also_react",type:"yesno"},{name:"wait_seconds",type:"score",options:"1-10"},{name:"moved_on",type:"yesno"},{name:"emoji",type:"choice",options:"one per reaction"},{name:"why",type:"choice",options:"the examples' reasons"}],icon:"judge",ctx:["examples","recent","groupBrief","date"],x:220,y:230,file:"textsDecide.js · textDecide.cjs",areas:["respond"]}),
  N("lanes","Queue",{model:"code",ms:1000,icon:"queue",x:220,y:430,file:"apps/agent inbox.ts · groupTurn.ts"}),
  N("door","Door steps",{model:"code",ms:1500,icon:"code",x:440,y:330,file:"texEntryPoint/*",areas:["core","pipeline"]}),
  N("router","Router",{model:"clef",on:false,out:20,outSchema:[{name:"tier",type:"choice",options:"lookup, change, think"}],icon:"router",ctx:["recent"],x:660,y:190,file:"router.js",areas:["core"]}),
  N("fd","Front door",{model:"haiku-5-5",effort:"medium",rounds:2,out:270,icon:"door",ctx:["tools","skills","map","p-about-tex","p-rules","p-tools","p-working","p-sound-like-a-person","p-pictures","p-how-you-talk","caps","hist","threads","about","date","ask"],x:660,y:330,file:"turn.js runTurn",areas:["core"]}),
  N("fallback","Fallback",{model:"glm-4-7",on:false,icon:"shield",x:660,y:470,file:"builtin.js"}),
  N("planner","Big-ask planner",{model:"opus-5-5",effort:"high",on:false,out:900,icon:"advisor",ctx:["own","ask","caps"],x:660,y:50,file:"planBigAsk.js",areas:["advisor-planner"]}),
  N("tools","Tools",{model:"code",ms:900,kind:"tool",icon:"tools",x:880,y:90,file:"callToolForSession"}),
  N("advisor","Advisor",{model:"opus-5-5",effort:"high",out:700,timeoutS:40,icon:"advisor",ctx:["own","caps","about","ask","ledger","hist","date"],x:880,y:210,file:"advisor.js · advisorRoles/chat.js",areas:["advisor-chat"]}),
  N("checks","Answer checks",{model:"code",ms:60,icon:"code",x:880,y:330,file:"doItChecks.js",areas:["review"]}),
  N("mail","Mail checker",{model:"haiku-5-5",effort:"medium",out:200,icon:"mail",ctx:["own","draft","ask"],x:1100,y:10,file:"mailChecker.js"}),
  N("card","Card check",{model:"haiku-5-5",effort:"medium",out:200,icon:"card",ctx:["own","draft"],x:1100,y:120,file:"cardCheck.js"}),
  N("reviewer","Reply reviewer",{model:"haiku-5-5",effort:"medium",out:350,outSchema:[{name:"kind",type:"choice",options:"task, question, chat, correction, report, scheduled"},{name:"verdict",type:"choice",options:"ok, send_back"},{name:"problems",type:"text"},{name:"feedback",type:"text"}],timeoutS:8,sendBack:0.12,icon:"judge",ctx:["own","ledger","ask","draft","hist","date"],x:1100,y:240,file:"replyJudge.js · sendBack.js",areas:["review"]}),
  N("send","Text them",{model:"code",ms:900,icon:"send",outSchema:[{name:"texts",type:"text",options:"one or more bubbles"},{name:"card",type:"text",options:"a link card, when there is one"},{name:"reaction",type:"choice",options:"a tapback on their text, or none"}],x:1320,y:330,file:"sendTheReply · sendOne.ts"}),
  N("react","React",{model:"code",ms:400,icon:"emoji",outSchema:[{name:"emoji",type:"choice",options:"Decide's pick, if on the allowlist"}],x:440,y:130,file:"decide.ts reactionFor · reactions.ts",areas:["respond"]}),
  N("classifier","Classifier",{model:"haiku-5-5",effort:"off",out:150,icon:"thread",ctx:["own","threads","recent"],x:1320,y:500,file:"conversationThreads.js"}),
  N("selfreview","Self-review",{model:"haiku-5-5",effort:"medium",out:300,icon:"star",ctx:["own","hist"],x:1320,y:610,file:"selfReview.js"}),
  N("job","Background job",{model:"haiku-5-5",effort:"high",rounds:12,out:400,icon:"job",ctx:["tools","map","p-about-tex","p-rules","p-tools","p-working","brief","ask","date"],x:880,y:640,file:"background.js",areas:["jobs"]}),
  N("jobcheck","Job check",{model:"opus-5-5",effort:"high",rounds:3,out:600,icon:"advisor",ctx:["own","brief","ask","ledger","out:job"],x:1100,y:760,file:"jobCheck.js",areas:["advisor-job-check","jobs"]}),
  N("mailadv","Advisor on job mail",{model:"opus-5-5",effort:"high",out:400,icon:"mail",ctx:["own","brief","ask"],x:1320,y:760,file:"jobNote.js · advisorRoles/jobMail.js",areas:["advisor-job-mail"]}),
  N("handback","Hand-back judge",{model:"haiku-5-5",effort:"medium",out:200,icon:"judge",ctx:["own","brief","draft"],x:1100,y:640,file:"handbackJudge.js · claimCheck.js",areas:["jobs"]})
 ],
 edges:[
  {from:"text",to:"decide",mode:"wait",when:["*"]},{from:"decide",to:"react",mode:"wait",when:["*"]},{from:"decide",to:"lanes",mode:"wait",when:["*"]},{from:"lanes",to:"door",mode:"wait",when:["*"]},
  {from:"door",to:"fd",mode:"wait",when:["*"]},{from:"door",to:"router",mode:"wait",when:["*"]},{from:"router",to:"fd",mode:"wait",when:["*"]},
  {from:"fd",to:"tools",mode:"uses",when:["action"]},{from:"fd",to:"advisor",mode:"uses",when:["stuck"]},{from:"fd",to:"fallback",mode:"uses",when:["down"]},{from:"fd",to:"planner",mode:"uses",when:["big"]},
  {from:"tools",to:"mail",mode:"uses",when:["email"]},{from:"tools",to:"card",mode:"uses",when:["card"]},
  {from:"fd",to:"checks",mode:"wait",when:["*"]},{from:"checks",to:"reviewer",mode:"wait",when:["action"]},{from:"checks",to:"send",mode:"wait",when:["*"]},
  {from:"reviewer",to:"send",mode:"wait",when:["action"]},{from:"reviewer",to:"fd",mode:"loop",when:["action"]},
  {from:"send",to:"classifier",mode:"behind",when:["*"]},{from:"send",to:"selfreview",mode:"behind",when:["*"]},
  {from:"fd",to:"job",mode:"job",when:["job"]},{from:"job",to:"tools",mode:"uses",when:["job"]},{from:"job",to:"jobcheck",mode:"uses",when:["job"]},{from:"job",to:"handback",mode:"job",when:["job"]},{from:"job",to:"mailadv",mode:"uses",when:["job"]}
 ]};}

export const WHEN: Array<[string, string]> = [["*","Always"],["action","After an action"],["lookup","Looking things up"],["email","An email"],["card","A card"],["stuck","Stuck"],["job","A job"],["group","Group chats"],["one","1:1 chats"],["down","Model down"],["big","Big ask"]];

export const KINDS: Array<[string, string, string, string]> = [["haiku-5-5","Model step","door","Haiku, Sonnet or Opus writes or decides"],["clef","Judge on an API","judge","Clef or GLM answers a typed question"],["code","Code step","code","No model, a fixed time"],["tool","Tool","tools","Called from inside a model step"]];
