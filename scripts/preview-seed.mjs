#!/usr/bin/env node
/**
 * Signs a preview's personas in and writes their fixture notes. Runs after
 * `functions/seed:preview` has made the rows (the workspaces, the memberships
 * and the Tex chats), as the last step of the preview deploy.
 *
 * The preview is a copy of staging's identity, not of its data. Two things are
 * deliberately not done here:
 * - The `context-lc` workspace, a mirror of the production site, is skipped.
 *   A preview never reads or writes production content, and its fixture is
 *   that content.
 * - Managed storage is switched on with `billing:setEntitlements`, and the
 *   test upgrade with `billing:activateTestPremium`, as staging does. Neither
 *   needs a payment or a Stripe key. The second accepts an isolated preview
 *   only once the server change that allows it has landed.
 *
 * Sign-in codes are issued by `functions/signInCodes:issue` through the convex
 * CLI, for the preview deployment named by PREVIEW_DEPLOYMENT. A code is never
 * printed, and neither is the deploy key.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { stagingNotes } from './fixtures/staging-notes.mjs';

export const PERSONAS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
/** The fixture workspace that mirrors production and is never seeded into a preview. */
export const SKIPPED_SLUGS = ['context-lc'];
const CLI = fileURLToPath(new URL('../node_modules/convex/bin/main.js', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ref = (name) => makeFunctionReference(name);

/** The preview's identity, checked before anything is signed in. Returns the Convex URL. */
export function previewConfig(env) {
  if (env.APP_ENV !== 'preview') throw new Error('APP_ENV must be preview.');
  const deployment = env.PREVIEW_DEPLOYMENT;
  if (!deployment || !/^[a-z0-9-]+$/.test(deployment)) throw new Error('PREVIEW_DEPLOYMENT must name the preview deployment.');
  const url = `https://${deployment}.convex.cloud`;
  if (env.PREVIEW_CONVEX_URL !== url) throw new Error('PREVIEW_CONVEX_URL must be the preview deployment URL.');
  if (typeof env.CONVEX_DEPLOY_KEY !== 'string' || !env.CONVEX_DEPLOY_KEY.startsWith('preview:')) {
    throw new Error('CONVEX_DEPLOY_KEY must be a preview deploy key.');
  }
  return { deployment, url };
}

export function personaEmail(name) {
  if (!PERSONAS.includes(name)) throw new Error('Only the fixture personas are issued codes.');
  return `${name}@supa.media`;
}

/** The six-digit code the CLI printed, or a refusal. The code itself is never shown. */
export function parseIssuedCode(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Issuing a preview code returned something unreadable.');
  }
  if (!/^\d{6}$/.test(parsed?.code ?? '')) throw new Error('Issuing a preview code returned no code.');
  return parsed.code;
}

/**
 * One redacted line naming why the CLI failed, from its stderr alone. Digit runs
 * of four or more and any `preview:` deploy key are replaced, so no code or key
 * fragment can appear. Pure: the caller decides what to do with the line.
 */
export function cliFailureReason(stderr, status, error) {
  const lines = String(stderr ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const pattern = /error|uncaught|refused|not found|unauthorized|forbidden/i;
  const picked = [...lines].reverse().find((line) => pattern.test(line)) ?? lines.at(-1) ?? error?.message ?? `exit ${status ?? 'unknown'}`;
  return picked
    .replace(/\d{4,}/g, '…')
    .replace(/preview:[^\s'"]+/g, 'preview:…')
    .trim()
    .slice(0, 300);
}

/** Issues one fresh code for a persona on the named preview deployment. */
export function issuePersonaCode(email, { deployment, deployKey, run = spawnSync } = {}) {
  const result = run(process.execPath, [CLI, 'run', '--deployment', deployment, 'functions/signInCodes:issue', JSON.stringify({ email })], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CONVEX_DEPLOY_KEY: deployKey, CONVEX_DEPLOYMENT: '', NO_COLOR: '1' },
  });
  // stdout holds the code: it is parsed, never echoed. stderr is shown only as one
  // redacted line so a failure names its cause; stdout is never shown.
  if (result.error || result.status !== 0) {
    throw new Error(`Issuing a preview code failed: ${cliFailureReason(result.stderr, result.status, result.error)}`);
  }
  return parseIssuedCode(result.stdout);
}

/**
 * Runs `functions/seed:preview` on the named preview deployment, so the persona
 * accounts, workspaces, memberships and Tex chats exist before any code is issued.
 * The function finds-or-creates everything, so running it again is harmless.
 * Stdout is not printed: it names fixture workspaces and phone numbers.
 */
export function runConvexSeed({ deployment, deployKey, run = spawnSync } = {}) {
  const result = run(process.execPath, [CLI, 'run', '--deployment', deployment, 'functions/seed:preview', '{}'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CONVEX_DEPLOY_KEY: deployKey, CONVEX_DEPLOYMENT: '', NO_COLOR: '1' },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Seeding the preview deployment failed: ${cliFailureReason(result.stderr, result.status, result.error)}`);
  }
}

/** Visibility for a fixture note, the rule staging uses: personal and owner-only notes are private. */
export function visibilityFor(slug, path) {
  return ['alpha', 'delta'].includes(slug) || path.includes('/leadership/') ? 'private' : 'team';
}

/** Which persona writes a workspace's notes: an owner if there is one, else an editor. */
export function writerFor(memberships) {
  const owner = memberships.find((m) => m.role === 'owner');
  const editor = memberships.find((m) => m.role === 'editor');
  return owner ?? editor ?? null;
}

async function signIn(url, deployment, deployKey, name) {
  const client = new ConvexHttpClient(url, { logger: false });
  const email = personaEmail(name);
  const code = issuePersonaCode(email, { deployment, deployKey });
  const result = await client.action(ref('auth:signIn'), { provider: 'email', params: { email, code } });
  if (!result.tokens?.token) throw new Error(`${name}: sign-in failed.`);
  client.setAuth(result.tokens.token);
  return client;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function seedPreview(env = process.env, { log = console.log } = {}) {
  const { deployment, url } = previewConfig(env);
  const deployKey = env.CONVEX_DEPLOY_KEY;
  // `convex deploy --preview-run` runs only when the preview deployment is new; the seed is idempotent, so it runs on every deploy to make sure the persona accounts exist.
  runConvexSeed({ deployment, deployKey });
  log('preview-seed: Convex fixtures seeded.');
  const clients = {};
  for (const name of PERSONAS) {
    clients[name] = await signIn(url, deployment, deployKey, name);
    log(`Signed in ${name}.`);
  }

  // Every workspace the personas can reach, with who may write to it.
  const bySlug = new Map();
  for (const [name, client] of Object.entries(clients)) {
    for (const workspace of await client.query(ref('functions/workspaces:listMyWorkspaces'), {})) {
      if (workspace.pinned) continue;
      const entry = bySlug.get(workspace.slug) ?? { workspaceId: workspace.workspaceId, memberships: [] };
      entry.memberships.push({ persona: name, role: workspace.role });
      bySlug.set(workspace.slug, entry);
    }
  }

  let noteCount = 0;
  for (const [slug, entry] of bySlug) {
    const fixture = stagingNotes[slug];
    if (SKIPPED_SLUGS.includes(slug) || !fixture) {
      log(`${slug}: no fixture notes for a preview, skipped.`);
      continue;
    }
    const writer = writerFor(entry.memberships);
    if (!writer) {
      log(`${slug}: no member may write, skipped.`);
      continue;
    }
    const client = clients[writer.persona];
    const { workspaceId } = entry;
    if (writer.role === 'owner') {
      await client.mutation(ref('functions/billing:setEntitlements'), { workspaceId, managedStorage: true, fastSearch: false });
      // Staging's test upgrade, as staging calls it. The server accepts it on an isolated preview as well.
      await client.mutation(ref('functions/billing:activateTestPremium'), { workspaceId });
    }
    let ready = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      const binding = await client.query(ref('functions/storage:getStorageBinding'), { workspaceId });
      if (binding?.status === 'connected') { ready = true; break; }
      if (binding?.status === 'error') throw new Error(`${slug}: storage provisioning failed (${binding.errorCode ?? 'unknown'}).`);
      await pause(2000);
    }
    if (!ready) throw new Error(`${slug}: storage did not become ready.`);

    let index;
    try { index = await client.action(ref('functions/files:readNote'), { workspaceId, path: 'index.md' }); }
    catch (error) { if (error?.data?.code !== 'FILE_NOT_FOUND') throw error; }
    if (!index && writer.role === 'owner') {
      await client.mutation(ref('functions/workspaces:applyStructure'), { workspaceId, template: 'para' });
    }

    for (const [path, text] of Object.entries(fixture)) {
      let existing;
      try { existing = await client.action(ref('functions/files:readNote'), { workspaceId, path }); }
      catch (error) { if (error?.data?.code !== 'FILE_NOT_FOUND') throw error; }
      if (!existing || (path === 'index.md' && !existing.text.includes('staging-personas-v1'))) {
        await client.action(ref('functions/files:writeNote'), { workspaceId, path, text, ...(existing ? { expectedEtag: existing.etag } : {}) });
      }
      await client.action(ref('functions/files:setNoteVisibility'), { workspaceId, path, visibility: visibilityFor(slug, path) });
      noteCount++;
    }
    log(`${slug}: storage ready, ${Object.keys(fixture).length} fixture notes written.`);
  }

  // One read proves the seed landed: alpha's own front page.
  const alpha = bySlug.get('alpha');
  if (!alpha) throw new Error('alpha has no workspace to read.');
  const front = await clients.alpha.action(ref('functions/files:readNote'), { workspaceId: alpha.workspaceId, path: 'index.md' });
  if (!front.text.includes('staging-personas-v1')) throw new Error('The seeded front page did not read back.');

  for (const client of Object.values(clients)) await client.action(ref('auth:signOut'), {});
  log(`PASS: ${PERSONAS.length} personas signed in, ${noteCount} fixture notes written, one read confirmed.`);
  return { notes: noteCount };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await seedPreview(process.env);
  } catch (error) {
    console.error(`preview-seed: ${error.message}`);
    process.exitCode = 1;
  }
}
