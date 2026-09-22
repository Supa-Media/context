import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

async function request(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  assert.ok(response.ok, `${new URL(url).pathname}: HTTP ${response.status}`);
  return response;
}
const origin = 'https://staging.context.lc';
const gateway = 'https://mcp-staging.context.lc';
const localHtml = readFileSync('apps/mobile/dist/index.html', 'utf8');
const bundle = localHtml.match(/_expo\/static\/js\/web\/entry-[^"\s]+\.js/)?.[0];
assert.ok(bundle, 'exported app must name its entry bundle');
let html = '';
for (let attempt = 0; attempt < 48; attempt++) {
  try { html = await (await request(origin)).text(); } catch { /* alias or DNS is propagating */ }
  if (html.includes(bundle)) break;
  console.log('Waiting for the staging web alias to serve this build.');
  await new Promise(resolve => setTimeout(resolve, 15000));
}
assert.ok(html.includes(bundle), 'staging must serve the bundle from this deploy');
const js = await (await request(`${origin}/${bundle}`)).text();
assert.ok(js.includes(process.env.EXPO_PUBLIC_CONVEX_URL), 'web bundle must use staging Convex');
assert.ok(js.includes(`${gateway}/mcp`), 'web bundle must use staging MCP');
const discovery = await (await request(`${gateway}/.well-known/oauth-authorization-server`)).json();
assert.equal(discovery.issuer, gateway);
assert.ok(discovery.authorization_endpoint.startsWith(gateway + '/'));
const jwks = await (await request(`${process.env.CONTROL_PLANE_URL}/.well-known/jwks.json`)).json();
assert.ok(jwks.keys?.length, 'staging must expose its signing public key');
const health = await (await request(`${process.env.TRANSCRIBE_WORKER_URL}/health`)).json();
assert.equal(health.ok, true);
assert.equal(health.ai, true);
assert.equal(health.rateLimit, true);
const denied = await fetch(`${gateway}/mcp`, { method: 'POST', headers: { Origin: 'https://context.lc', 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(30000) });
assert.equal(denied.status, 403, 'production browser origin must not access staging MCP');
console.log('Staging web bundle, backend signing keys, MCP discovery, origin isolation and transcription bindings verified.');
