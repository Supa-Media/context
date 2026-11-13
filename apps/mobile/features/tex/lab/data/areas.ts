/**
 * Ported verbatim from the Tex Architecture Lab artifact (tex.lc/admin/lab): the
 * trace groups, the area names, which areas are examinable, the setup fields, what
 * each area checks and feeds (AREA_INFO, AREA_IO), and the test people and group chats.
 */
import type { LabCase } from "../types";

export const TRACE_GROUPS: Record<string, string> = {core:"Front door tests",jobs:"Background job tests",pipeline:"Pipeline replays",own:"Your own"};

export const AREAS: Record<string, string> = {respond:"Should Tex answer",review:"Reply reviewer",core:"Front door and prompt","advisor-chat":"Advisor in a chat","advisor-job-check":"Advisor's job check","advisor-planner":"Big-ask planner","advisor-job-mail":"Advisor on job mail",jobs:"Background jobs",pipeline:"Pipeline replays"};

export const EXAMINABLE: Set<string> = new Set(["pipeline","respond","review","core","advisor-chat","advisor-job-check","advisor-planner","advisor-job-mail"]);

export const SETUP_FIELDS: Record<string, string> = {"fd.model":"models.main","fd.effort":"models.effort","advisor.model":"models.advisor","advisor.effort":"models.advisor_effort","job.effort":"models.job_effort","fallback.model":"models.fallback","planner.on":"plan_big_asks","router.on":"models.router"};

export const AREA_INFO: Record<string, { step: string; as?: string; how: string; want: string; int?: string }> = {
 core:{step:"fd",as:"Maya",how:"Texts Tex 1:1",want:"Tex must",int:"lookup"},
 pipeline:{step:"door",how:"Tex's real /agent route, stores and ledger, with a scripted model. Free, on every pull request.",want:"Must not come back",int:"plain"},
 jobs:{step:"job",as:"Maya",how:"Texts Tex 1:1 and starts a job",want:"Done when",int:"job"},
 respond:{step:"decide",how:"Invented chats, 1:1 and group. Tex sees only the chat.",want:"Tex should"},
 review:{step:"reviewer",how:"Tex's draft, the ask and the tools it used",want:"Reviewer should"},
 "advisor-chat":{step:"advisor",how:"A short brief on the person and Tex's tool results",want:"Advisor should"},
 "advisor-job-check":{step:"jobcheck",how:"A job's brief, its steps and its answer",want:"Advisor should"},
 "advisor-planner":{step:"planner",how:"One big ask",want:"Planner picks"},
 "advisor-job-mail":{step:"mailadv",how:"A running job mails Tex a question",want:"Advisor should"}};

export const GROUP_CHATS: Array<{ name: string; ws: string; with: string; note: string }> = [{name:"band chat",ws:"band",with:"Priya",note:"The band workspace's group chat (tests/group-stretch.md). Not in the replay gate yet."}];

export const PEOPLE: Record<string, { ws: Array<{ n: string; kind: string; role: string; notes: number; with?: string }> }> = {Maya:{ws:[{n:"maya",kind:"personal",role:"owner",notes:30},{n:"fashion-brand",kind:"shared",role:"owner",notes:15,with:"John, Priya"},{n:"band",kind:"shared",role:"member",notes:12,with:"Priya"}]}};

export const AREA_IO: Record<string, { gives: string[]; fixture?: string[]; check: { field?: string; map?: (c: LabCase) => string; how: string; words?: boolean; code?: boolean } }> = {
 respond:{gives:["recent","date"],check:{field:"act",map:(c: LabCase)=>/quiet/i.test(c.expect)?"quiet":"respond",how:"Clef's act answer"}},
 review:{gives:["ask","draft","ledger","hist"],check:{field:"verdict",map:(c: LabCase)=>/back/i.test(c.expect)?"send_back":"ok",how:"the reviewer's JSON verdict"}},
 core:{gives:["ask"],fixture:["about","hist"],check:{words:true,how:"a Haiku judge reads the reply against each must line"}},
 jobs:{gives:["ask","brief"],check:{words:true,how:"a judge reads the notes against done-when"}},
 pipeline:{gives:[],check:{code:true,how:"code checks what the model was shown and what the chat kept"}},
 "advisor-chat":{gives:["ask","ledger","about"],check:{words:true,how:"decline or advise, read from its words"}},
 "advisor-job-check":{gives:["brief","ledger","out:job"],check:{words:true,how:"the verdict read from its answer"}},
 "advisor-planner":{gives:["ask"],check:{words:true,how:"now, one job or split, read from its plan"}},
 "advisor-job-mail":{gives:["brief","ask"],check:{words:true,how:"its answer must match the case's patterns"}}};
