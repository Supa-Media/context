import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference as ref } from 'convex/server';

assert.equal(process.env.APP_ENV, 'staging');
const deployment = process.env.STAGING_CONVEX_DEPLOYMENT;
assert.ok(deployment && /^[a-z0-9-]+$/.test(deployment));
const url = `https://${deployment}.convex.cloud`;
assert.equal(process.env.EXPO_PUBLIC_CONVEX_URL, url);
const reset = process.argv.includes('--reset');

for (const [owner, slugs] of [['alpha', ['alpha', 'lumio']], ['delta', ['delta', 'maison-solenne', 'common-ground']]]) {
  const client = new ConvexHttpClient(url, { logger: false });
  const email = `${owner}@supa.media`;
  await client.action(ref('auth:signIn'), { provider: 'email', params: { email } });
  const result = await client.action(ref('auth:signIn'), { provider: 'email', params: { email, code: '000000' } });
  assert.ok(result.tokens?.token);
  client.setAuth(result.tokens.token);
  try {
    const workspaces = await client.query(ref('functions/workspaces:listMyWorkspaces'), {});
    for (const slug of slugs) {
      const workspace = workspaces.find(w => w.slug === slug && w.role === 'owner');
      assert.ok(workspace, `${owner} does not own ${slug}`);
      if (workspace.icon && !reset) {
        console.log(`${slug}: existing icon preserved.`);
        continue;
      }
      const file = await readFile(new URL(`./fixtures/staging-logos/${slug}.png`, import.meta.url));
      assert.ok(file.byteLength <= 1048576);
      const bytes = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
      await client.action(ref('functions/files:setWorkspaceIconPhoto'), { workspaceId: workspace.workspaceId, bytes, contentType: 'image/png' });
      const saved = await client.action(ref('functions/files:workspaceIconPhoto'), { workspaceId: workspace.workspaceId });
      assert.equal(saved.contentType, 'image/png');
      assert.deepEqual(Buffer.from(saved.bytes), file);
      console.log(`${slug}: logo uploaded and readback verified.`);
    }
  } finally {
    await client.action(ref('auth:signOut'), {});
  }
}
