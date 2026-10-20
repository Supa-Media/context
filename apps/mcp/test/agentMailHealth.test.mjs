/**
 * A BROKEN MAILBOX BUBBLES UP: TEX'S CHECK-INS, ROUTINES AND ORIENT
 * (owner, 2026-10-20: "they should be bubbling up if a connection has gone
 * bad", and "the user shouldn't have to even deal with this unless they have
 * to give a new permission").
 *
 * A dead Gmail sync changes no note, so a check-in used to find "nothing new"
 * and stay silent. The control plane now says how each mailbox is
 * (`/gateway/mail-health`, stubbed in `controlPlaneStub/mailHealth.mjs`);
 * a check-in raises one the person must act on, or one silent for hours,
 * even when nothing else changed, and tells the control plane it did; a
 * routine is told and never texts for it alone; orient names a mailbox only
 * when the person has to act. A mailbox that is merely recovering is said
 * nowhere.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted (2026-10-20).
 *
 *  1. `handleHeartbeat` returning nothing_new whenever nothing changed, mailboxes or not.
 *     → "nothing changed, but a mailbox needs reconnecting: the check-in still looks" fails.
 *  2. `withMailboxes` leaving the model's SKIP as it was.
 *     → "a check-in whose model stayed quiet still says the mailbox…" fails.
 *  3. The `store.mailHealth.raise` call removed from `handleHeartbeat`.
 *     → "…and tells the control plane what it raised" fails.
 *  4. `heartbeatMailSection` listing recovering mailboxes as owed.
 *     → "a mailbox that is only recovering is never said" fails.
 *  5. `routineRunQuestion` (`routine.js`, which `route.js` calls) not passing `mail`.
 *     → "a routine is told about a stale mailbox…" fails.
 *  6. `orientMailSection` naming stale mailboxes too.
 *     → "orient says nothing when every mailbox only needs time" fails.
 */

import worker from "../src/index.js";
import {
  heartbeatMailSection,
  mailboxLine,
  orientMailSection,
  routineMailSection,
  withMailboxes,
} from "../src/agent/mailHealth.js";
import { heartbeatPath } from "../src/agent/heartbeat.js";
import { createWorkerCtx } from "./workerCtx.mjs";
import { createControlPlaneStub, createS3Backend, CONTROL_PLANE_ORIGIN, GATEWAY_SECRET } from "./controlPlaneStub.mjs";
import { AI_GATEWAY_ENV, AI_GATEWAY_ORIGIN, BUILTIN_ALLOWED } from "./agentModelFixture.mjs";

const S3_ENDPOINT = "https://s3.example-mail-health.test";
const WORKSPACE = "ws_mail_health";
const TOKEN_BEAT = `cat_mailhealth_beat_${"0".repeat(20)}`;
const TOKEN_RUNNER = `cat_mailhealth_runner_${"0".repeat(18)}`;
const TOKEN_APP = `cat_mailhealth_app_${"0".repeat(21)}`;
const HOUR_MS = 60 * 60 * 1000;
const ADDRESS = "ada@example.invalid";

const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  4-archive: private\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

function fakeModel() {
  const requests = [];
  let script = [];
  return {
    requests,
    install(replies) {
      script = [...replies];
    },
    async handle(_url, init) {
      requests.push(JSON.parse(init.body));
      const step = script.shift();
      if (!step) throw new Error("fake model: the script ran out");
      return new Response(JSON.stringify({ content: [{ type: "text", text: step.text }], stop_reason: "end_turn" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

async function post(env, token, path, body) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request(`https://mcp.context.test${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  const text = await response.text();
  await settle();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: null };
  }
}

const userText = (request) => {
  const first = request?.messages?.[0]?.content;
  return typeof first === "string" ? first : JSON.stringify(first ?? "");
};

function unitChecks(check) {
  const now = Date.parse("2026-10-20T12:00:00Z");
  const broken = { address: ADDRESS, state: "needs_reconnect", lastSyncedAt: now - 3 * HOUR_MS, tell: true };
  const full = { address: "full@example.invalid", state: "store_full", lastSyncedAt: now, tell: true };
  const stale = { address: "quiet@example.invalid", state: "stale", lastSyncedAt: now - 9 * HOUR_MS, tell: true };
  const recovering = { address: "busy@example.invalid", state: "recovering", lastSyncedAt: now - HOUR_MS, tell: false };
  const ok = { address: "fine@example.invalid", state: "ok", lastSyncedAt: now, tell: false };
  check(
    "each state is told plainly, with what the person does; ok and recovering say nothing",
    mailboxLine(broken, now) ===
      `${ADDRESS} needs reconnecting: Google stopped letting Context read it, so new mail is not arriving. Tell the person once; they reconnect with manage connect_google.` &&
      mailboxLine(full, now).includes("is full") &&
      mailboxLine(stale, now).includes("has not synced since 9 hours ago") &&
      mailboxLine(broken, now, { v2: false }).includes("they reconnect with connect_google.") &&
      mailboxLine(recovering, now) === null &&
      mailboxLine(ok, now) === null,
  );
  const section = heartbeatMailSection([broken, { ...stale, tell: false }, recovering, ok], now);
  check(
    "a check-in is told what it owes them and what it already said today",
    section.includes(`- ${mailboxLine(broken, now)}`) &&
      section.includes("Already told them today, so never say again: quiet@example.invalid (stale)") &&
      !section.includes("busy@example.invalid") &&
      !section.includes("fine@example.invalid"),
  );
  check("a mailbox that is only recovering is never said", heartbeatMailSection([recovering, ok], now) === "" && routineMailSection([recovering, ok], now) === "");
  check(
    "a check-in's text keeps the model's words when they name the mailbox, and adds a sentence when they do not",
    withMailboxes(`Heads up: ${ADDRESS} needs reconnecting.`, [broken], now) === `Heads up: ${ADDRESS} needs reconnecting.` &&
      withMailboxes("Rent is due Friday.", [broken], now) ===
        `Rent is due Friday. Your mailbox ${ADDRESS} needs reconnecting before new mail can come in. Want the link?` &&
      withMailboxes(null, [full], now) === "Your mailbox full@example.invalid is full, so new mail isn't being saved.",
  );
  check(
    "a routine is told the same lines, and that it never answers for them alone",
    routineMailSection([stale], now).includes("quiet@example.invalid has not synced") &&
      routineMailSection([stale], now).includes("never a reason to answer instead of SKIP"),
  );
  check(
    "orient names only a mailbox the person must act on",
    orientMailSection([broken, full, stale, recovering], now).startsWith("## Mail connections\n") &&
      orientMailSection([broken, full, stale, recovering], now).includes(ADDRESS) &&
      orientMailSection([broken, full, stale, recovering], now).includes("full@example.invalid") &&
      !orientMailSection([broken, full, stale, recovering], now).includes("quiet@example.invalid"),
  );
  check("orient says nothing when every mailbox only needs time", orientMailSection([stale, recovering, ok], now) === null);
}

export async function runAgentMailHealthChecks(check) {
  unitChecks(check);

  const previousFetch = globalThis.fetch;
  const s3 = createS3Backend(S3_ENDPOINT);
  const restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  const restoreControlPlane = controlPlane.install();
  const model = fakeModel();
  const withStubs = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(AI_GATEWAY_ORIGIN)) return model.handle(url, init);
    return withStubs(input, init);
  };

  try {
    controlPlane.addWorkspace(WORKSPACE, "mailhealth", {
      provider: "s3",
      status: "active",
      endpoint: S3_ENDPOINT,
      region: "auto",
      bucket: "tenant-mail-health",
      accessKeyId: "AKIAEXAMPLEEXAMPLEMH",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEMH",
      forcePathStyle: true,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    });
    const grant = (accessToken, clientId) =>
      controlPlane.addGrant({
        accessToken,
        workspaceId: WORKSPACE,
        role: "owner",
        scopes: ["context:read", "context:write", "context:private"],
        clientId,
        userId: "user_mail_health",
      });
    await grant(TOKEN_BEAT, "context_heartbeat");
    await grant(TOKEN_RUNNER, "context_routines");
    await grant(TOKEN_APP, "client_mail_health_app");
    controlPlane.setBuiltinVerdict(WORKSPACE, BUILTIN_ALLOWED);

    const bucket = s3.bucketFor("tenant-mail-health");
    bucket.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "m0" });
    bucket.set("todo.md", { body: "# To do\n\n- Pay rent\n", etag: "m1", lastModified: new Date(Date.now() - 3 * HOUR_MS).toISOString() });
    bucket.set("routines/daily/inbox-digest.md", { body: "Text me what came in by email today.\n", etag: "m2" });
    const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, ...AI_GATEWAY_ENV };
    controlPlane.serveTreesFrom(env, { s3 });
    const mailboxes = controlPlane.dreams.mailHealth.mailboxes;
    const raised = controlPlane.dreams.mailHealth.raised;
    // Nothing in the notes changed in the last hour.
    const beat = () => ({ heartbeat: { timeZone: "UTC", since: Date.now() - HOUR_MS } });
    const now = Date.now();

    /* ---------------- a check-in with nothing else new ---------------- */

    mailboxes.set(WORKSPACE, [{ address: ADDRESS, state: "needs_reconnect", lastSyncedAt: now - 8 * HOUR_MS, tell: true }]);
    model.install([{ text: "SKIP" }]);
    const looked = await post(env, TOKEN_BEAT, "/agent", beat());
    check(
      "nothing changed, but a mailbox needs reconnecting: the check-in still looks, told to say it",
      model.requests.length === 1 &&
        userText(model.requests[0]).includes("Nothing in their notes changed since you last looked.") &&
        userText(model.requests[0]).includes(`${ADDRESS} needs reconnecting`) &&
        userText(model.requests[0]).includes("manage connect_google"),
    );
    check(
      "a check-in whose model stayed quiet still says the mailbox, in plain words",
      looked.status === 200 && looked.body?.outcome === "speak" &&
        looked.body?.answer === `Your mailbox ${ADDRESS} needs reconnecting before new mail can come in. Want the link?`,
    );
    check(
      "…and tells the control plane what it raised, as an address and a state",
      raised.length === 1 && raised[0].accessToken === TOKEN_BEAT &&
        JSON.stringify(raised[0].mailboxes) === JSON.stringify([{ address: ADDRESS, state: "needs_reconnect" }]),
    );
    check(
      "the day's log says why it looked with nothing changed, and what it texted",
      (bucket.get(heartbeatPath(Date.now(), "UTC"))?.body ?? "").includes("it looked because a mailbox needs them") &&
        (bucket.get(heartbeatPath(Date.now(), "UTC"))?.body ?? "").includes(`**Texted:** Your mailbox ${ADDRESS}`),
    );

    /* ---------------- already told today ---------------- */

    mailboxes.set(WORKSPACE, [{ address: ADDRESS, state: "needs_reconnect", lastSyncedAt: now - 8 * HOUR_MS, tell: false }]);
    const before = model.requests.length;
    const again = await post(env, TOKEN_BEAT, "/agent", beat());
    check(
      "already told today and nothing else new: nothing_new, no model, nothing raised",
      again.status === 200 && again.body?.outcome === "nothing_new" && model.requests.length === before && raised.length === 1,
    );

    /* ---------------- recovering ---------------- */

    mailboxes.set(WORKSPACE, [{ address: ADDRESS, state: "recovering", lastSyncedAt: now - HOUR_MS, tell: false }]);
    const recovering = await post(env, TOKEN_BEAT, "/agent", beat());
    check(
      "a rate-limited mailbox wakes nothing and is said nowhere",
      recovering.body?.outcome === "nothing_new" && model.requests.length === before,
    );

    /* ---------------- a routine ---------------- */

    mailboxes.set(WORKSPACE, [{ address: ADDRESS, state: "stale", lastSyncedAt: now - 9 * HOUR_MS, tell: true }]);
    model.install([{ text: "SKIP" }]);
    const ran = await post(env, TOKEN_RUNNER, "/agent", { routine: { path: "routines/daily/inbox-digest.md" } });
    check(
      "a routine is told about a stale mailbox, and that it never answers for it alone",
      ran.status === 200 && ran.body?.outcome === "skipped" &&
        userText(model.requests.at(-1)).includes(`${ADDRESS} has not synced since 9 hours ago`) &&
        userText(model.requests.at(-1)).includes("never a reason to answer instead of SKIP"),
    );
    check("a routine raises nothing itself", raised.length === 1);

    /* ---------------- orient ---------------- */

    const orient = async () => {
      const answer = await post(env, TOKEN_APP, "/mcp", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "orient", arguments: {} },
      });
      return answer.body?.result?.content?.[0]?.text ?? "";
    };
    mailboxes.set(WORKSPACE, [
      { address: ADDRESS, state: "needs_reconnect", lastSyncedAt: now - 8 * HOUR_MS, tell: false },
      { address: "fine@example.invalid", state: "ok", lastSyncedAt: now, tell: false },
    ]);
    const needs = await orient();
    check(
      "orient names a mailbox that needs the person, and how they reconnect",
      needs.includes("## Mail connections") && needs.includes(`${ADDRESS} needs reconnecting`) && !needs.includes("fine@example.invalid"),
    );
    mailboxes.set(WORKSPACE, [{ address: ADDRESS, state: "stale", lastSyncedAt: now - 9 * HOUR_MS, tell: true }]);
    const healthy = await orient();
    check("orient says nothing about mailboxes that only need time", healthy.includes("# Context") && !healthy.includes("Mail connections"));
  } finally {
    restoreControlPlane();
    restoreS3();
    globalThis.fetch = previousFetch;
  }
}
