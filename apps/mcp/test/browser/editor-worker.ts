// Test-only entry point. No production config references it.
import worker, { PresenceRoom } from "../../src/index.js";
import { R2Store } from "../../src/store/r2.js";
import { listFolder, readFile, writeFile, trashPath, restoreTrashedPath } from "../../../convex/functions/lib/fileOps";
export { PresenceRoom };
export default {
  async fetch(request: Request, env: any, ctx: any) {
    const url = new URL(request.url);
    if (url.pathname !== "/__fixture/action") return worker.fetch(request, env, ctx);
    const headers = { "content-type":"application/json", "access-control-allow-origin":"http://127.0.0.1:8798", "access-control-allow-headers":"content-type,x-fixture-user" };
    if (request.method === "OPTIONS") return new Response(null, { headers });
    const user = request.headers.get("x-fixture-user");
    if (!["ana","bo","reader"].includes(user ?? "")) return new Response("{}",{status:401,headers});
    const { name, args } = await request.json() as any;
    const store = new R2Store(env.LOCAL_BUCKET);
    const clearance = { scope: "team" as const, names: new Set<string>() };
    try {
      let value: any;
      switch(name) {
        case "mintConsoleGrant": value = { accessToken:`cat_local_verification_token_${user}` }; break;
        case "listFiles": value = await listFolder(store, { path:args.path, clearance }); break;
        case "readNote": value = await readFile(store, { path:args.path, clearance }); break;
        case "readRaw": { const object = await store.get(args.path); value = object ? {text:await object.text(),etag:object.etag} : null; break; }
        case "writeNote":
          if(user === "reader") throw Object.assign(new Error("read only"),{code:"FORBIDDEN"});
          value = await writeFile(store,{...args,clearance,now:Date.now()}); break;
        case "trashNote":
          if(user !== "ana") throw Object.assign(new Error("owner only fixture action"),{code:"FORBIDDEN"});
          value = await trashPath(store,{...args,clearance,now:Date.now()}); break;
        case "restoreNote":
          if(user !== "ana") throw Object.assign(new Error("owner only fixture action"),{code:"FORBIDDEN"});
          value = await restoreTrashedPath(store,{...args,clearance}); break;
        case "notePaths": value = { paths:["1-projects/verify.md","1-projects/empty.md","1-projects/second.md"], truncated:false }; break;
        default: throw new Error(`Unhandled local action ${name}`);
      }
      return new Response(JSON.stringify(value),{headers});
    } catch(error:any) {
      return new Response(JSON.stringify({code:error.code??"ERROR",message:error.message,currentEtag:error.currentEtag}),{status:400,headers});
    }
  }
};
