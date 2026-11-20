import test from 'node:test';
import assert from 'node:assert/strict';
import { ownHostsFrom, problemsFrom } from './browser.mjs';

test('only page errors and failed requests to the preview hosts count', () => {
  const own = ownHostsFrom({ PREVIEW_ROUTER_ORIGIN: 'https://r.example', PREVIEW_MCP_ORIGIN: 'https://m.example', PREVIEW_CONVEX_URL: 'not a url' });
  assert.deepEqual(own, ['r.example', 'm.example']);
  const problems = problemsFrom({
    pageErrors: ['TypeError: x is undefined\n    at y'],
    failedRequests: [
      { url: 'https://m.example/app/search?q=1', reason: 'net::ERR_FAILED' },
      { url: 'https://fonts.example/a.woff', reason: 'net::ERR_ABORTED' },
    ],
  }, own);
  assert.deepEqual(problems, ['page error: TypeError: x is undefined', 'request failed: /app/search (net::ERR_FAILED)']);
});
