/**
 * A THROWAWAY WORLD FOR ONE BENCHMARK CONVERSATION.
 *
 * The real gateway Worker, in process, over the same in-memory control plane
 * and object store its tests use. Every invented workspace becomes its own
 * bucket with a real `privacy.md`, every invented person a texting grant
 * covering exactly the workspaces `people.md` gives them, and the setup under
 * test is written where the product reads it: `ai/production/` in a
 * pinned `@context-lc`. So a benchmark answer goes through the same tools,
 * routing and privacy decisions a texted answer does, and a setup that leaks
 * a held-back note does it here first.
 *
 * Nothing leaves the world except the model calls: writes land in the
 * throwaway buckets and are read back as a list of changes, never applied
 * anywhere.
 *
 * A test may pin the day it is on (`today`, see clock.mjs): the world's clock
 * then reads that day, and each note's modified time comes from its own front
 * matter, so "untouched for a month" means the same on every run.
 */

import { connectMailbox, inMailbox, readMailbox, searchMailbox, sentMail, settingMailbox } from "./mailbox.mjs";
import { TRANSCRIPTS_FOLDER } from "../src/agent/transcript.js";
import { HOUSEKEEPING_CLIENT_ID } from "../src/agent/housekeeping.js";
import { arrivedEmail, checkInTurn, houseTurn, routineTurn, startCall, startGrants } from "./worldStarts.mjs";
import worker from "../src/index.js";
import { PRODUCTION_TEXTING_PATH } from "../src/agent/production.js";
import { skillPath } from "../src/agent/skills.js";
import { createWeb } from "./sites.mjs";
import { simBinding, simulatedWorld, sitesIn, withClosedForNew } from "./simWorld.mjs";
import { createBenchSite } from "./siteStub.mjs";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "../test/controlPlaneStub.mjs";
import { rmSync } from "node:fs";

import { createWorkerCtx } from "../test/workerCtx.mjs";
import { readStream, workerEvents } from "./workerWire.mjs";
import { benchMachines } from "./benchMachines.mjs";
import { benchGroup, benchHome } from "./groupChat.mjs";
import { seedHandles } from "./benchHandles.mjs";
import { bodyText, snapshot } from "./bucketSnapshot.mjs";
import { ACCOUNT_ID as D1_ACCOUNT_ID, API_TOKEN as D1_API_TOKEN, createD1Backend } from "../test/searchProjection/fixtures.mjs";
import { createVectorizeBackend, meaningIndexFor } from "../test/vectorizeStub.mjs";
import { wireSearchSettings } from "../src/search/settings.js";
import { texStoreNamespace } from "../test/texStoreFixture.mjs";
import { assertIsoDate, clockMs, installClock, noonUtcMs, noteModifiedAt, realNow } from "./clock.mjs";
import { benchCalendar, calendarChanges, withArrivedEvents } from "./calendar.mjs";
import { connectChat } from "./chat.mjs";
import { interceptFetch } from "./worldFetch.mjs";
import { worldChat } from "./worldChat.mjs";
import { chatEntries, modelLog } from "./modelLog.mjs";
import { failedStatus, roundsOf } from "./trace.mjs";
import { benchCause } from "./benchCause.mjs";
import { homeChanges, noteChanges, worldStandIns } from "./worldStandIns.mjs";
import { lastWords } from "./worldStarts.mjs";
import { isFrontDoorCall, quietCallsOf } from "./frontDoorCall.mjs";
import { modelFailuresIn, toolErrorsIn } from "./toolErrors.mjs";
import { turnSteps } from "./turnSteps.mjs";

/** Brave's search endpoint (`src/agent/search.js`). */

export const S3_ENDPOINT = "https://s3.bench.invalid";
/** How much of a filed note's text a record keeps, for `containing` checks. */
const MAX_FILED_TEXT = 2000;

/** A note's front matter as `key → value`, lower-cased keys, quotes dropped. */
export function frontOf(text) {
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(String(text ?? ""));
  const out = {};
  for (const line of (m?.[1] ?? "").split("\n")) {
    const f = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/.exec(line);
    if (f) out[f[1].toLowerCase()] = f[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}
const PINNED = "context-lc";

/**
 * The `privacy.md` the gateway reads. The default is always private (the engine
 * accepts nothing else), so a shared workspace shares each of its top-level
 * folders and root notes with members, and a held-back note is a private
 * override on top.
 */
export function manifest({ shared, files = [], heldBack = [] }) {
  const folders = shared ? [...new Set(files.filter((path) => path.includes("/")).map((path) => path.split("/")[0]))].sort() : [];
  const rootNotes = shared ? files.filter((path) => !path.includes("/")).sort() : [];
  const lines = (entries, visibility) => entries.map((path) => `  ${path}: ${visibility}\n`).join("");
  const overrides = lines(rootNotes.filter((path) => !heldBack.includes(path)), "team") + lines(heldBack, "private");
  return (
    "---\nrole: privacy-manifest\n---\n\n" +
    "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
    `folder_defaults:\n${lines(folders, "team") || "  # none\n"}\n` +
    `note_overrides:\n${overrides || "  # none\n"}` +
    "```\n\n<!-- END BRAIN PRIVACY RULES -->\n"
  );
}

export function workspaceId(name) {
  return `ws_${name.replace(/-/g, "_")}`;
}

/** The search-database descriptor a warmed workspace carries (`search/d1/client.js`). */
export function searchIndexFor(name, state) {
  return { databaseId: `db-bench-${name}`, accountId: D1_ACCOUNT_ID, apiToken: D1_API_TOKEN, state };
}

export function binding(bucket, n, searchIndex = null, meaningIndex = null) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: `AKIABENCHEXAMPLE${String(n).padStart(4, "0")}`,
    secretAccessKey: `benchExampleSecretNotReal${String(n).padStart(4, "0")}`,
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    status: "active",
    ...(searchIndex ? { searchIndex } : {}),
    ...(meaningIndex ? { meaningIndex } : {}),
  };
}

/**
 * The visibility a fixture note is written at, as `manifest` above declares it:
 * a shared workspace's notes are team unless held back by name, a personal
 * workspace's are private. The meaning index records the same tier.
 */
export function fixtureVisibility(bench, name, path) {
  const shared = !bench.people.some((row) => row.workspace === name && row.personal);
  if (!shared) return "private";
  return (bench.workspaces[name].heldBack ?? []).includes(path) ? "private" : "team";
}

/**
 * Register every workspace and fill its bucket, from the fixture or from a
 * prepared run's snapshot. Every workspace exists whoever is asking, so a leak
 * is a real leak. `search` is `null` (no search database: the cold world),
 * `"backfilling"` (a database to warm) or `"ready"` (a warmed clone).
 */
export function placeWorkspaces(bench, { s3, controlPlane, baseMs, search = null, meaning = false, prepared = null }) {
  const modified = (ms) => new Date(ms).toISOString();
  const ids = new Map();
  let n = 0;
  for (const [name, workspace] of Object.entries(bench.workspaces)) {
    const id = workspaceId(name);
    const shared = !bench.people.some((row) => row.workspace === name && row.personal);
    const searchIndex = search ? searchIndexFor(name, search) : null;
    // Search by meaning rides beside fast search, on the same state: a world
    // with a meaning index is one whose warm pass filled it (`warm.mjs`).
    const meaningIndex = meaning && search ? meaningIndexFor(name, search, D1_ACCOUNT_ID) : null;
    controlPlane.addWorkspace(id, name, binding(`bench-${name}`, ++n, searchIndex, meaningIndex), shared ? { kind: "shared" } : {});
    const bucket = s3.bucketFor(`bench-${name}`);
    if (prepared) {
      // The warmed bucket, index shards included; each object copied so a turn's
      // write never reaches the snapshot.
      for (const [key, object] of prepared.buckets.get(name)) bucket.set(key, { ...object });
    } else {
      bucket.set("privacy.md", {
        body: manifest({ shared, files: Object.keys(workspace.files), heldBack: workspace.heldBack }),
        etag: "p0",
        lastModified: modified(baseMs),
      });
      for (const [path, text] of Object.entries(workspace.files)) {
        bucket.set(path, { body: text, etag: "e0", lastModified: modified(noteModifiedAt(text, baseMs)) });
      }
    }
    controlPlane.setBuiltinVerdict(id, { allowed: true, remaining: 1000 });
    ids.set(name, id);
  }
  return ids;
}

/**
 * Build the world for one person.
 *
 * @param {object} bench what `readBenchFolder` returned
 * @param {string} person e.g. "Maya"
 * @param {string} setupRaw the setup file's text, written as the production note
 * @param {{ ai?: object, gatewayFetch: Function }} models where model calls go
 * @param {string | null} [today] the day the world is on, as YYYY-MM-DD; null
 *   keeps the real clock. The clock reads noon UTC that day and runs on from there.
 * @param {object | null} [prepared] what `prepareRun` (warm.mjs) returned: the
 *   world then starts from the warmed snapshot, with a ready search database
 *   per workspace, instead of from cold fixture files.
 */
export async function createWorld(bench, person, setupRaw, models, today = null, prepared = null) {
  if (today !== null) assertIsoDate(today);
  const rows = bench.people.filter((row) => row.person === person);
  const own = rows.find((row) => row.personal);
  if (!own) throw new Error(`${person} has no personal workspace in people.md`);

  // Notes are dated from the pinned day, or from the real clock when there is none.
  const baseMs = today === null ? realNow() : noonUtcMs(today);
  const modified = (ms) => new Date(ms).toISOString();

  // A write a turn makes is stamped on the world's clock, so it reads as just written.
  const s3 = createS3Backend(S3_ENDPOINT, { now: () => new Date().toISOString() });
  // The website and domain `write_note` `site` answers for (`siteStub.mjs`),
  // read from the buckets placed below.
  let site = null;
  const controlPlane = createControlPlaneStub({ site: (cleared, body) => site.answer(cleared, body) });
  // The people `people.md` names, as the control plane's directory resolves their handles (`set_visibility`'s `people`).
  seedHandles(controlPlane, bench);
  // The person's calendar, as Google would answer for it: their personal
  // workspace's calendar days, read live by `calendar:` (`load.mjs`).
  Object.assign(controlPlane.flags, benchCalendar(bench.workspaces[own.workspace]?.calendar ?? [], models.calendar === "connected" ? person : null));
  // A check-in's calendar line: the events it names, on their day, read beside the calendar's days from then on
  // (`calendarArrives`). Under the simulated world's wrapper (`simulateServices`), so a made-up day never hides one.
  const arrivedEvents = [];
  controlPlane.flags.calendarDays = withArrivedEvents(controlPlane.flags.calendarDays, arrivedEvents, () => controlPlane.flags.calendarAddress);
  // Their Gmail, as Google would answer for it (`mailbox.mjs`): searched and
  // read live, and a mailbox that may keep drafts. It sends only for a test
  // with `gmail: sends` (`connectMailbox`); a send is recorded by the stub,
  // never delivered. Each search and read is kept for the result's `Mail:` line.
  const stand = worldStandIns({ models, person }), { gaps } = stand; // the stand-ins beyond these (`worldStandIns.mjs`), and what none could answer
  // The mailbox the chat's setting names is the one Tex has (`mailbox.mjs` settingMailbox): the fixtures' mail moves there.
  const named = settingMailbox(models.simulate?.setting);
  const mail = inMailbox((bench.workspaces[own.workspace]?.mail ?? []).filter(stand.arrived), named);
  const mailEvents = [];
  const connectMail = () => {
    const address = mail[0].address;
    connectMailbox(controlPlane.flags, address, { sends: models.gmail === "sends" });
    const logged = (event, value) => (mailEvents.push(event(value)), value);
    // The fixture's inbox and what the run really sent (Sent, `mailbox.mjs` sentMail), each searched and read.
    const everything = () => [...mail, ...sentMail(controlPlane.emailCalls, address)];
    controlPlane.flags.mailResults = (query) => logged((found) => `mail search ${JSON.stringify(String(query))}: ${found.length} found`, searchMailbox(everything(), query));
    controlPlane.flags.mailMessage = (body) => logged(() => `mail read ${body.id}`, readMailbox(everything(), body.address, body.id));
  };
  if (mail.length > 0) connectMail();
  // The listing tools list from the Convex tree, copied here from each S3 bucket.
  controlPlane.serveTreesFrom(null, { s3 });
  // A warmed world answers searches from a copy of the snapshot's database.
  const copies = [];
  const d1 = prepared ? createD1Backend({ open: (id) => prepared.openCopy(id, copies) }) : null;
  // The warmed meaning index, copied: a turn's write-behind lands in this
  // conversation's copy and never in the snapshot or the next conversation.
  const vectorize = prepared?.vectors ? createVectorizeBackend({ seed: prepared.vectors }) : null;
  const restore = [s3.install(), controlPlane.install(), ...(d1 ? [d1.install()] : []), ...(vectorize ? [vectorize.install()] : [])];
  if (today !== null) restore.push(installClock(today, { at: clockMs(today, models.clock, models.timeZone ?? "UTC") })); // a test's `clock:` in its zone

  // The scripted web a golden task runs on (`sites.mjs`): the browser
  // Worker's stand-in, and the answers to web searches.
  // A person whose world writes their Gmail: the record for their search (`simulateServices`, `writtenMail`).
  const writtenMail = (bench.workspaces[own.workspace]?.mail ?? []).length > 0;
  const sim = simulatedWorld(models, controlPlane, { today, person, noMailbox: mail.length === 0, writtenMail, gaps, address: named }); // a Dev test's outside world (`simWorld.mjs`)
  // A chat whose setting names Google Chat is connected, its reads answered by the world (`chat.mjs`).
  if (models.chat === "connected") connectChat(controlPlane.googleChat, { person, sim });
  const kept = sitesIn(models.sites, sim, models.ownSites ?? []);
  const web = kept?.length ? createWeb(kept) : null;

  // Model calls are the only traffic that leaves the world, and web searches when the run has a search key and no scripted web (`worldFetch.mjs`).
  const modelCalls = modelLog(stand.modelFetch); // every model call kept, for the conversation's ledger file (`modelLog.mjs`)
  restore.push(interceptFetch({ modelCalls, web, sim, models, stand, s3Endpoint: S3_ENDPOINT, local: Boolean(d1 || vectorize) }));

  const ids = placeWorkspaces(bench, { s3, controlPlane, baseMs, search: prepared ? "ready" : null, meaning: vectorize !== null, prepared });

  const nameOf = new Map([...ids].map(([name, id]) => [id, name]));
  site = createBenchSite({
    bucketOf: (id) => (nameOf.has(id) ? s3.bucketFor(`bench-${nameOf.get(id)}`) : null),
    handleOf: (id) => nameOf.get(id) ?? null,
  });

  controlPlane.addWorkspace("ws_pinned", PINNED, binding("bench-pinned", 999), { kind: "shared" });
  const pinned = s3.bucketFor("bench-pinned");
  // Another job's setup under test (the dream's, `check.mjs`) sits beside the texting one, where production reads it.
  const pinnedNotes = models.pinnedNotes ?? [];
  pinned.set("privacy.md", {
    body: manifest({ shared: true, files: [PRODUCTION_TEXTING_PATH, ...pinnedNotes.map((note) => note.path), ...(models.group ? [`${benchHome(models.group)}/about.md`] : [])] }),
    etag: "p0",
    lastModified: modified(baseMs),
  });
  pinned.set(PRODUCTION_TEXTING_PATH, { body: setupRaw, etag: "s0", lastModified: modified(noteModifiedAt(setupRaw, baseMs)) });
  for (const [i, note] of pinnedNotes.entries()) {
    pinned.set(note.path, { body: note.raw, etag: `n${i}`, lastModified: modified(noteModifiedAt(note.raw, baseMs)) });
  }
  // The setup's task skills (`src/agent/skills.js`), where production keeps them.
  for (const [i, skill] of (models.skills ?? []).entries()) {
    pinned.set(skillPath(skill.name), { body: skill.raw, etag: `k${i}`, lastModified: modified(baseMs) });
  }

  const token = `cat_bench_${person.toLowerCase().replace(/[^a-z]/g, "")}_${"0".repeat(24)}`;
  await controlPlane.addGrant({
    workspaceId: ids.get(own.workspace),
    role: "owner",
    userId: `user_bench_${own.workspace}`,
    accessToken: token,
    scopes: ["context:read", "context:write", "context:private"],
    // The texting client, unless a job's check runs as its own (the dreams client, `check.mjs`).
    clientId: models.clientId ?? "context_texts",
    alsoMemberOf: [
      ...rows.filter((row) => !row.personal).map((row) => ({ workspaceId: ids.get(row.workspace), role: row.role })),
      { workspaceId: "ws_pinned", role: "member" },
    ],
  });

  // A group chat (`models.group`): its grant, hashes and token (`groupChat.mjs`).
  const { group, tagger, chatToken } = await benchGroup({ name: models.group, bench, person, rows, ids, own, controlPlane, token });

  // Tex's housekeeping (`src/agent/housekeeping.js`) has its own client, over
  // the person's own workspace, plus the pinned one every account reaches,
  // where it reads its setup (`ai/production/housekeeping.md`); its guard
  // refuses any call that names another workspace.
  const houseToken = `cat_house_${person.toLowerCase().replace(/[^a-z]/g, "")}_${"0".repeat(24)}`;
  await controlPlane.addGrant({
    workspaceId: ids.get(own.workspace),
    role: "owner",
    userId: `user_bench_${own.workspace}`,
    accessToken: houseToken,
    scopes: ["context:read", "context:write", "context:private"],
    clientId: HOUSEKEEPING_CLIENT_ID,
    alsoMemberOf: [{ workspaceId: "ws_pinned", role: "member" }],
  });

  // Tex's check-ins and routine runs, on their own clients' grants (`worldStarts.mjs`).
  const startTokens = await startGrants(controlPlane, { person, workspaceId: ids.get(own.workspace), userId: `user_bench_${own.workspace}` });

  const before = new Map([...ids].map(([name]) => [name, snapshot(s3.bucketFor(`bench-${name}`))]));
  const homeNotes = () => (group ? new Map([...snapshot(pinned)].filter(([key]) => key.startsWith(`${group.home}/`))) : new Map()); // a group chat's own home in the pin: a write there is a change the turn made too (`worldStandIns.mjs`)
  let homeBefore = homeNotes();
  const env = {
    CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
    GATEWAY_SECRET,
    // Tex's objects, as in production: the person's history and turn records live there (`src/agent/history.js`).
    TEX_STORE: texStoreNamespace().namespace,
    // Where the person's own pages live, as in production: a handoff texts
    // `<APP_ORIGIN>/tex/@<handle>` (`http/texComputer.js`), and without one
    // the browser cannot be handed over at all.
    APP_ORIGIN: "https://app.bench.invalid",
    // The deployed Worker's search budget (wrangler.toml). The free-tier default
    // of 40 is spent by one bucket scan, and every read, listing and orient in the
    // same turn then fails: the 2026-10-08 results measured exactly that.
    SEARCH_SUBREQUEST_BUDGET: "600",
    ...(models.ai ? { AI: models.ai } : {}),
    ...(models.examples ? { TEX_EXAMPLES: models.examples } : {}), // the front door's nearest Training examples (`texExamplesIndex.mjs`)
    AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    AI_GATEWAY_ID: "bench",
    AI_GATEWAY_TOKEN: "bench-gateway-token-not-a-real-one",
    // Production offers search_web and open_page when it has a search key, so
    // a run offers the same tools (decided 2026-10-09; round two measured a
    // shorter tool list than production). The run command passes the key.
    ...(typeof models.searchKey === "string" && models.searchKey ? { BRAVE_SEARCH_API_KEY: models.searchKey } : {}),
    // The person's paired computer, when the test names one (`run.mjs` `readComputer`): read through
    // MACHINE_STORE (`src/machines/forJobs.js`), the only reads it answers. Nothing runs on it here.
    ...(models.computer ? { MACHINE_STORE: benchMachines(models.computer, ids.get(own.workspace)) } : {}),
    // The hand-back judge, as production runs it (`agent/handbackJudge.js`); a scripted model leaves it off, since it would answer the judge's call too.
    ...(models.handbackJudge === true ? { HANDBACK_JUDGE: "on" } : {}),
    // A scripted web answers searches itself, so no real key is needed or sent.
    ...(web || sim ? { BRAVE_SEARCH_API_KEY: "bench-scripted-search", SITE_SHOTS: stand.binding(sim ? simBinding(sim, web) : web.binding) } : {}),
    // An offline web (a socketed run) still offers search_web; the world answers it with nothing.
    ...(!web && !sim && models.offlineWeb === true ? { BRAVE_SEARCH_API_KEY: "bench-offline-search" } : {}),
    // The deployment's search settings (`src/search/settings.js`): what a
    // search setup under test puts in the Worker's vars.
    ...(models.searchSettings ? { SEARCH_SETTINGS: JSON.stringify(wireSearchSettings(models.searchSettings)) } : {}),
  };

  /** The gateway's own files on a save, Tex's turn transcript and its calendar copy (calendarCache.js, a cache): never the model's change. */
  const PLUMBING_FILES = new Set(["privacy.md", "activity.md", "tex/calendar.md"]);
  const isPlumbingPath = (path) => path.startsWith(".") || PLUMBING_FILES.has(path) || path.startsWith(`${TRANSCRIPTS_FOLDER}/`);

  const routerSaid = (entry) =>
    typeof entry.confidence !== "number" ? "" : entry.tier === "think" ? ` (${entry.confidence.toFixed(2)})` : ` (think ${entry.confidence.toFixed(2)})`;
  /**
   * What one turn spent, from the meter reports it made: one per model it ran
   * on, the answering model last (`src/agent/modelPlan.js` `meterParts`).
   * `usage` is the sum, `usageByModel` the split, `model` the answering one.
   */
  const spentSince = (from) => {
    const reports = controlPlane.builtinReports.slice(from);
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const usageByModel = {};
    for (const report of reports) {
      const spent = { input: report.inputTokens ?? 0, output: report.outputTokens ?? 0, cacheRead: report.cacheReadTokens ?? 0, cacheWrite: report.cacheWriteTokens ?? 0 };
      for (const key of Object.keys(usage)) usage[key] += spent[key];
      if (typeof report.model !== "string") continue;
      const into = (usageByModel[report.model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      for (const key of Object.keys(into)) into[key] += spent[key];
    }
    return { usage, usageByModel, model: reports.at(-1)?.model ?? null };
  };
  const { textedEvent, postEvents } = workerEvents({ env, token: chatToken, group });
  // The chat before its text, and what a turn the Worker queues itself reads of it (`worldChat.mjs`).
  const chat = worldChat({ env, token, group, tagger, textedEvent, postEvents, workspaceId: () => ids.get(own.workspace), timeZone: models.timeZone ?? "UTC", mailbox: () => mail[0]?.address ?? null, mailArrives: (email) => world.mailArrives(email) });
  const world = {
    ...chat,
    /** The chat before its text was there before the turn: what seeding it wrote (its kept pictures) is not a change the turn made. */
    async earlier(...args) {
      await chat.earlier(...args);
      for (const name of before.keys()) before.set(name, snapshot(s3.bucketFor(`bench-${name}`)));
      homeBefore = homeNotes();
      stand.mark();
    },
    gaps: () => gaps.list(), // what the bench's own stand-ins could not answer this conversation (`benchGaps.mjs`)
    /** One texted message, answered with the conversation so far; with `job`, one part of a job, as `jobRun.ts` asks it (`jobTasks.mjs`): their text is posted on part 1 only, the report never, and the done check's verdict and advice come back (`jobCheck.js` `jobFields`). */
    async text(message, attachments = [], { running = null, others = [], job = null, byCode = false, as = null, event = null, groupMail = null, cause = null, posted = false } = {}) {
      // The person opened the last handoff's link and signed in before texting.
      web?.personSignsIn();
      const { ctx, settle } = createWorkerCtx();
      // The real clock, not the world's: a turn's recorded time is how long it took.
      const started = realNow();
      const reportsBefore = controlPlane.builtinReports.length;
      const callsBefore = modelCalls.calls().length;
      // Their text posted to the chat's ledger first, as the texting Worker does (`apps/agent/src/events.ts`): the ledger is
      // the chat's one record, so the next text sees this one only through it.
      // In a group, what the other members said since Tex's last answer is posted first, each from its own sender.
      // The turn covers them with the tagger's text, as the Worker names the queued texts a turn answers (`apps/agent/src/inbox.ts`).
      const before = [];
      for (const line of group ? others : []) {
        const sender = group.people.get(line.from);
        if (!sender) throw new Error(`@${line.from} is not in the group's workspace (people.md)`);
        before.push(textedEvent(line.text, sender));
        await postEvents([before.at(-1)]);
      }
      // A turn the Worker queues itself (`byCode`: a group's routine or check-in, a job's report; `byCode.mjs`) posts no
      // text of theirs and covers none, as `queueByCode` and `queueGroupByCode` keep no inbound event; `as` is who it
      // runs as in a group (the routine's writer, the job's asker).
      const sender = as !== null && group ? group.people.get(as) : tagger;
      if (as !== null && group && !sender) throw new Error(`@${as} is not in the group's workspace (people.md)`);
      const said = textedEvent(message, sender);
      if (!byCode && !posted && (job === null || job.attempt === 1)) await postEvents([said]); // `posted`: a job the test's own turn started, whose ask the chat holds (`jobDelivery.mjs`)
      const covers = byCode ? [] : [...before.map((event) => event.id), said.id];
      // Asked for as a stream, as the texting Worker asks (`apps/agent/src/clients.ts`):
      // a streamed turn is the long one, with the setup's max_steps, and a
      // plain JSON ask would measure the quick turn's 8 rounds instead.
      const streamed = await worker.fetch(
        new Request("https://mcp.bench.invalid/agent", {
          method: "POST",
          headers: { Authorization: `Bearer ${chatToken}`, "Content-Type": "application/json", Accept: "application/x-ndjson" },
          // What the chat has running, as the texting Worker sends it (`apps/agent/src/jobs.ts`): only a
          // turn that is sent it is offered background jobs (`background.js`), so a test with `background: on` sends it.
          // `covers` and `chat` as the Worker sends them (`apps/agent/src/inbox.ts`) on a real run (`run.mjs` `ledgerTurns`), so the turn reads the ledger and sorts its thread as production does.
          body: JSON.stringify({ question: message, ...(models.timeZone ? { timeZone: models.timeZone } : {}), ...(group ? { group: { key: group.key, members: group.members, from: sender.handle, cause: cause ?? benchCause([...others.map((line) => line.text), message]), ...(groupMail ? { mail: groupMail } : {}) } } : { conversation: "texts" }), turn: said.turn, ...(models.ledgerTurns === true && covers.length > 0 ? { covers, chat: said.chat } : {}), ...(event ?? {}), ...(attachments.length > 0 ? { attachments } : {}), ...(Array.isArray(running) ? { running } : {}), ...(job ? { job } : {}) }),
        }),
        env,
        ctx,
      );
      const { response, body, progress } = await readStream(streamed);
      const ms = realNow() - started;
      await settle();
      if (job === null && typeof body?.answer === "string" && body.answer !== "") await postEvents([{ ...textedEvent(body.answer), from: { kind: "tex" }, turn: said.turn, covers, delivered: true }]); // Tex's answer, as the Worker posts it once sent
      const turn = controlPlane.turnReports.at(-1) ?? {};
      const spent = spentSince(reportsBefore);
      // This turn's model calls: each failed tool's own error for the row (`toolErrors.mjs`), and a failed call or an
      // empty Front door answer kept as the bench's failure, never Tex's (`benchGaps.mjs`).
      const turnCalls = modelCalls.calls().slice(callsBefore);
      for (const line of modelFailuresIn(turnCalls, isFrontDoorCall)) gaps.add(line);
      return {
        ok: response.status === 200 && typeof body?.answer === "string",
        answer: body?.answer ?? "",
        // Nothing to text, and the tapback the Worker sends instead (`texEntryPoint/sendTheReply.js`).
        quiet: body?.quiet === true,
        // What else makes a wordless turn (`run.mjs` saidLine): pictures sent, a turn the Worker stopped, and the model's last words.
        pictures: Array.isArray(body?.pictures) ? body.pictures.length : 0,
        cancelled: body?.cancelled === true,
        // A quiet turn's words are the Front door's own last call (`frontDoorCall.mjs`), not a judge's that ran after it.
        ...(body?.answer === "" ? { quietWhy: lastWords(quietCallsOf(modelCalls.calls().slice(callsBefore))) } : {}),
        ...(job ? { verdict: typeof body?.verdict === "string" ? body.verdict : null, advice: typeof body?.advice === "string" ? body.advice : "", unfinished: body?.unfinished === true, exhausted: body?.exhausted === true } : {}),
        react: typeof body?.react === "string" ? body.react : null,
        // Lines the turn texted while it worked: each is a text the person got,
        // sent before the answer, as the texting Worker sends them (`apps/agent/src/inbox.ts`).
        progress,
        // The background jobs the turn started, for the start checks (`checks.mjs`); `run.mjs` then runs them (`jobDelivery.mjs`).
        jobs: (Array.isArray(body?.jobs) ? body.jobs : []).map((job) => ({ title: String(job?.title ?? ""), brief: String(job?.brief ?? ""), mail: job?.mail?.path ?? null, name: job?.mail?.name ?? null, on: job?.machine?.name ?? null })),
        // Held calls the answer asks a YES for (`route.js`); the played person answers.
        asked: typeof body?.asked === "number" ? body.asked : 0,
        // The gateway hides a provider's reason from the caller; the turn log
        // keeps the status (`turnLog.js` `wireTraceEntry`), and a result says it.
        error:
          response.status === 200
            ? null
            : `${String(body?.error ?? `status ${response.status}`)}${failedStatus(turn.trace) === null ? "" : ` (status ${failedStatus(turn.trace)})`}`,
        ms,
        model: spent.model ?? body?.model ?? null,
        // Each call with whether it succeeded: a result note that hides failed calls
        // reads like a model that could not find anything.
        // The router's pick first, when the setup has one (`src/agent/router.js`):
        // a judge sees which tier answered, and the score prices that model.
        // A fallback and a retried round are recorded the same way, because
        // they are what production does and a result must show how often.
        tools: (turn.trace ?? [])
          .filter((entry) => entry.kind === "tool" || entry.kind === "router" || entry.kind === "fallback" || entry.kind === "judge" || (entry.kind === "model" && (entry.retried || entry.cut)))
          .map((entry) =>
            entry.kind === "judge"
              ? // The reply judge's verdict (`src/agent/replyJudge.js`): `judge: only_acknowledged 0.82 sent back, 40 ms`.
                { tool: `judge: ${entry.verdict ?? "no verdict"}${typeof entry.confidence === "number" ? ` ${entry.confidence.toFixed(2)}` : ""}${entry.acted ? " sent back" : ""}, ${Math.round(entry.ms ?? 0)} ms`, ok: true }
              : entry.kind === "router"
              ? // `router: think (0.8)`; a think pick under the setup's cutoff is
                // `router: main (think 0.4)`, so a result shows the near misses.
                { tool: `router: ${entry.tier}${routerSaid(entry)}`, ok: true }
              : entry.kind === "fallback"
                ? { tool: `fallback: ${entry.model}${entry.status === undefined ? "" : ` after ${entry.status}`}`, ok: true }
                : entry.kind === "model" && entry.cut && !entry.retried
                  ? { tool: "cut off at the output cap", ok: true }
                  : entry.kind === "model"
                  ? { tool: `retried${entry.status === undefined ? "" : ` after ${entry.status}`}`, ok: true }
                  : entry.held
                    ? // Held by the egress gate for the person's yes, and run when they
                      // gave it (the played person answers YES): not a failed call.
                      { tool: `${entry.tool} (held for OK)`, ok: true }
                    : { tool: entry.tool, ok: entry.ok !== false },
          ),
        usage: spent.usage,
        // What each model spent and how many rounds it ran: a planned turn is priced model by model.
        usageByModel: spent.usageByModel,
        rounds: roundsOf(turn.trace), ...(body?.rounds && typeof body.rounds === "object" ? { turnRounds: body.rounds } : {}), ...(body?.route && typeof body.route === "object" ? { turnRoute: body.route } : {}), // its rounds of its bound (`lastRound.js` roundsField) and the reply's route
        trace: turn.trace ?? [],
        // What the turn did, short (`turnSteps.mjs`): tools, the reviewer's verdicts and the outcome, for a Lab row.
        steps: turnSteps(turn.trace, { answer: body?.answer ?? "", cancelled: body?.cancelled === true }),
        // Each failed tool's error, short and safe (`toolErrors.mjs`), for the row's detail.
        toolErrors: toolErrorsIn(turnCalls),
      };
    },

    /**
     * An email arriving in the person's Gmail now (`{ from, subject, body }`), as a check-in's new mail: a person with
     * no mailbox yet gets one at their bench address.
     */
    mailArrives(email) {
      mail.unshift(arrivedEmail(email, mail[0]?.address ?? named ?? `${String(person).toLowerCase().replace(/[^a-z0-9]/g, "") || "person"}@bench.invalid`, mail.length + 1));
      if (mail.length === 1) connectMail();
    },

    /** One check-in, as Tex's check-in client: what it would text (`worldStarts.mjs`). Its look sees no invented mail or events. */
    async checkIn() {
      return withClosedForNew(sim, () => checkInTurn((body) => startCall({ worker, env, token: startTokens.checkin, body, controlPlane }), () => modelCalls.calls(), models.timeZone ?? "UTC"));
    },

    /** A check-in's own calendar line (`- check-in calendar:`): the event on the day of the look, on the bench calendar from then on. */
    calendarArrives(text) {
      arrivedEvents.push({ date: today ?? new Date(realNow()).toISOString().slice(0, 10), text: String(text) });
      controlPlane.flags.calendarAddress ??= `${String(person).toLowerCase().replace(/[^a-z0-9]/g, "") || "person"}@calendar.bench.invalid`;
    },

    /** Runs `look` with the simulated world closed for new (`simWorld.mjs` `withClosedForNew`): a group check-in's turn. */
    closedForNew: (look) => withClosedForNew(sim, look),

    /** One run of the routine at `path`, placed with `text` as its words (`worldStarts.mjs`). */
    async routine(path, text) {
      this.place(path, `${text}\n`);
      return routineTurn(path, (body) => startCall({ worker, env, token: startTokens.routine, body, controlPlane }), () => modelCalls.calls(), models.timeZone ?? "UTC");
    },

    /**
     * One housekeeping run over the person's own workspace, answered as a turn
     * is: its answer is the line it would text and the log it wrote.
     */
    async keepHouse() {
      return houseTurn(await startCall({ worker, env, token: houseToken, body: { housekeeping: { timeZone: models.timeZone ?? "UTC" } }, controlPlane }), (path) => this.readThrough(path));
    },

    /**
     * A note read through the gateway as the person's own client reads it:
     * `{ path, body }` where it is now (a moved note's old name follows it),
     * or null when there is none. `workspace` is another of theirs by name.
     */
    async readThrough(path, workspace = null) {
      const { ctx, settle } = createWorkerCtx();
      const context = workspace === null || workspace === own.workspace ? null : `@${workspace}`;
      const response = await worker.fetch(
        new Request("https://mcp.bench.invalid/mcp", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "read_note", arguments: { path, ...(context ? { context } : {}) } },
          }),
        }),
        env,
        ctx,
      );
      const body = await response.json().catch(() => null);
      await settle();
      if (!body?.result || body.result.isError === true) return null;
      const text = (body.result.content ?? []).map((block) => block.text ?? "").join("\n");
      const split = text.indexOf("\n\n");
      return { path: /^path: (.+)$/m.exec(text)?.[1] ?? path, body: split === -1 ? "" : text.slice(split + 2) };
    },

    /**
     * Where each `<workspace>/<path>` named is now: `{ at, front, text }`,
     * `at` as `<workspace>/<path>`, or null when it is gone.
     */
    async where(notes) {
      const out = {};
      for (const note of notes) {
        const cut = note.indexOf("/");
        const workspace = note.slice(0, cut);
        const found = await this.readThrough(note.slice(cut + 1), workspace);
        out[note] = found ? { at: `${workspace}/${found.path}`, front: frontOf(found.body), text: found.body.slice(0, MAX_FILED_TEXT) } : null;
      }
      return out;
    },

    /** The emails the conversation saved as drafts or sent, never a check (`checks.mjs` `forward`). */
    emails() {
      return controlPlane.emailCalls.filter((entry) => !entry.check && entry.answer?.ok === true).map((entry) => ({ ...entry.email, draft: entry.draft === true }));
    },

    /** What the scripted browser did this conversation (`sites.mjs`); empty without one. */
    browser() {
      return [...(web ? web.events() : []), ...(sim ? sim.events() : []), ...site.events()];
    },

    /** Each Gmail search and read this conversation made, in order (`mailbox.mjs`). */
    mail: () => [...mailEvents],

    /** What the conversation changed in the invented workspaces, as a list. */
    changes() {
      const workspaces = [...before].flatMap(([name, was]) => noteChanges(name, was, snapshot(s3.bucketFor(`bench-${name}`)), isPlumbingPath));
      // Tex's calendar writes (`calendarChanges`): a move or an add is a change the judge reads, as a note's is.
      return [...workspaces, ...stand.settingsChanges(), ...calendarChanges(controlPlane.calendarCalls), ...(group ? homeChanges(homeBefore, homeNotes(), group.home, isPlumbingPath) : [])];
    },

    /**
     * One `search_notes` as the person, through the MCP endpoint, the way an
     * AI client calls it: for the search benchmark (`search.mjs`). `context`
     * addresses another workspace, as a client would with `context: "@name"`.
     */
    async search(query, context = null) {
      const { ctx, settle } = createWorkerCtx();
      const started = realNow();
      const response = await worker.fetch(
        new Request("https://mcp.bench.invalid/mcp", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "search_notes", arguments: { query, ...(context ? { context } : {}) } },
          }),
        }),
        env,
        ctx,
      );
      await settle();
      const ms = realNow() - started;
      const body = await response.json().catch(() => null);
      const text = (body?.result?.content ?? []).map((block) => block.text ?? "").join("\n");
      return { ok: response.status === 200 && body?.result?.isError !== true, text, ms };
    },

    /** A note put into the person's own workspace before a job runs, as if it were already there. */
    place(path, body) {
      s3.bucketFor(`bench-${own.workspace}`).set(path, { body, etag: `placed-${path.length}`, lastModified: modified(baseMs) });
    },

    /** A note's text in `workspace` (the person's own when omitted), or null. */
    read(path, workspace = null) {
      const object = s3.bucketFor(`bench-${workspace ?? own.workspace}`).get(path);
      return object ? bodyText(object) : null;
    },

    /** One `/agent` call with this body, as the world's grant: Tex's nightly dream, for a dreams grant. */
    async agent(body) {
      const { ctx, settle } = createWorkerCtx();
      const started = realNow();
      const response = await worker.fetch(
        new Request("https://mcp.bench.invalid/agent", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
        ctx,
      );
      const answer = await response.json().catch(() => null);
      await settle();
      const usage = controlPlane.builtinReports.at(-1) ?? {};
      return { status: response.status, body: answer, ms: realNow() - started, model: usage.model ?? null };
    },

    /** Every model call so far, and the chat's own ledger as its history file reads (`modelLog.mjs`). */
    modelCalls: () => modelCalls.calls(),
    async chatLedger() {
      return chatEntries(await this.readThrough("tex/history.ledger.json"));
    },

    /** One JSON-RPC call to the MCP endpoint, as an AI client connected with this grant makes it. */
    async mcp(method, params = {}) {
      const { ctx, settle } = createWorkerCtx();
      const response = await worker.fetch(
        new Request("https://mcp.bench.invalid/mcp", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }),
        env,
        ctx,
      );
      await settle();
      return response.json().catch(() => null);
    },

    close() {
      for (const undo of restore.reverse()) undo();
      d1?.close();
      for (const file of copies) rmSync(file, { force: true });
    },
  };
  return world;
}
