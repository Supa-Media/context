/** Executable design experiment. Not a replacement sync service. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { mergeExternalText } from '../features/console/presence/sharedDoc.ts';

const snapshot = doc => Y.encodeStateAsUpdate(doc);
const fork = bytes => { const doc=new Y.Doc();Y.applyUpdate(doc,bytes);return doc; };
const text = doc => doc.getText('note');
const initial = (value='Heading\nOriginal paragraph.\n') => { const doc=new Y.Doc();text(doc).insert(0,value);return doc; };
const operation = (base, from, length, insert) => {
  // The fork retains the identities the author actually saw. Its delete can
  // only target those identities, never a concurrent insertion it did not see.
  const doc=fork(base); const vector=Y.encodeStateVector(doc);
  doc.transact(()=>{if(length)text(doc).delete(from,length);if(insert)text(doc).insert(from,insert);});
  const update=Y.encodeStateAsUpdate(doc,vector);doc.destroy();return update;
};
const has = (doc,...parts) => parts.every(p=>text(doc).toString().includes(p));

test('people editing distinct spans retain both changes',()=>{
  const base=snapshot(initial());const a=fork(base),b=fork(base);
  const left=operation(base,0,7,'Title A');const right=operation(base,text(b).length,0,'Added by B.\n');
  for(const update of [left,right])Y.applyUpdate(a,update);
  for(const update of [right,left])Y.applyUpdate(b,update);
  assert.equal(text(a).toString(),text(b).toString());assert.ok(has(a,'Title A','Added by B.'));
});
test('empty documents converge without waiting for nonempty text',()=>{
  const base=snapshot(initial(''));const a=fork(base),b=fork(base);
  const x=operation(base,0,0,'A'),y=operation(base,0,0,'B');
  for(const u of [x,y])Y.applyUpdate(a,u);for(const u of [y,x])Y.applyUpdate(b,u);
  assert.equal(text(a).toString(),text(b).toString());assert.ok(has(a,'A','B'));
});
test('agent edit based on its read keeps unseen human text',()=>{
  const doc=initial();const base=snapshot(doc);
  text(doc).insert(text(doc).length,'Unflushed human sentence.\n');
  Y.applyUpdate(doc,operation(base,0,7,'Agent title'));
  assert.ok(has(doc,'Agent title','Unflushed human sentence.'));
});
test('production replacement adapter loses unseen human text in the same race',()=>{
  const doc=initial();const replacement=text(doc).toString().replace('Heading','Agent title');
  text(doc).insert(text(doc).length,'Unflushed human sentence.\n');
  mergeExternalText({doc,text:text(doc)},replacement);
  assert.equal(has(doc,'Unflushed human sentence.'),false);
});
test('offline persisted CRDT restored after reload merges with online work',()=>{
  const server=initial();const base=snapshot(server);const offline=fork(base);
  text(offline).insert(text(offline).length,'Offline addition.\n');
  // The real implementation must commit these bytes in IndexedDB/SQLite.
  const persisted=new Uint8Array(snapshot(offline));offline.destroy();
  text(server).insert(0,'Online addition.\n');const restored=fork(persisted);
  const pending=snapshot(restored);Y.applyUpdate(restored,snapshot(server));Y.applyUpdate(server,pending);
  assert.equal(text(restored).toString(),text(server).toString());assert.ok(has(server,'Offline addition.','Online addition.'));
});
test('server materializes an agent edit with no browser present',()=>{
  const server=initial();Y.applyUpdate(server,operation(snapshot(server),0,7,'Agent title'));
  const markdown=text(server).toString();assert.ok(markdown.startsWith('Agent title'));
});
test('duplicate and reversed delivery cannot duplicate content',()=>{
  const base=snapshot(initial());const updates=Array.from({length:12},(_,i)=>operation(base,0,0,`[${i}]`));
  const a=fork(base),b=fork(base);
  updates.forEach(u=>Y.applyUpdate(a,u));[...updates,...updates].reverse().forEach(u=>Y.applyUpdate(b,u));
  assert.equal(text(a).toString(),text(b).toString());
});
test('compacted journal survives coordinator restart without reseeding',()=>{
  const base=snapshot(initial());const old=fork(base);text(old).insert(0,'Old offline replica.\n');
  const accepted=operation(base,0,7,'New heading');
  const journal=Y.mergeUpdates([base,accepted]);const restarted=fork(journal);
  Y.applyUpdate(restarted,snapshot(old));assert.ok(has(restarted,'New heading','Old offline replica.'));
});
test('contradictory concurrent replacements converge but do not infer intent',()=>{
  const base=snapshot(initial('Choose red.'));const x=operation(base,7,3,'blue'),y=operation(base,7,3,'green');
  const a=fork(base),b=fork(base);[x,y].forEach(u=>Y.applyUpdate(a,u));[y,x].forEach(u=>Y.applyUpdate(b,u));
  assert.equal(text(a).toString(),text(b).toString());assert.ok(has(a,'blue','green'));
});
test('undo can remove my work while preserving someone else’s',()=>{
  const doc=initial();const origin={author:'human'};const undo=new Y.UndoManager(text(doc),{trackedOrigins:new Set([origin])});
  doc.transact(()=>text(doc).insert(0,'My addition.\n'),origin);
  const remote=operation(snapshot(doc),text(doc).length,0,'Agent addition.\n');Y.applyUpdate(doc,remote,'remote');undo.undo();
  assert.equal(has(doc,'My addition.'),false);assert.ok(has(doc,'Agent addition.'));
});
