import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SMOKE_PHONE,
  SMOKE_TEXT,
  appChatReplyAfter,
  appChatRoute,
  elapsedMs,
  originFrom,
  parseAppChatRows,
  parseThread,
  personalWorkspaceOf,
  replyAfter,
  sendFailure,
  simulatorKeyFor,
  simulatorSendUrl,
  simulatorThreadUrl,
  MEANING_QUERY,
  meaningHitIn,
  appSearchRoute,
} from './smoke.mjs';

test('the simulator key is 64 hex digits, deterministic, and differs per preview and per number', () => {
  const base = { deployKey: 'preview:team:project|secret', previewName: 'pr42', phone: SMOKE_PHONE };
  const a = simulatorKeyFor(base);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(simulatorKeyFor(base), a, 'a rerun on the same preview reuses the key');
  assert.notEqual(simulatorKeyFor({ ...base, previewName: 'pr43' }), a, 'differs per preview');
  assert.notEqual(simulatorKeyFor({ ...base, phone: '+12125550102' }), a, 'differs per number');
  assert.notEqual(simulatorKeyFor({ ...base, deployKey: 'preview:team:other|secret' }), a, 'differs per deploy key');
  assert.doesNotMatch(a, /secret/);
});

test('the simulator key refuses missing inputs', () => {
  assert.throws(() => simulatorKeyFor({ deployKey: '', previewName: 'pr42', phone: SMOKE_PHONE }), /deploy key/);
  assert.throws(() => simulatorKeyFor({ deployKey: 'k', previewName: 'main', phone: SMOKE_PHONE }), /pr<N>/);
  assert.throws(() => simulatorKeyFor({ deployKey: 'k', previewName: 'pr42', phone: '+14155550200' }), /555-0100/);
});

test('the simulated number is one the simulator accepts', () => {
  assert.match(SMOKE_PHONE, /^\+1[2-9]\d{2}55501\d{2}$/);
});

test('simulator routes are the send and thread paths under the agent origin', () => {
  assert.equal(simulatorSendUrl('https://agent.example.test'), 'https://agent.example.test/texts-simulator/api/send');
  assert.equal(simulatorThreadUrl('https://agent.example.test', SMOKE_PHONE), 'https://agent.example.test/texts-simulator/api/thread?phone=%2B12125550101');
});

test('origins must be bare https origins', () => {
  assert.equal(originFrom('https://agent.example.test/', 'X'), 'https://agent.example.test');
  assert.throws(() => originFrom('http://agent.example.test', 'X'), /https origin/);
  assert.throws(() => originFrom('https://agent.example.test/path', 'X'), /https origin/);
  assert.throws(() => originFrom('https://user:pw@agent.example.test', 'X'), /https origin/);
  assert.throws(() => originFrom('https://agent.example.test/?k=1', 'X'), /https origin/);
  assert.throws(() => originFrom('not a url', 'X'), /not a URL/);
});

test('send answers name the failure without the body', () => {
  assert.equal(sendFailure(200), null);
  assert.match(sendFailure(409), /claimed/);
  assert.match(sendFailure(429), /full/);
  assert.match(sendFailure(401), /refused/);
  assert.match(sendFailure(500), /HTTP 500/);
});

test('a thread response parses into messages with direction', () => {
  const thread = parseThread({
    messages: [
      { id: 1, dir: 'out', text: SMOKE_TEXT, at: 100 },
      { id: 2, dir: 'in', text: 'Hello.', at: 200 },
    ],
    typing: false,
  });
  assert.equal(thread.messages.length, 2);
  assert.equal(thread.messages[1].dir, 'in');
  assert.equal(thread.typing, false);
});

test('a malformed thread response is refused', () => {
  assert.throws(() => parseThread(null), /could not be read/);
  assert.throws(() => parseThread({}), /could not be read/);
  assert.throws(() => parseThread({ messages: [{ id: '1', dir: 'in', text: 'x' }] }), /malformed/);
  assert.throws(() => parseThread({ messages: [{ id: 1, dir: 'sideways', text: 'x' }] }), /malformed/);
});

test('a reply is the first non-empty incoming message after the smoke text', () => {
  const messages = [
    { id: 1, dir: 'out', text: 'earlier text', at: 1 },
    { id: 2, dir: 'in', text: 'an old answer', at: 2 },
    { id: 3, dir: 'out', text: SMOKE_TEXT, at: 3 },
    { id: 4, dir: 'in', text: '   ', at: 4 },
    { id: 5, dir: 'in', text: 'Hello!', at: 5 },
  ];
  assert.equal(replyAfter(messages, SMOKE_TEXT).id, 5);
});

test('no reply is null until Tex answers, and an unsent text has no reply', () => {
  const sentOnly = [{ id: 1, dir: 'out', text: SMOKE_TEXT, at: 1 }];
  assert.equal(replyAfter(sentOnly, SMOKE_TEXT), null);
  assert.equal(replyAfter([{ id: 2, dir: 'in', text: 'stray', at: 2 }], SMOKE_TEXT), null);
});

test('the most recent smoke text anchors the reply, so an older reply does not count', () => {
  const messages = [
    { id: 1, dir: 'out', text: SMOKE_TEXT, at: 1 },
    { id: 2, dir: 'in', text: 'old', at: 2 },
    { id: 3, dir: 'out', text: SMOKE_TEXT, at: 3 },
  ];
  assert.equal(replyAfter(messages, SMOKE_TEXT), null);
});

test('app chat route is the gateway origin with the tex path', () => {
  assert.equal(appChatRoute('https://mcp.example.test'), 'https://mcp.example.test/tex/app-chat');
});

test('app chat rows parse, dropping rows of no known author', () => {
  const parsed = parseAppChatRows({
    rows: [
      { id: 'a1', who: 'me', text: 'hi', at: 1 },
      { id: 'a2', who: 'tex', text: 'hello', at: 2 },
      { id: 7, who: 'tex', text: 'bad id' },
      { id: 'a3', who: 'system', text: 'x' },
    ],
    typing: true,
  });
  assert.deepEqual(parsed.rows.map((r) => r.id), ['a1', 'a2']);
  assert.equal(parsed.typing, true);
  assert.throws(() => parseAppChatRows({}), /could not be read/);
  assert.throws(() => parseAppChatRows(null), /could not be read/);
});

test('an app chat reply is the first new Tex row with words', () => {
  const rows = [
    { id: 'old', who: 'tex', text: 'before' },
    { id: 'mine', who: 'me', text: SMOKE_TEXT },
    { id: 'blank', who: 'tex', text: '  ' },
    { id: 'new', who: 'tex', text: 'One word.' },
  ];
  assert.equal(appChatReplyAfter(rows, new Set(['old'])).id, 'new');
  assert.equal(appChatReplyAfter(rows, new Set(['old', 'new'])), null);
  assert.equal(appChatReplyAfter([{ id: 'mine', who: 'me', text: 'x' }], new Set()), null);
});

test('the personal workspace is the owned, unpinned personal one', () => {
  const picked = personalWorkspaceOf([
    { workspaceId: 'shared', kind: 'shared', role: 'owner' },
    { workspaceId: 'pinned', kind: 'personal', role: 'owner', pinned: true },
    { workspaceId: 'mine', kind: 'personal', role: 'owner' },
  ]);
  assert.equal(picked.workspaceId, 'mine');
  assert.equal(personalWorkspaceOf([{ workspaceId: 'x', kind: 'personal', role: 'editor' }]), null);
});

test('elapsed time is never negative', () => {
  assert.equal(elapsedMs(1000, 1500), 500);
  assert.equal(elapsedMs(2000, 1500), 0);
});

test('the meaning check counts only a meaning-only hit on the weekly plan', () => {
  assert.equal(appSearchRoute('https://x.example'), 'https://x.example/app/search');
  assert.equal(meaningHitIn({ hits: [{ path: 'projects/weekly-plan.md', meaningOnly: false }] }), null);
  assert.equal(meaningHitIn({ hits: [{ path: 'inbox/quick-capture.md', meaningOnly: true }] }), null);
  assert.deepEqual(meaningHitIn({ hits: [{ path: 'projects/weekly-plan.md', meaningOnly: true }] }), { path: 'projects/weekly-plan.md', meaningOnly: true });
  assert.throws(() => meaningHitIn({}), /could not be read/);
});

test('the meaning query shares no word with the note it must find', async () => {
  const { stagingNotes } = await import('../../../scripts/fixtures/staging-notes.mjs');
  const note = stagingNotes.alpha['1-projects/weekly-plan.md'].toLowerCase();
  for (const word of MEANING_QUERY.toLowerCase().split(/\s+/)) assert.equal(note.includes(word), false, word);
});

