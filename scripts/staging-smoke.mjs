import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

async function request(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  assert.ok(response.ok, `${new URL(url).pathname}: HTTP ${response.status}`);
  return response;
}
const origin = 'https://staging.context.lc';
const gateway = 'https://mcp-staging.context.lc';
const ENTRY = /_expo\/static\/js\/web\/entry-[^"\s]+\.js/;
// A run that deployed the web app hands its export here and must see it live.
// A run that left the app alone checks whatever staging already serves.
const exported = 'apps/mobile/dist/index.html';
const fresh = existsSync(exported);
const bundle = fresh
  ? readFileSync(exported, 'utf8').match(ENTRY)?.[0]
  : (await (await request(origin)).text()).match(ENTRY)?.[0];
assert.ok(bundle, fresh ? 'exported app must name its entry bundle' : 'staging must serve an entry bundle');
let html = '';
for (let attempt = 0; attempt < 48; attempt++) {
  try { html = await (await request(origin)).text(); } catch { /* alias or DNS is propagating */ }
  if (html.includes(bundle)) break;
  console.log('Waiting for staging to serve this build.');
  await new Promise(resolve => setTimeout(resolve, 15000));
}
assert.ok(html.includes(bundle), 'staging must serve the bundle from this deploy');
const deepLink = await (await request(`${origin}/console/storage`)).text();
assert.ok(deepLink.includes(bundle), 'a deep link must receive the SPA shell from Static Assets');
const auth = await fetch(`${origin}/api/auth/signin/github`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
  redirect: 'manual',
  signal: AbortSignal.timeout(30000),
});
assert.ok(!(await auth.text()).includes(bundle), 'an OAuth endpoint must reach Convex, not the SPA fallback');
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
// tex.lc's staging stand-in: the same app and backend on Tex's own host. A
// person gets the SPA shell (which holds nothing personal: the status is read
// over the Convex socket with the browser's receipt); a crawler gets Tex's
// frozen card, noindex on /waitlist and /console.
const tex = 'https://tex-staging.context.lc';
const crawler = { headers: { 'User-Agent': 'Twitterbot/1.0' } };
assert.ok((await (await request(`${tex}/`)).text()).includes(bundle), 'the Tex host must serve this build');
for (const path of ['/waitlist', '/console', '/console/storage']) {
  const shell = await (await request(`${tex}${path}`)).text();
  assert.ok(shell.includes(bundle), `${path} on the Tex host must receive the SPA shell`);
  const card = await request(`${tex}${path}`, crawler);
  assert.match(card.headers.get('x-robots-tag') ?? '', /noindex/, `${path} on the Tex host must be noindex to crawlers`);
}
const texRobots = await (await request(`${tex}/robots.txt`)).text();
assert.match(texRobots, /Disallow: \/waitlist/, 'Tex robots.txt must keep /waitlist out of search');
const texCrawl = await (await request(`${tex}/`, crawler)).text();
assert.ok(texCrawl.includes('/og/tex-card.png'), 'a crawler on the Tex host must get the Tex card');
assert.ok(!texCrawl.includes('/og/card.png'), 'a crawler on the Tex host must not get the Context card');
const texCard = await request(`${tex}/og/tex-card.png`);
assert.equal(texCard.headers.get('content-type'), 'image/png');
const texAuth = await fetch(`${tex}/api/auth/signin/github`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
  redirect: 'manual',
  signal: AbortSignal.timeout(30000),
});
assert.ok(!(await texAuth.text()).includes(bundle), 'auth on the Tex host must reach Convex, not the SPA fallback');
const denied = await fetch(`${gateway}/mcp`, { method: 'POST', headers: { Origin: 'https://context.lc', 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(30000) });
assert.equal(denied.status, 403, 'production browser origin must not access staging MCP');
console.log('Staging assets, deep links, the Tex host, OAuth routing, backend signing keys, MCP discovery, origin isolation and transcription bindings verified.');
