/**
 * Ported verbatim from the Tex Architecture Lab artifact (tex.lc/lab): the
 * model table the Lab prices and times against (BASE_MODELS), the effort multipliers
 * (EFFORT) and the typed-output field types (FTYPES).
 */
import type { LabModel } from "../types";

export const BASE_MODELS: Record<string, LabModel> = {
  "haiku-5-5": {name:"Haiku",full:"Haiku 5.5",id:"anthropic/claude-haiku-5-5",c:"--m-haiku",runs:"subscription",base:1400,perTok:4.1,cacheR:0.01,cacheW:0.125,outP:0.5,measured:true,typed:"schema"},
  "sonnet-5-5":{name:"Sonnet",full:"Sonnet 5.5",id:"anthropic/claude-sonnet-5-5",c:"--m-sonnet",runs:"subscription",base:1800,perTok:8,cacheR:0.2,cacheW:2.5,outP:10,typed:"schema"},
  "opus-5-5":  {name:"Opus",full:"Opus 5.5",id:"anthropic/claude-opus-5-5",c:"--m-opus",runs:"subscription",base:2500,perTok:13,cacheR:0.2,cacheW:5,outP:20,typed:"schema"},
  "clef":      {name:"Clef",full:"Clef (Cloudflare)",id:"@cf/cloudflare/clef",c:"--m-api",runs:"api",base:350,perTok:1.5,cacheR:0.24,cacheW:0.24,outP:0,typed:"only",note:"Answers typed questions only: yes or no, a choice, a score. It never writes text."},
  "glm-4-7":   {name:"GLM",full:"GLM-4.7 Flash",id:"@cf/zai-org/glm-4.7-flash",c:"--m-api",runs:"api",base:900,perTok:6,cacheR:0.06,cacheW:0.06,outP:0.4,typed:"json"},
  "code":      {name:"Code",full:"Code, no model",c:"--m-code",runs:"code"}
};

export const EFFORT: Record<string, number> = {off:0.45,low:0.55,medium:1,high:2,xhigh:3,max:4};

export const FTYPES: Record<string, { name: string; tok: number; clef?: string }> = {yesno:{name:"Yes or no",tok:3,clef:"noul"},choice:{name:"Choice",tok:6,clef:"choice"},score:{name:"Score",tok:4,clef:"score"},text:{name:"Text",tok:60}};
