#!/usr/bin/env node
/**
 * The end-to-end check of a preview, run after the preview is seeded. Two
 * paths a person would use, each waiting for Tex to answer:
 *
 * 1. A simulated text from a fictional number (555-0101), through the agent
 *    Worker's texts simulator. It enters the same queue as a real text and is
 *    answered by the same reply code; only the last hop is kept from a phone.
 * 2. A message in the app's own chat with Tex, the way the app sends it: alpha
 *    signs in, the console grant is minted, and the message goes to the
 *    gateway's `/tex/app-chat` route with that grant as the bearer.
 *
 * Each step prints its elapsed time. Nothing printed is a code, a token or a
 * key, and no origin is printed, only route paths. Exit status 1 names the
 * step that failed.
 *
 * Environment: PREVIEW_CONVEX_URL, PREVIEW_DEPLOYMENT, CONVEX_DEPLOY_KEY (a
 * preview key), PREVIEW_AGENT_ORIGIN and PREVIEW_MCP_ORIGIN (https origins).
 */
import { createHmac, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { issuePersonaCode, personaEmail, previewConfig } from './preview-seed.mjs';

export const SMOKE_PHONE = '+12125550101';
export const SMOKE_TEXT = 'Hi Tex, this is a preview smoke test. Reply with one word.';
export const REPLY_TIMEOUT_MS = 90_000;
/** Words that share none with alpha's weekly plan ("Make time for a long walk"), so only meaning can find it. */
export const MEANING_QUERY = 'stroll outdoors';
export const MEANING_PATH_END = 'weekly-plan.md';
export const MEANING_TIMEOUT_MS = 120_000;
const POLL_MS = 2_000;
const ref = (name) => makeFunctionReference(name);

/**
 * The simulator key for one preview and one simulated number: HMAC-SHA256 of
 * the preview name and the number, keyed with the preview deploy key. It is
 * stable, so a rerun on the same preview presents the key that claimed the
 * number, and it is 64 hex digits, which the simulator accepts. It needs no
 * secret of its own, and it is never printed.
 */
export function simulatorKeyFor({ deployKey, previewName, phone }) {
  if (typeof deployKey !== 'string' || deployKey === '') throw new Error('a deploy key is needed for the simulator key');
  if (!/^pr[1-9][0-9]{0,6}$/.test(previewName ?? '')) throw new Error('PREVIEW_NAME must be pr<N>.');
  if (!/^\+1[2-9]\d{2}55501\d{2}$/.test(phone ?? '')) throw new Error('the simulated number is not a 555-0100 to 555-0199 number');
  return createHmac('sha256', deployKey).update(`simulator:${previewName}:${phone}`).digest('hex');
}

/** An origin the smoke may call: https, a host, and no path, query or credentials. */
export function originFrom(value, name) {
  let parsed;
  try {
    parsed = new URL(value ?? '');
  } catch {
    throw new Error(`${name} is not a URL.`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash ||
    (parsed.pathname !== '' && parsed.pathname !== '/')) {
    throw new Error(`${name} must be an https origin.`);
  }
  return parsed.origin;
}

export function simulatorSendUrl(origin) {
  return `${origin}/texts-simulator/api/send`;
}

export function simulatorThreadUrl(origin, phone) {
  return `${origin}/texts-simulator/api/thread?phone=${encodeURIComponent(phone)}`;
}

/** The send's answer: 200 is queued. Anything else names what went wrong, never the body. */
export function sendFailure(status) {
  if (status === 200) return null;
  if (status === 409) return 'the simulated number is claimed by another key on this preview';
  if (status === 429) return 'the reply queue for the simulated number is full';
  if (status === 401) return 'the simulator key was refused';
  return `the simulator answered HTTP ${status}`;
}

/** A thread read, checked: its messages (`in` from Tex, `out` from the simulated phone) and whether Tex is typing. */
export function parseThread(body) {
  if (body === null || typeof body !== 'object' || !Array.isArray(body.messages)) {
    throw new Error('the simulator thread could not be read');
  }
  const messages = body.messages.map((m) => {
    if (m === null || typeof m !== 'object' || typeof m.id !== 'number' || (m.dir !== 'in' && m.dir !== 'out') || typeof m.text !== 'string') {
      throw new Error('the simulator thread has a malformed message');
    }
    return { id: m.id, dir: m.dir, text: m.text, at: typeof m.at === 'number' ? m.at : 0 };
  });
  return { messages, typing: body.typing === true };
}

/**
 * Tex's first answer after the smoke text: the first non-empty `in` message
 * whose id is above the id of the most recent `out` message carrying the text.
 * Null while there is none.
 */
export function replyAfter(messages, sentText) {
  let sent = null;
  for (const message of messages) {
    if (message.dir === 'out' && message.text === sentText && (sent === null || message.id > sent.id)) sent = message;
  }
  if (sent === null) return null;
  return messages.find((m) => m.dir === 'in' && m.id > sent.id && m.text.trim() !== '') ?? null;
}

export function appSearchRoute(origin) {
  return `${origin}/app/search`;
}

/** The meaning-only hit on alpha's weekly plan, or null. `{ hits }` as `/app/search` answers. */
export function meaningHitIn(body) {
  if (body === null || typeof body !== 'object' || !Array.isArray(body.hits)) throw new Error('the search answer could not be read');
  return body.hits.find((h) => h?.meaningOnly === true && typeof h.path === 'string' && h.path.endsWith(MEANING_PATH_END)) ?? null;
}

export function appChatRoute(origin) {
  return `${origin}/tex/app-chat`;
}

/** The app chat's rows, checked. `{ rows, typing }` as the route answers `get`. */
export function parseAppChatRows(body) {
  if (body === null || typeof body !== 'object' || !Array.isArray(body.rows)) {
    throw new Error('the app chat could not be read');
  }
  const rows = body.rows.filter((r) => r !== null && typeof r === 'object' && typeof r.id === 'string' && (r.who === 'me' || r.who === 'tex'));
  return { rows, typing: body.typing === true };
}

/** The first Tex row that is new since `baselineIds` and has words. */
export function appChatReplyAfter(rows, baselineIds) {
  return rows.find((r) => r.who === 'tex' && !baselineIds.has(r.id) && typeof r.text === 'string' && r.text.trim() !== '') ?? null;
}

/** The personal workspace the app chat belongs to: the one the person owns. */
export function personalWorkspaceOf(workspaces) {
  const own = workspaces.find((w) => w.kind === 'personal' && w.role === 'owner' && !w.pinned);
  return own ?? null;
}

export function elapsedMs(start, now = Date.now()) {
  return Math.max(0, now - start);
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A step that failed names itself and its reason, with no URL or value in it. */
class StepError extends Error {}

async function call(step, action) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof StepError) throw error;
    throw new StepError(`${step}: network error (${error?.name ?? 'unknown'}).`);
  }
}

async function pollUntil(step, read, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await read();
    if (found !== null) return found;
    await pause(POLL_MS);
  }
  throw new StepError(`${step}: no reply from Tex within ${Math.round(timeoutMs / 1000)} seconds.`);
}

async function simulatorStep(agent, env, log) {
  const key = simulatorKeyFor({ deployKey: env.CONVEX_DEPLOY_KEY, previewName: env.PREVIEW_NAME, phone: SMOKE_PHONE });
  const headers = { 'content-type': 'application/json', 'x-simulator-key': key };
  let start = Date.now();
  const sent = await call('simulator send', () => fetch(simulatorSendUrl(agent), {
    method: 'POST',
    headers,
    body: JSON.stringify({ phone: SMOKE_PHONE, text: SMOKE_TEXT }),
  }));
  const failure = sendFailure(sent.status);
  if (failure !== null) throw new StepError(`simulator send: ${failure}.`);
  log(`simulator send: queued (HTTP ${sent.status}) in ${elapsedMs(start)} ms`);

  start = Date.now();
  const reply = await pollUntil('simulator reply', async () => {
    const response = await call('simulator thread', () => fetch(simulatorThreadUrl(agent, SMOKE_PHONE), { headers }));
    if (response.status !== 200) throw new StepError(`simulator thread: HTTP ${response.status}.`);
    const thread = parseThread(await response.json());
    return replyAfter(thread.messages, SMOKE_TEXT);
  }, REPLY_TIMEOUT_MS);
  log(`simulator reply: Tex answered in ${elapsedMs(start)} ms`);
  return reply;
}

async function appChatStep(env, origin, log) {
  const deployment = previewConfig(env).deployment;
  const url = env.PREVIEW_CONVEX_URL;
  let start = Date.now();
  const client = new ConvexHttpClient(url, { logger: false });
  const email = personaEmail('alpha');
  const code = issuePersonaCode(email, { deployment, deployKey: env.CONVEX_DEPLOY_KEY });
  const signed = await call('app sign-in', () => client.action(ref('auth:signIn'), { provider: 'email', params: { email, code } }));
  if (!signed.tokens?.token) throw new StepError('app sign-in: refused.');
  client.setAuth(signed.tokens.token);
  log(`app sign-in: alpha signed in in ${elapsedMs(start)} ms`);

  start = Date.now();
  const workspace = personalWorkspaceOf(await client.query(ref('functions/workspaces:listMyWorkspaces'), {}));
  if (workspace === null) throw new StepError('app workspace: alpha has no personal workspace.');
  const grant = await call('app grant', () => client.action(ref('functions/agentGrant:mintConsoleGrant'), {
    workspaceId: workspace.workspaceId,
    consoleInstanceId: `smoke-${randomBytes(4).toString('hex')}`,
  }));
  if (typeof grant.accessToken !== 'string' || grant.accessToken === '') throw new StepError('app grant: none minted.');
  const bearer = grant.accessToken;
  log(`app grant: minted in ${elapsedMs(start)} ms`);

  const post = (body) => call('app chat', () => fetch(appChatRoute(origin), {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));

  const before = await post({ op: 'get' });
  if (before.status !== 200) throw new StepError(`app chat read: HTTP ${before.status}.`);
  const baselineIds = new Set(parseAppChatRows(await before.json()).rows.map((r) => r.id));

  start = Date.now();
  const sent = await post({ op: 'send', text: SMOKE_TEXT });
  if (sent.status !== 200) throw new StepError(`app chat send: HTTP ${sent.status}.`);
  log(`app chat send: queued (HTTP ${sent.status}) in ${elapsedMs(start)} ms`);

  start = Date.now();
  const reply = await pollUntil('app chat reply', async () => {
    const response = await post({ op: 'get' });
    if (response.status !== 200) throw new StepError(`app chat read: HTTP ${response.status}.`);
    return appChatReplyAfter(parseAppChatRows(await response.json()).rows, baselineIds);
  }, REPLY_TIMEOUT_MS);
  log(`app chat reply: Tex answered in ${elapsedMs(start)} ms`);

  // Search by meaning: the first search asks the object to build its index behind the answer, so the meaning-only
  // match can take a few searches to appear.
  start = Date.now();
  let hitAt = null;
  while (Date.now() - start < MEANING_TIMEOUT_MS) {
    const response = await call('meaning search', () => fetch(appSearchRoute(origin), {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: MEANING_QUERY }),
    }));
    if (response.status !== 200) throw new StepError(`meaning search: HTTP ${response.status}.`);
    if (meaningHitIn(await response.json()) !== null) { hitAt = elapsedMs(start); break; }
    await pause(5_000);
  }
  if (hitAt === null) throw new StepError(`meaning search: no meaning-only match within ${MEANING_TIMEOUT_MS / 1000} seconds.`);
  log(`meaning search: found the note by meaning alone in ${hitAt} ms`);

  await call('app sign-out', () => client.action(ref('auth:signOut'), {})).catch(() => {});
  return reply;
}

export async function smoke(env = process.env, { log = console.log } = {}) {
  const agent = originFrom(env.PREVIEW_AGENT_ORIGIN, 'PREVIEW_AGENT_ORIGIN');
  const mcp = originFrom(env.PREVIEW_MCP_ORIGIN, 'PREVIEW_MCP_ORIGIN');
  previewConfig(env);
  await simulatorStep(agent, env, log);
  await appChatStep(env, mcp, log);
  log('PASS: simulated text and in-app message both answered by Tex; search by meaning found a note.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await smoke(process.env);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
