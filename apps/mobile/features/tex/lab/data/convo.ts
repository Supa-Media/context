/**
 * Ported verbatim from the Tex Architecture Lab artifact (tex.lc/admin/lab): the
 * default conversation-view settings (CV_MAIN), the ledger entry kinds (CV_KINDS)
 * and the chat tools that can be switched on or off (CV_TOOLS).
 */
import type { ConvoSettings } from "../types";

export const CV_MAIN: ConvoSettings = {word:24,older:80000,threads:50,days:60,dayChars:12000,slim:true,classify:"after",tools:{read_thread:true,earlier_texts:true,earlier_chat:true,close_thread:false,retitle_thread:false,move_text:false}};

export const CV_KINDS: Array<[string, string, string, string]> = [
 ["text","Worker (texts in, parts out), routines","A text: who sent it, words, delivered, reply-to","yes"],
 ["reply","Front door","The turn's answer, its time, model, facts it used","yes"],
 ["tool","Front door, jobs","A tool call: args, ok, ms, result (cut at 64k)","names only"],
 ["thinking","Front door","The model's thinking, per round","no"],
 ["said","Front door","Words between tools","no"],
 ["advisor","Advisor","Question, answer, ms","no"],
 ["judge","Reply reviewer","Draft, verdict, what went back","no"],
 ["mail_check","Mail checker","To, subject, verdict","no"],
 ["job","Background jobs","Job, title, state","no"],
 ["note","Routines, check-ins","Anything else worth keeping","yes"],
 ["name","Group turn","A name given to a guest label","no"],
 ["brief","Group turn","What the turn knew, for the judge","no"],
 ["day","Nightly","One finished day summed up","yes"]];

export const CV_TOOLS: Record<string, [string, string, boolean]> = {read_thread:["Read one thread whole","read",true],earlier_texts:["Read older 1:1 texts","read",true],earlier_chat:["Read older group texts","read",true],
 close_thread:["Mark a thread finished","change",false],retitle_thread:["Rename a thread","change",false],move_text:["Move a text to another thread","change",false]};
