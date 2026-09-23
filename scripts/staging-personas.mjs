import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { stagingNotes } from './fixtures/staging-notes.mjs';

const deployment = process.env.STAGING_CONVEX_DEPLOYMENT;
assert.equal(process.env.APP_ENV, 'staging');
assert.ok(deployment && /^[a-z0-9-]+$/.test(deployment));
const url = `https://${deployment}.convex.cloud`;
assert.equal(process.env.EXPO_PUBLIC_CONVEX_URL, url);
assert.equal(process.env.CONVEX_DEPLOY_KEY?.split('|')[0], `prod:${deployment}`);
const reset = process.argv.includes('--reset');
const ref = name => makeFunctionReference(name);
function prepare(restore = reset) {
  const result = spawnSync(process.execPath, ['node_modules/convex/bin/main.js', 'run', 'functions/stagingPersonas:prepare', JSON.stringify({ reset: restore })], {
    encoding: 'utf8', env: { ...process.env, CONVEX_DEPLOYMENT: '' },
  });
  if (result.status !== 0) throw new Error(`Staging preparation failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
const { workspaces } = prepare();
const clients = {};
for (const persona of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
  const client = new ConvexHttpClient(url, { logger: false });
  const email = `${persona}@supa.media`;
  await client.action(ref('auth:signIn'), { provider: 'email', params: { email } });
  const result = await client.action(ref('auth:signIn'), { provider: 'email', params: { email, code: '000000' } });
  assert.ok(result.tokens?.token, `${persona}: login failed`);
  client.setAuth(result.tokens.token);
  clients[persona] = client;
  console.log(`Signed in ${persona}.`);
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let noteCount = 0;
for (const { slug, workspaceId, owner } of workspaces) {
  const client = clients[owner];
  await client.mutation(ref('functions/billing:setEntitlements'), { workspaceId, managedStorage: true, fastSearch: false });
  await client.mutation(ref('functions/billing:activateTestPremium'), { workspaceId });
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    const binding = await client.query(ref('functions/storage:getStorageBinding'), { workspaceId });
    if (binding?.status === 'connected') { ready = true; break; }
    if (binding?.status === 'error') throw new Error(`${slug}: storage provisioning failed (${binding.errorCode ?? 'unknown'}).`);
    await pause(2000);
  }
  assert.ok(ready, `${slug}: storage did not become ready`);
  // Only new buckets need the ordinary onboarding scaffold.
  let index;
  try { index = await client.action(ref('functions/files:readNote'), { workspaceId, path: 'index.md' }); }
  catch (error) { if (error?.data?.code !== "FILE_NOT_FOUND") throw error; }
  if (!index) {
    await client.mutation(ref('functions/workspaces:applyStructure'), { workspaceId, template: 'para' });
    for (let attempt = 0; attempt < 60; attempt++) {
      try { index = await client.action(ref('functions/files:readNote'), { workspaceId, path: 'index.md' }); break; }
      catch (error) { if (error?.data?.code !== "FILE_NOT_FOUND") throw error; }
      await pause(2000);
    }
    assert.ok(index, `${slug}: scaffold did not complete`);
  }
  for (const [path, text] of Object.entries(stagingNotes[slug])) {
    let existing;
    try { existing = await client.action(ref('functions/files:readNote'), { workspaceId, path }); }
    catch (error) { if (error?.data?.code !== "FILE_NOT_FOUND") throw error; }
    if (!existing || reset || (path === 'index.md' && !existing.text.includes('staging-personas-v1'))) {
      await client.action(ref('functions/files:writeNote'), { workspaceId, path, text, ...(existing ? { expectedEtag: existing.etag } : {}) });
    }
    await client.action(ref('functions/files:setNoteVisibility'), { workspaceId, path, visibility: ['alpha','delta'].includes(slug) || path.includes('/leadership/') ? 'private' : 'team' });
    const read = await client.action(ref('functions/files:readNote'), { workspaceId, path });
    if (reset) assert.equal(read.text, text, `${slug}/${path}: readback differs`);
    noteCount++;
  }
  console.log(`${slug}: storage ready, ${Object.keys(stagingNotes[slug]).length} fixture notes verified.`);
}
const expected = {
  alpha: { 'alpha': 'owner', lumio: 'owner', 'maison-solenne': 'editor' },
  beta: { lumio: 'editor', 'maison-solenne': 'member', 'common-ground': 'editor' },
  gamma: { lumio: 'member', 'common-ground': 'member' },
  delta: { 'delta': 'owner', 'maison-solenne': 'owner', 'common-ground': 'owner' },
  epsilon: {},
};
const ws = Object.fromEntries(workspaces.map(w => [w.slug, w.workspaceId]));
for (const [persona, roles] of Object.entries(expected)) {
  const client = clients[persona];
  const actual = (await client.query(ref('functions/workspaces:listMyWorkspaces'), {})).filter(w => !w.pinned);
  assert.deepEqual(Object.fromEntries(actual.map(w => [w.slug, w.role])), roles, `${persona}: workspace access differs; use --reset to restore fixture memberships`);
  for (const { slug, workspaceId } of workspaces) {
    if (!roles[slug]) {
      await assert.rejects(client.action(ref('functions/files:readNote'), { workspaceId, path: 'index.md' }), error => error?.data?.code === "WORKSPACE_NOT_FOUND");
    } else {
      const read = await client.action(ref('functions/files:readNote'), { workspaceId, path: 'index.md' });
      assert.ok(read.text.includes('staging-personas-v1'));
      if (roles[slug] !== 'owner') await assert.rejects(client.action(ref('functions/files:readNote'), { workspaceId, path: '2-areas/leadership/private-plan.md' }), error => error?.data?.code === "FILE_NOT_FOUND");
    }
  }
  console.log(`${persona}: exact workspace roles and isolation verified.`);
}
await assert.rejects(clients.gamma.action(ref('functions/files:writeNote'), { workspaceId: ws.lumio, path: '0-inbox/should-not-exist.md', text: 'Must be refused.' }), error => error?.data?.code === "FORBIDDEN");
// Prove that a shared-only editor can save using ordinary permissions.
const editorPath = '1-projects/pulse-launch/roadmap.md';
const editorNote = await clients.beta.action(ref('functions/files:readNote'), { workspaceId: ws.lumio, path: editorPath });
await clients.beta.action(ref('functions/files:writeNote'), { workspaceId: ws.lumio, path: editorPath, text: editorNote.text, expectedEtag: editorNote.etag });
const invites = await clients.epsilon.query(ref('functions/invitations:listMyInvitations'), {});
assert.equal(invites.length, 1);
assert.equal(invites[0].slug, 'lumio');
// Exercise acceptance, then restore the initial invitation state for testers.
try {
  await clients.epsilon.mutation(ref('functions/invitations:acceptInvitation'), { token: invites[0].token });
  const joined = await clients.epsilon.query(ref('functions/workspaces:listMyWorkspaces'), {});
  assert.equal(joined.find(w => w.slug === 'lumio')?.role, 'editor');
} finally { prepare(true); }
assert.equal((await clients.epsilon.query(ref('functions/workspaces:listMyWorkspaces'), {})).filter(w => !w.pinned).length, 0);
assert.equal((await clients.epsilon.query(ref('functions/invitations:listMyInvitations'), {})).length, 1);
for (const client of Object.values(clients)) await client.action(ref('auth:signOut'), {});
console.log(`PASS: five logins, five workspaces, ${noteCount} notes, role boundaries, private notes, editor save and invitation acceptance; Epsilon restored to pending.`);
