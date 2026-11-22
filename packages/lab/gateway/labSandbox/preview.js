/**
 * A LAB TEST CHAT ON A PULL REQUEST'S CODE (Dev2, 2026-11-22: test chats gain "run on PR #N's code", so a change is
 * tried in a test chat before it merges; Dev2's card "On PR #N's preview": it runs on that pull request's own preview,
 * with fictional people and stand-in mail and calendar, and never touches production's data).
 *
 * `open { code: "#N", source, ... }` opens the test chat on pull request N's preview instead of here. Production keeps
 * only a stand-in for it (the person's own test chat object, its `chat.remote` naming the pull request and the mailbox)
 * and every later call on it (`send`, `get`, `step` reads, Reset, ...) is handed to the preview's own `/tex-lab/sandbox`
 * through the mailbox (`bridge.js`) and a GitHub workflow on main (`lab-preview-chat.yml`), and its answer comes back
 * as the preview gave it, with the preview's id for the test chat put back to this one's. The preview runs the pull
 * request's code on its own data: its texts, rows, steps and writes are the preview's, and nothing here is sent there
 * but the call itself (the words of a test text, and a draft's graph, which is the repository's config).
 *
 * `POST /tex-lab/sandbox/bridge` is the workflow's own door: GitHub's signed token for that workflow on main
 * (`bench/oidc.js`), and nothing else. It takes a mailbox's calls and hands answers back.
 */

import { verifyGithubToken } from "../bench/oidc.js";
import { bearerToken } from "../fromGateway/session.js";
import { json } from "../fromGateway/http_responses.js";
import { callSandbox, sandboxStub } from "./object.js";

export const BRIDGE_PATH = "/tex-lab/sandbox/bridge";
export const BRIDGE_AUDIENCE = "context-lab-preview";
export const BRIDGE_WORKFLOW = "Supa-Media/context/.github/workflows/lab-preview-chat.yml@refs/heads/main";
/** "#4012", "pr4012" or "4012"; "main" (or nothing) is this deployment's own code. */
const PR_CODE = /^(?:#|pr)?([1-9][0-9]{0,6})$/i;
const BRIDGE_ID = /^[0-9a-f]{32}$/;
/** Test chats a person opens on previews a day: each starts a GitHub run. */
export const DAILY_PREVIEW_OPENS = 30;
/** How long a call waits for the preview's answer, and an open's first answer (the workflow is starting). */
export const CALL_WAIT_MS = 25_000;
/** A workflow not heard from, dispatched longer ago than this, is started again by the next call. */
export const REDISPATCH_MS = 3 * 60_000;
/** The ops whose answer is the turn's: they carry the draft as drawn, since the preview has no copy of the Lab's drafts. */
const DRAFT_OPS = new Set(["open", "send", "react", "edit", "unsend", "retry", "use", "checkin", "nightly"]);

const refused = (status, error, extra = {}) => json({ error, ...extra }, status);
const hex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The pull request a call's `code` names, `null` for this deployment's own code, or `{ error }`. */
export function previewOf(code) {
  if (code === undefined || code === null || code === "" || code === "main") return null;
  const m = typeof code === "string" ? PR_CODE.exec(code.trim()) : null;
  return m ? { pr: Number(m[1]) } : { error: 'code is "main" or a pull request: "#<number>"' };
}

/** A test chat's mailbox object (`bridge.js`), named by its random id. */
export const bridgeStub = (env, bridgeId) => sandboxStub(env, "bridge", bridgeId);

/** The words a person reads when a preview is not there to answer. */
const notConnected = (pr) => `Pull request #${pr}'s preview isn't connected to this test chat yet: its GitHub run takes about a minute to start. Try again shortly.`;

/** The draft a call runs on, as the preview takes it: its id and its graph as drawn (it has no copy of the Lab's drafts). */
async function withDraft(helpers, controlPlane, token, body, versionId, drawnGraph, kept) {
  if (versionId === undefined || versionId === null || versionId === "" || versionId === "main") return { body: { ...body, versionId: "main" } };
  const drafted = await helpers.draftConfig(controlPlane, token, versionId, drawnGraph, kept);
  if (drafted.error) return { error: drafted.error };
  return { body: { ...body, versionId, graph: JSON.stringify(drafted.config) }, config: drafted.config, drawn: drafted.drawn === true };
}

/** Starts (again) the workflow that carries a mailbox's calls. */
async function dispatch(controlPlane, token, env, pr, bridgeId) {
  const said = await controlPlane.labSandbox(token, "previewChat", { pr, bridge: bridgeId }).catch(() => null);
  if (said === null) return { error: "the control plane did not answer" };
  if (said.status !== "ok") return { error: typeof said.error === "string" ? said.error : "GitHub did not start the preview's run" };
  await callSandbox(bridgeStub(env, bridgeId), "bridge.dispatched", {}).catch(() => {});
  return { ok: true };
}

/** The preview's answer with its id for the test chat put back to this one's, in every field and line. */
export function asOurs(answer, previewId, sandboxId) {
  if (typeof previewId !== "string" || previewId === "") return answer;
  return JSON.parse(JSON.stringify(answer ?? null).split(previewId).join(sandboxId));
}

/**
 * `open { code: "#N", ... }`: a stand-in test chat here, a mailbox, and the workflow started; the preview's own open is
 * the mailbox's first call, answered once the workflow has signed in there (about a minute), and `about`/`get` say so.
 * `null` when `code` names this deployment's own code (the route opens it as before).
 */
export async function openOnPreview({ env, controlPlane, token, who, input, origin, helpers }) {
  const named = previewOf(input.code);
  if (named === null) return null;
  if (named.error) return refused(400, named.error);
  const { pr } = named;
  const source = input.source ?? "maya";
  if (!["maya", "set", "chat"].includes(source)) return refused(400, 'a test chat on a pull request\'s preview starts from "maya", a Training or Dev conversation ("set"), or the preview\'s own chats ("chat")');
  const counted = await callSandbox(helpers.indexStub(env, who.userId), "count", { key: `previews:${new Date().toISOString().slice(0, 10)}`, max: DAILY_PREVIEW_OPENS }).catch(() => ({ ok: true }));
  if (!counted.ok) return refused(429, `That's ${DAILY_PREVIEW_OPENS} test chats on pull requests today, each a GitHub run: use one you have open.`);
  const { code: _code, by: _by, ...rest } = input;
  const drafted = await withDraft(helpers, controlPlane, token, rest, input.versionId, input.graph);
  if (drafted.error) return refused(...drafted.error);
  const sandboxId = hex(8);
  const bridgeId = hex(16);
  const opened = await callSandbox(bridgeStub(env, bridgeId), "bridge.open", { pr, userId: who.userId, sandboxId });
  if (!opened.ok) return refused(500, "The test chat's mailbox could not be made. Try again.");
  const about = {
    sandboxId,
    origin,
    source,
    chat: typeof input.chatId === "string" && input.chatId !== "" ? input.chatId : "me",
    kind: "one",
    people: [],
    versionId: typeof input.versionId === "string" && input.versionId !== "" ? input.versionId : "main",
    config: drafted.config ?? null,
    ...(drafted.drawn ? { drawn: true } : {}),
    ...(typeof input.convId === "string" ? { convId: input.convId } : {}),
    remote: { pr, bridge: bridgeId },
  };
  const stub = sandboxStub(env, who.userId, sandboxId);
  await callSandbox(stub, "init", { about, rows: [], history: [] });
  const started = await dispatch(controlPlane, token, env, pr, bridgeId);
  if (started.error) {
    await callSandbox(stub, "reset", {}).catch(() => {});
    await callSandbox(bridgeStub(env, bridgeId), "bridge.stop", {}).catch(() => {});
    return refused(502, `Pull request #${pr}'s preview could not be started: ${started.error}`);
  }
  await callSandbox(helpers.indexStub(env, who.userId), "meta", { key: `sb:${sandboxId}`, value: { sandboxId, source, chat: about.chat, kind: "1:1", versionId: about.versionId, code: `#${pr}`, by: helpers.byOf(input.by), at: Date.now() } }).catch(() => {});
  // The preview's own open, queued for the workflow: kept, so it waits for the run to start.
  const first = await callSandbox(bridgeStub(env, bridgeId), "bridge.call", { kind: "open", body: { ...drafted.body, op: "open", source }, waitMs: Number.isSafeInteger(input.waitMs) ? Math.min(input.waitMs, 45_000) : 0 });
  console.log(JSON.stringify({ event: "lab_sandbox_open", source, kind: "preview", draft: about.versionId !== "main" }));
  if (first?.status === 200) return json({ ...asOurs(first.answer, first.answer?.sandboxId, sandboxId), sandboxId, code: `#${pr}` });
  return json({ sandboxId, code: `#${pr}`, people: [], rows: [], preview: { pr, starting: true, said: "Its GitHub run is starting (about a minute); get or about says when the test chat is open there." } });
}

/**
 * Every call on a test chat that runs on a preview: handed to the preview, its answer back. Before the preview has
 * answered the open, `get` and `about` answer the stand-in (nothing yet) and anything else is refused, saying so.
 */
export async function forwardToPreview({ env, controlPlane, token, who, stub, state, input, helpers }) {
  const chat = state.meta.chat;
  const { pr, bridge } = chat.remote;
  const mailbox = bridgeStub(env, bridge);
  if (input.op === "reset") {
    const status = await callSandbox(mailbox, "bridge.status", {}).catch(() => null);
    if (status?.previewId) await callSandbox(mailbox, "bridge.call", { body: { op: "reset", sandboxId: status.previewId }, waitMs: 10_000 }).catch(() => null);
    await callSandbox(mailbox, "bridge.stop", {}).catch(() => {});
    return null; // the route resets the stand-in and the person's index as for any test chat
  }
  const status = await callSandbox(mailbox, "bridge.status", {}).catch(() => null);
  if (status === null || status.error) return refused(410, "This test chat's link to its preview is gone: open another.");
  const preview = { pr, open: status.previewId !== null, connected: status.connected };
  // The workflow ended (twenty minutes unused) or never started: the next call starts it again.
  if (!status.connected && Date.now() - (status.dispatchedAt ?? 0) > REDISPATCH_MS) {
    const again = await dispatch(controlPlane, token, env, pr, bridge);
    if (again.error) return refused(502, `Pull request #${pr}'s preview could not be started again: ${again.error}`);
  }
  if (status.previewId === null) {
    if (input.op === "get") return helpers.json({ rows: [], writes: [], running: null, line: null, code: `#${pr}`, preview: { ...preview, starting: true } });
    if (input.op === "about") return helpers.json({ ...helpers.aboutOf(state), code: `#${pr}`, preview: { ...preview, starting: true } });
    return refused(409, notConnected(pr), { preview: { ...preview, starting: true } });
  }
  const { code: _code, by: _by, sandboxId: _ours, graph: drawnGraph, ...rest } = input;
  let body = { ...rest, sandboxId: status.previewId };
  if (DRAFT_OPS.has(input.op)) {
    // `use` names the draft the next texts run on; every other call runs the one the test chat has now.
    const versionId = input.op === "use" ? input.versionId : chat.versionId;
    const drafted = await withDraft(helpers, controlPlane, token, body, versionId, drawnGraph, chat.drawn === true ? chat.config : undefined);
    if (drafted.error) return refused(...drafted.error);
    body = drafted.body;
    if (input.op === "use" || drawnGraph !== undefined) {
      await callSandbox(stub, "meta", { key: "chat", value: { ...chat, versionId: body.versionId, config: drafted.config ?? null, drawn: drafted.drawn === true } });
    }
  }
  const said = await callSandbox(mailbox, "bridge.call", { body, waitMs: CALL_WAIT_MS });
  if (said?.timeout) return refused(504, said.connected ? `Pull request #${pr}'s preview didn't answer in time. Try again.` : notConnected(pr), { preview });
  if (said?.error) return refused(said.error === "busy" ? 429 : 410, said.error === "busy" ? "Too many calls are waiting for the preview: try again in a moment." : "This test chat's link to its preview is gone: open another.");
  const answer = asOurs(said.answer, status.previewId, input.sandboxId);
  // Every answer says where it runs, as the Lab and tex_dev show it.
  const shaped = answer && typeof answer === "object" && !Array.isArray(answer) ? { ...answer, code: `#${pr}` } : answer;
  return json(shaped, Number.isSafeInteger(said.status) ? said.status : 502);
}

/**
 * `POST /tex-lab/sandbox/bridge` `{ op: "take" | "answer", bridge, ... }`: the workflow on main, by GitHub's signed
 * token (its run id holds the mailbox). `take` answers the calls waiting (or none after a wait) and the pull request;
 * `answer { n, status, answer }` hands one back.
 */
export async function handleBridge(request, env, { verify = verifyGithubToken } = {}) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (!env?.LAB_SANDBOX) return refused(501, "this deployment has no Lab test chats");
  const token = bearerToken(request);
  if (!token) return refused(401, "GitHub's signed token for the Lab's preview workflow");
  const checked = await verify(token, { audience: BRIDGE_AUDIENCE, workflow: BRIDGE_WORKFLOW, use: "the Lab's preview test chats" });
  if (checked.refused) return refused(403, checked.refused);
  const run = `${checked.claims.run_id ?? ""}`;
  if (!/^[0-9]{1,20}$/.test(run)) return refused(403, "the token names no run");
  const input = await request.json().catch(() => null);
  if (!input || typeof input !== "object" || !BRIDGE_ID.test(String(input.bridge ?? ""))) return refused(400, "a call is { op, bridge, ... }");
  const mailbox = bridgeStub(env, input.bridge);
  if (input.op === "take") return json(await callSandbox(mailbox, "bridge.take", { run, waitMs: input.waitMs }));
  if (input.op === "answer") {
    const status = Number.isSafeInteger(input.status) ? input.status : 502;
    return json(await callSandbox(mailbox, "bridge.answer", { run, n: input.n, status, answer: input.answer ?? null }));
  }
  return refused(400, "op is take or answer");
}
