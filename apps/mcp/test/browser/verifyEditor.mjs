/**
 * Mounted production editor + room hook + autosave against a local Worker/R2.
 * Fake identities and the Convex transport are the only service substitutions.
 * See artifacts/collaboration/README.md for scope, commands, and limitations.
 * Every expected product behavior below is a release gate.
 */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { startLocalControlPlane } from "../localControlPlane.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATEWAY = "http://127.0.0.1:8799";
const PAGES = 8798;
const CONTROL = 8797;
const SECRET = "local-verification-secret-not-real";
const NOTE = "1-projects/verify.md";
const ANA = "cat_local_verification_token_ana";
const BO = "cat_local_verification_token_bo";
const READER = "cat_local_verification_token_reader";
/** A tool with its own grant, which is what an agent writing a note actually is. */
const TOOL = "cat_local_verification_token_tool";
const MCP_DIR = join(HERE, "..", "..");
// A bucket of this run's own, thrown away first, so a second run is not a
// different test from the first one.
const STATE = join(MCP_DIR, ".wrangler", "editor-verify-state");

/**
 * The privacy manifest every real context already has.
 *
 * It cannot be written through the gateway — `privacy.md` is a reserved path,
 * deliberately, so no MCP client can rewrite the rules that govern it — and it
 * is created when the workspace is, which is a control-plane step this
 * verification does not run. So it is put into the bucket directly, exactly as
 * onboarding would leave it: default private, and **no folder rule**, so that
 * the rule this verification needs is the one `set_folder_visibility` writes
 * through the product's own path a moment later.
 */
const PRIVACY_MANIFEST = [
  "---",
  "role: privacy-manifest",
  "version: 1",
  "---",
  "",
  "# Privacy Map",
  "",
  "<!-- BEGIN BRAIN PRIVACY RULES -->",
  "",
  "```yaml",
  "default_visibility: private",
  "",
  "folder_defaults:",
  "  # No folder defaults. All content is private.",
  "",
  "note_overrides:",
  "  # No exact-note overrides.",
  "```",
  "",
  "<!-- END BRAIN PRIVACY RULES -->",
  "",
].join("\n");

const results = [];
const ARTIFACTS=join(MCP_DIR,"../../artifacts/collaboration");
mkdirSync(ARTIFACTS,{recursive:true});
const check = (label, passed, detail = "") => {
  results.push({ label, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

/** Wait for a condition, because a socket is not synchronous. */
async function until(fn, { timeout = 8000, every = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, every));
  }
}

async function main() {
  const controlPlane = await startLocalControlPlane({
    port: CONTROL,
    gatewaySecret: SECRET,
    bindingName: "LOCAL_BUCKET",
  });

  const staticServer = spawn(process.execPath, [join(MCP_DIR,"../mobile/e2e/webkit/static-server.mjs"), join(MCP_DIR,"../mobile/web-build"), String(PAGES)], {stdio:"ignore"});
  const pages = {close: (done) => {staticServer.kill(); done();}};
  process.on("exit",()=>staticServer.kill());
  rmSync(STATE, { recursive: true, force: true });
  mkdirSync(STATE, { recursive: true });
  const manifest = join(STATE, "privacy.md");
  writeFileSync(manifest, PRIVACY_MANIFEST);
  const seededManifest = spawnSync(
    "npx",
    [
      "wrangler",
      "r2",
      "object",
      "put",
      "local-verification/privacy.md",
      "--file",
      manifest,
      "--local",
      "--persist-to",
      STATE,
      "--config",
      "wrangler.editor-verify.toml",
    ],
    { cwd: MCP_DIR, encoding: "utf8" },
  );
  if (seededManifest.status !== 0) {
    console.log("FAIL  the bucket could not be given a privacy manifest");
    console.log((seededManifest.stderr || "").slice(-2000));
    process.exit(1);
  }

  let worker;
  let workerLog = "";
  const collect = (chunk) => { workerLog += chunk; };
  const startWorker = () => {
  worker = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--config",
      "wrangler.editor-verify.toml",
      "--port",
      "8799",
      "--local",
      "--persist-to",
      STATE,
    ],
    { cwd: MCP_DIR, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  worker.stdout.on("data", collect);
  worker.stderr.on("data", collect);
  };
  startWorker();
  const stopWorker = () => {
    try {
      process.kill(-worker.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  };
  process.on("exit", stopWorker);

  const up = await until(
    async () => {
      try {
        const res = await fetch(`${GATEWAY}/.well-known/oauth-authorization-server`);
        return res.ok;
      } catch {
        return false;
      }
    },
    { timeout: 60_000 },
  );
  if (!up) {
    console.log("FAIL  the gateway did not start");
    console.log(workerLog.slice(-4000));
    process.exit(1);
  }

  // Playwright is pointed at the preinstalled browsers by PLAYWRIGHT_BROWSERS_PATH,
  // so let it resolve its own binary rather than hard-coding a path that moves
  // with the revision.
  /*
    Seed through the real MCP tools, not by writing into the bucket behind the
    gateway's back.

    Two things have to be true before a socket can open on a note: the note has
    to exist (`handlePresence` lists for it, and answers 404 for a path with
    nothing at it), and the people who are not the owner have to be able to see
    it (they connect at `team` tier, and a folder with no rule defaults to
    private). Both are set here the way a person would set them — `write_note`
    and `set_folder_visibility` over `/t/<token>/mcp` — so the fixture is the
    product's own save path rather than a bucket the test arranged to its own
    liking.
  */
  let rpcId = 0;
  const callTool = async (token, name, args) => {
    const response = await fetch(`${GATEWAY}/t/${token}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const text = await response.text();
    // The transport may answer as SSE; the payload is the same JSON either way.
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    const body = JSON.parse(line ? line.slice(6) : text);
    if (!response.ok || body?.error || body?.result?.isError === true) {
      const detail = body?.error?.message ?? body?.result?.content?.map((part) => part.text ?? "").join("\n") ?? text;
      throw new Error(`${name} failed (${response.status}): ${detail}`);
    }
    return body.result ?? body;
  };

  const rawNote = async (path) => {
    const response = await fetch(`${GATEWAY}/__fixture/action`,{method:"POST",headers:{"content-type":"application/json","x-fixture-user":"ana"},body:JSON.stringify({name:"readRaw",args:{path}})});
    if(!response.ok) throw new Error(`raw read failed ${response.status}`);
    return await response.json();
  };
  const rawMarker = async (path) => {
    const response = await fetch(`${GATEWAY}/__fixture/action`,{method:"POST",headers:{"content-type":"application/json","x-fixture-user":"ana"},body:JSON.stringify({name:"readRawPhysical",args:{path}})});
    if(!response.ok) throw new Error(`physical read failed ${response.status}`);
    return await response.json();
  };

  const textOf = (result) =>
    (result?.content ?? []).map((part) => part.text ?? "").join("\n");

  const seeded = await callTool(ANA, "write_note", {
    path: NOTE,
    content: "# Verify\n\nfirst line\n",
    summary: "seed the note this verification edits",
  });
  check("the note is created through the real MCP save path", !seeded?.isError, textOf(seeded).slice(0, 120));

  const dryRun = await callTool(ANA, "set_folder_visibility", {
    path: "1-projects",
    visibility: "team",
    dry_run: true,
  });
  const etag = textOf(dryRun).match(/etag[^a-z0-9]*([A-Za-z0-9"._-]+)/i)?.[1]?.replace(/"/g, "");
  const shared = await callTool(ANA, "set_folder_visibility", {
    path: "1-projects",
    visibility: "team",
    expected_privacy_etag: etag,
    confirm_team_publish: true,
  });
  check(
    "the folder is shared with the workspace through the real manifest",
    !shared?.isError,
    textOf(shared).slice(0, 120),
  );


  for (const [path,content] of [["1-projects/empty.md",""],["1-projects/second.md","# Second note\n\nDifferent content.\n"],...["typing-bursts","agent-race","handoff","offline","offline-reload","offline-create-seed","offline-rename","offline-trash","retry","restart","abrupt","revoked"].map(n=>[`1-projects/${n}.md`,"# Verify\n\nfirst line\n"])]) {
    const result=await callTool(ANA,"write_note",{path,content,visibility:"team",confirm_team_publish:true});
    if(result.isError) throw new Error(textOf(result));
  }
  const browser = await chromium.launch();
  const errors=[];
  const open=async(user,note=NOTE)=>{
    const context=await browser.newContext({viewport:{width:1280,height:900}});
    const links=[];let disconnected=false;
    if(note.includes("offline")) await context.routeWebSocket(/\/presence\?/,ws=>{
      if(disconnected){void ws.close({code:1012,reason:"test network loss"});return;}
      const peer=ws.connectToServer();links.push({ws,peer});
    });
    const page=await context.newPage();
    const traffic=[];
    page.on("request",request=>{
      const url=request.url();
      if(!url.includes("/collaboration")&&!url.includes("/files"))return;
      let body;
      try{body=request.postDataJSON?.();}catch{body=request.postData?.();}
      traffic.push({kind:"request",method:request.method(),url,body});
    });
    page.on("response",async response=>{
      const url=response.url();
      if(!url.includes("/collaboration")&&!url.includes("/files"))return;
      let body="";
      try{body=(await response.text()).slice(0,1200);}catch{}
      traffic.push({kind:"response",status:response.status(),url,body});
    });
    page.on("response",async r=>{if(r.url().includes("/__fixture")&&!r.ok()) errors.push({user,status:r.status(),body:await r.text()});});
    page.on("pageerror",error=>errors.push({user,message:error.message}));
    page.on("console",msg=>{if(msg.type()==="error") errors.push({user,message:msg.text().slice(0,500)});});
    await page.goto(`http://127.0.0.1:${PAGES}/e2e-fixture?screen=collaboration&user=${user}&note=${encodeURIComponent(note)}`);
    await page.locator(".cm-content").waitFor({timeout:60000});
    await page.waitForFunction(()=>window.fixture?.presence.settled,{},{timeout:20000});
    return {context,page,traffic,
      cut:async()=>{if(!links.length)throw new Error("Fault injector observed no presence socket");disconnected=true;await Promise.all(links.flatMap(({ws,peer})=>[ws.close({code:1012,reason:"test network loss"}),peer.close({code:1012,reason:"test network loss"})]));},
      reconnect:()=>{disconnected=false;}
    };
  };
  const text=page=>page.evaluate(()=>window.fixture?.editorText() ?? "");
  const state=page=>page.evaluate(()=>({editorText:window.fixture.editorText(),sync:window.fixture.files.sync,settled:window.fixture.presence.settled,status:window.fixture.files.editor.status,collaboration:window.fixture.presence.collaboration&&{status:window.fixture.presence.collaboration.status,pending:window.fixture.presence.collaboration.pending,etag:window.fixture.presence.collaboration.etag},phase:window.fixture.presence.phase,saver:window.fixture.presence.canWrite,draft:window.fixture.files.editor.draft,shared:window.fixture.presence.shared?.markdown(),etag:window.fixture.files.editor.etag,members:window.fixture.presence.members.map(m=>m.name)}));
  const append=async(page,words)=>{
    await page.locator(".cm-content").click();
    await page.keyboard.press("ControlOrMeta+End");
    const parts=String(words).split("\n");
    if(parts[0]) await page.keyboard.insertText(parts[0]);
    for(const part of parts.slice(1)){
      await page.keyboard.press("Enter");
      if(part) await page.keyboard.insertText(part);
    }
  };
  const screenshot=async(page,name)=>page.screenshot({path:join(ARTIFACTS,name+".png"),fullPage:true});
  const pair=async(note,run)=>{
    const sessions=[];
    try {
      const a=await open("ana",note);sessions.push(a);
      const b=await open("bo",note);sessions.push(b);
      await run(a,b);
    } catch(error){check(`scenario ${note} completes`,false,error.stack);}
    finally {for(const s of sessions)await s.context.close().catch(()=>{});}
  };
  try {
    await pair(NOTE,async(a,b)=>{
      check("real React editors join with pre-existing text",(await text(a.page)).includes("first line") && (await text(b.page)).includes("first line"));
      await Promise.all([append(a.page,"\nALPHA from human A"),append(b.page,"\nBETA from human B")]);
      check("typing in both mounted editors converges",await until(async()=>{const x=await text(a.page);return x===await text(b.page)&&x.includes("ALPHA")&&x.includes("BETA");}));
      await screenshot(a.page,"01-human-a");await screenshot(b.page,"02-human-b");
      check("ordinary autosave persists both humans",await until(async()=>{const t=textOf(await callTool(ANA,"read_note",{path:NOTE}));return t.includes("ALPHA")&&t.includes("BETA");},{timeout:18000}));
      check("saved status matches the actual bucket and clears the draft",await until(async()=>{
        const [aState,bState,bucket]=await Promise.all([state(a.page),state(b.page),rawNote(NOTE)]);
        return [aState,bState].every(one=>one.collaboration?.status==="saved"&&one.collaboration.pending===0&&one.status==="saved"&&one.draft===bucket.text);
      },{timeout:18000}));
      await b.page.reload();await b.page.locator(".cm-content").waitFor();
      check("reload restores both humans",await until(async()=>{const t=await text(b.page);return t.includes("ALPHA")&&t.includes("BETA");}));
      await Promise.all([a.page.getByText("Second note",{exact:true}).click(),b.page.getByText("Second note",{exact:true}).click()]);
      await until(async()=> (await text(a.page)).includes("Different content") && (await text(b.page)).includes("Different content"));
      await append(a.page,"\nNAVIGATION edit");
      check("collaboration works after switching to another nonempty note",await until(async()=> (await text(b.page)).includes("NAVIGATION edit")));
    });
    await pair("1-projects/empty.md",async(a,b)=>{
      await append(b.page,"EMPTY note now has text");
      check("settled empty note relays actual typing",await until(async()=> (await text(a.page)).includes("EMPTY note now has text")));
      results.push({label:"empty note states",detail:[await state(a.page),await state(b.page)],diagnostic:true});
      await screenshot(a.page,"02-empty-a");await screenshot(b.page,"02-empty-b");
    });
    await pair("1-projects/agent-race.md",async(a,b)=>{
      const path="1-projects/agent-race.md";
      const original=textOf(await callTool(TOOL,"read_note",{path}));
      const etag=original.match(/^etag: (.+)$/m)[1];const body=original.slice(original.indexOf("\n\n")+2);
      await append(a.page,"\nUNSAVED human sentence");
      const agent=await callTool(TOOL,"write_note",{path,content:body.replace("# Verify","# Agent renamed heading"),expected_etag:etag});
      check("agent write accepted against saved base",!agent.isError,textOf(agent).slice(0,160));
      check("agent edit preserves concurrent unsaved human sentence",await until(async()=>{
        const [left,right,bucket]=await Promise.all([text(a.page),text(b.page),rawNote(path)]);
        return left===right && left===bucket.text && left.includes("Agent renamed heading") && left.includes("UNSAVED human sentence");
      },{timeout:15000}));
      results.push({label:"agent race states",detail:[await state(a.page),await state(b.page)],diagnostic:true});
      await screenshot(a.page,"03-after-agent");
    });
    await pair("1-projects/handoff.md",async(a,b)=>{
      const path="1-projects/handoff.md";
      const saver=a;const survivor=b;
      await append(saver.page,"\nBEFORE handoff");
      check("one editor saves before leaving",await until(async()=>textOf(await callTool(ANA,"read_note",{path})).includes("BEFORE handoff"),{timeout:18000}));
      await saver.context.close();
      await append(survivor.page,"\nSURVIVOR saves");
      check("remaining editor saves after the other leaves",await until(async()=>textOf(await callTool(ANA,"read_note",{path})).includes("SURVIVOR saves"),{timeout:18000}));
      results.push({label:"handoff state",detail:await state(survivor.page),diagnostic:true});
    });
    for(const reloadOffline of [false,true]) {
      const path=reloadOffline?"1-projects/offline-reload.md":"1-projects/offline.md";
      await pair(path,async(a,b)=>{
        const off=b;const online=a;
        if(reloadOffline){
          await off.page.waitForFunction(()=>navigator.serviceWorker.controller!==null,null,{timeout:15000});
          await off.page.reload();await off.page.locator(".cm-content").waitFor();
        }
        await off.context.setOffline(true);await off.cut();
        await off.page.waitForFunction(()=>window.fixture.presence.phase!=="live",null,{timeout:5000});
        await append(off.page,"\nOFFLINE sentence preserved");await append(online.page,"\nONLINE sentence preserved");
        await until(async()=>textOf(await callTool(ANA,"read_note",{path})).includes("ONLINE sentence preserved"),{timeout:18000});
        await new Promise(r=>setTimeout(r,2500));
        check(`${path}: offline edits remain visible`,(await text(off.page)).includes("OFFLINE sentence preserved"));
        if(reloadOffline) {
          await off.page.reload();await off.page.locator(".cm-content").waitFor({timeout:20000});
          check("offline cold reload restores local writing",(await text(off.page)).includes("OFFLINE sentence preserved"));
        }
        off.reconnect();await off.context.setOffline(false);
        const merged=await until(async()=>{const x=await text(off.page);return x===await text(online.page)&&x.includes("OFFLINE sentence preserved")&&x.includes("ONLINE sentence preserved");},{timeout:15000});
        check(`${path}: reconnect merges both without intervention`,merged);
        check(`${path}: both edits reach actual Markdown storage`,await until(async()=>{const n=await rawNote(path);return n.text.includes("\nOFFLINE sentence preserved")&&n.text.includes("\nONLINE sentence preserved");},{timeout:20000}));
        check(`${path}: no conflict decision required`,(await state(off.page)).status!=="conflict" && (await state(off.page)).sync.counts.conflicted===0);
        results.push({label:path+" states",detail:[await state(off.page),await state(online.page)],diagnostic:true});
        await screenshot(off.page,reloadOffline?"05-offline-reload":"04-offline-reconnect");
      });
    }
    await pair("1-projects/retry.md",async(a,b)=>{
      const path="1-projects/retry.md";let lost=false;
      await a.page.route("**/collaboration",async route=>{
        const body=route.request().postDataJSON();
        if(!lost&&body.update){lost=true;await route.fetch();await route.abort("failed");}
        else await route.continue();
      });
      await append(a.page,"\nRETRY ONCE");
      check("acknowledgement loss was injected after a real commit",await until(()=>lost));
      check("lost acknowledgement retries without duplicate text",await until(async()=>{
        const doc=await rawNote(path);return doc.text.split("RETRY ONCE").length===2 && (await text(b.page)).includes("RETRY ONCE");
      },{timeout:20000}));
    });
    await pair("1-projects/typing-bursts.md",async(a,b)=>{
      const path="1-projects/typing-bursts.md";
      const typeBursts=async(page,author)=>{
        for(let index=0;index<12;index++) {
          await append(page,` [${author}:${index}]`);
          await new Promise(r=>setTimeout(r,80));
        }
      };
      await Promise.all([typeBursts(a.page,"A"),typeBursts(b.page,"B")]);
      const tokens=["A","B"].flatMap(author=>Array.from({length:12},(_,index)=>`[${author}:${index}]`));
      check("rapid interleaved typing saves every edit exactly once",await until(async()=>{
        const body=(await rawNote(path)).text;
        return body===await text(a.page)&&body===await text(b.page)&&tokens.every(token=>body.split(token).length===2);
      },{timeout:20000}));
    });
    await pair("1-projects/restart.md",async(a,b)=>{
      const path="1-projects/restart.md";
      await append(a.page,"\nBEFORE SERVER RESTART");
      check("saved text is in Markdown before server restart",await until(async()=> (await rawNote(path)).text.includes("BEFORE SERVER RESTART"),{timeout:15000}));
      stopWorker();
      await until(async()=>{try{await fetch(`${GATEWAY}/.well-known/oauth-authorization-server`);return false;}catch{return true;}},{timeout:10000});
      startWorker();
      const restarted=await until(async()=>{try{return (await fetch(`${GATEWAY}/.well-known/oauth-authorization-server`)).ok;}catch{return false;}},{timeout:60000});
      check("server restarts from the same on-disk bucket",restarted);
      await append(b.page,"\nAFTER SERVER RESTART");
      check("editing resumes after server restart",await until(async()=>{const doc=await rawNote(path);return doc.text.includes("BEFORE SERVER RESTART")&&doc.text.includes("AFTER SERVER RESTART")&&(await text(a.page))===(await text(b.page));},{timeout:25000}));
      results.push({label:"restart states",detail:[await state(a.page),await state(b.page),await rawNote(path)],diagnostic:true});
    });
    await pair("1-projects/abrupt.md",async(a,b)=>{
      const path="1-projects/abrupt.md";
      await a.page.route("**/collaboration",async route=>{
        if(route.request().postDataJSON()?.update)await route.abort("failed");else await route.continue();
      });
      await append(a.page,"\nCLOSE BEFORE UPLOAD");
      await new Promise(r=>setTimeout(r,500));
      const url=a.page.url();await a.page.close();
      a.page=await a.context.newPage();await a.page.goto(url);
      await a.page.locator(".cm-content").waitFor();
      check("closing before upload restores and uploads local edits",await until(async()=> (await text(a.page)).includes("CLOSE BEFORE UPLOAD")&&(await rawNote(path)).text.includes("CLOSE BEFORE UPLOAD"),{timeout:25000}));
    });
    await pair("1-projects/offline-create-seed.md",async(a,b)=>{
      const path="1-projects/offline-created.md";
      await a.context.setOffline(true);await a.cut();
      await a.page.waitForFunction(()=>window.fixture.files.sync.reachability==="offline");
      await a.page.evaluate(()=>window.fixture.files.createNote("1-projects","offline-created"));
      await until(async()=> (await text(a.page)).includes("offline-created"));
      await append(a.page,"\nCREATED WHILE OFFLINE");
      a.reconnect();await a.context.setOffline(false);
      check("a note created offline reaches the bucket",await until(async()=> (await rawNote(path))?.text.includes("CREATED WHILE OFFLINE"),{timeout:20000}));
      await b.page.evaluate(path=>window.fixture.files.select(path),path);
      await until(async()=> (await text(b.page)).includes("CREATED WHILE OFFLINE"));
      await append(b.page,"\nPEER ON NEW NOTE");
      check("the original offline creator receives subsequent peer edits",await until(async()=>{
        const body=(await rawNote(path))?.text;return body?.includes("PEER ON NEW NOTE") && body===await text(a.page) && body===await text(b.page);
      },{timeout:20000}));
    });
    await pair("1-projects/offline-rename.md",async(a,b)=>{
      const path="1-projects/offline-rename.md", destination="1-projects/renamed.md";
      await b.context.setOffline(true);await b.cut();
      await append(b.page,"\nOFFLINE THROUGH RENAME");
      const read=textOf(await callTool(ANA,"read_note",{path}));
      const originalDocumentId=read.match(/^document_id: (.+)$/m)?.[1] ?? null;
      const moved=await callTool(ANA,"move_note",{source:path,destination,expected_source_etag:read.match(/^etag: (.+)$/m)?.[1]});
      const moveText=textOf(moved);
      const movedOk=!moved.isError&&moveText.startsWith("moved:");
      check("agent rename preserves the collaborative document",movedOk,JSON.stringify({moved,moveText}).slice(0,500));
      const [oldAfterMove,newAfterMove,oldMarker]=await Promise.all([rawNote(path),rawNote(destination),rawMarker(path)]);
      let destinationRead="";
      if(movedOk) destinationRead=textOf(await callTool(ANA,"read_note",{path:destination}));
      const destinationDocumentId=destinationRead.match(/^document_id: (.+)$/m)?.[1] ?? null;
      check("rename lands the same document before reconnect",movedOk&&oldAfterMove===null&&newAfterMove?.text===read.split("\n\n").slice(1).join("\n\n")&&destinationDocumentId===originalDocumentId&&oldMarker?.contentType==="application/x-context-logical-tombstone"&&oldMarker.text.startsWith("context.logical-delete.v1."),JSON.stringify({oldAfterMove,newAfterMove,oldMarker,originalDocumentId,destinationDocumentId}).slice(0,1000));
      b.reconnect();await b.context.setOffline(false);
      const follows=await until(async()=>{
        const doc=await rawNote(destination);return doc?.text.includes("OFFLINE THROUGH RENAME") && (await state(b.page)).collaboration?.pending===0;
      },{timeout:20000});
      if(!follows){
        const [browserState,oldNote,newNote]=await Promise.all([state(b.page),rawNote(path),rawNote(destination)]);
        check("offline changes follow a renamed note automatically",false,JSON.stringify({browserState,oldNote,newNote,traffic:b.traffic}));
      }else check("offline changes follow a renamed note automatically",true);
      const oldNote=await rawNote(path);
      check("rename does not recreate the old file",oldNote===null,oldNote===null?"":JSON.stringify(oldNote));
    });
    await pair("1-projects/offline-trash.md",async(a,b)=>{
      const path="1-projects/offline-trash.md";
      const action=async(name,args)=>{
        const response=await fetch(`${GATEWAY}/__fixture/action`,{method:"POST",headers:{"content-type":"application/json","x-fixture-user":"ana"},body:JSON.stringify({name,args})});
        const value=await response.json();if(!response.ok)throw new Error(JSON.stringify(value));return value;
      };
      await b.context.setOffline(true);await b.cut();
      await append(b.page,"\nOFFLINE THROUGH TRASH");
      const removed=await action("trashNote",{path});
      b.reconnect();await b.context.setOffline(false);
      await until(async()=> (await state(b.page)).collaboration?.status==="unavailable");
      check("offline editor cannot recreate a trashed note",await rawNote(path)===null);
      check("trash leaves unsent writing visible on the offline editor",(await text(b.page)).includes("OFFLINE THROUGH TRASH"));
      await action("restoreNote",{from:removed.to,to:path});
      await b.page.evaluate(()=>window.fixture.presence.collaboration.repair());
      check("restore reconnects the same identity and saves offline writing",await until(async()=>{
        const doc=await rawNote(path);return doc?.text.includes("OFFLINE THROUGH TRASH") && (await state(b.page)).collaboration?.pending===0;
      },{timeout:20000}));
    });
    await pair("1-projects/revoked.md",async(a,b)=>{
      const path="1-projects/revoked.md";
      const before=await rawNote(path);await controlPlane.revoke(BO);
      await append(b.page,"\nREVOKED CANNOT WRITE");
      await new Promise(r=>setTimeout(r,2500));
      check("revoked editor cannot change stored Markdown",(await rawNote(path)).text===before.text);
      check("revoked editor's unsent work stays recoverable locally",(await text(b.page)).includes("REVOKED CANNOT WRITE"));
      await append(a.page,"\nPRIVATE AFTER REVOCATION");
      check("authorized editor keeps saving after peer revocation",await until(async()=> (await rawNote(path)).text.includes("PRIVATE AFTER REVOCATION")));
      await new Promise(r=>setTimeout(r,1000));
      check("revoked editor receives no new note content",!(await text(b.page)).includes("PRIVATE AFTER REVOCATION"));
    });
  } finally {
    writeFileSync(join(ARTIFACTS,"implementation-results.json"),JSON.stringify({comparedWith:"c8fd9dce",results,errors},null,2));
    console.log(JSON.stringify({results,errors},null,2));
    process.exitCode=results.some(r=>r.passed===false)?1:0;
    await browser.close();stopWorker();await controlPlane.close();await new Promise(r=>pages.close(r));
  }
}
main().catch(error=>{console.error(error);process.exit(1)});
