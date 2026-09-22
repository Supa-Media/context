import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as Y from 'yjs';
import { readDocument, commitUpdate, replaceText, moveDocument, tombstoneDocument, restoreDocument } from '../src/index.js';

// Content-addressed etags deliberately repeat when bytes repeat, as they do
// with real object storage. A counter-only stub hides revision identity bugs.
class Bucket {
  capabilities = { conditionalWrite:true, conditionalCreate:true, conditionalDelete:true };
  objects = new Map();
  async get(key) {
    const value=this.objects.get(key);
    return value ? {etag:value.etag,text:async()=>value.text} : null;
  }
  async put(key,text,options={}) {
    await Promise.resolve();
    const old=this.objects.get(key);
    if(options.onlyIf?.absent&&old)return null;
    if(options.onlyIf?.etagMatches&&old?.etag!==options.onlyIf.etagMatches)return null;
    const etag=createHash('sha256').update(text).digest('hex');
    this.objects.set(key,{text,etag});return {etag};
  }
  async delete(key,options={}) {
    const old=this.objects.get(key);
    if(options.onlyIf?.etagMatches&&old?.etag!==options.onlyIf.etagMatches)return null;
    this.objects.delete(key);return {deleted:true};
  }
  async list({prefix='',cursor,limit=1000}={}) {
    const matching=[...this.objects].filter(([key])=>key.startsWith(prefix)).sort(([a],[b])=>a.localeCompare(b));
    const start=cursor?matching.findIndex(([key])=>key>cursor):0;
    const selected=start<0?[]:matching.slice(start,start+limit);
    const truncated=start>=0&&start+limit<matching.length;
    return {objects:selected.map(([key,value])=>({key,etag:value.etag})),truncated,...(truncated?{cursor:selected.at(-1)[0]}:{})};
  }
}
const bytes=value=>new Uint8Array(Buffer.from(value,'base64'));
const encoded=doc=>Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');
const fork=value=>{const doc=new Y.Doc();Y.applyUpdate(doc,bytes(value));return doc;};
const note=doc=>doc.getText('note');

// Independent edits are delivered in different orders to the storage engine
// and a plain Yjs oracle. Assertions compare final content, not engine internals.
test('delayed, duplicated, reordered edits converge across fresh replicas',async()=>{
  for(let round=0;round<12;round++) {
    const store=new Bucket();await store.put('note.md','Start 🧭\nMiddle\nEnd\n');
    const opened=await readDocument(store,'note.md');
    const oracle=fork(opened.update), clients=Array.from({length:4},()=>fork(opened.update));
    const updates=[];
    for(let step=0;step<16;step++) {
      const client=clients[(step*3+round)%clients.length];
      const value=note(client),before=Y.encodeStateVector(client);
      const pos=(step*7+round)%Math.max(1,value.length);
      client.transact(()=>{
        if(step%5===0&&value.length>pos+2)value.delete(pos,1);
        value.insert(pos,`[${round}:${step}]`);
      });
      const update=Y.encodeStateAsUpdate(client,before);
      updates.push(update);Y.applyUpdate(oracle,update);
      if(step%3===0)Y.applyUpdate(clients[(step+round)%4],update);
    }
    for(const update of [...updates].reverse().concat(updates.filter((_,i)=>i%3===0))) {
      await commitUpdate(store,'note.md',{documentId:opened.documentId,update:Buffer.from(update).toString('base64')});
    }
    const restored=await readDocument(store,'note.md');
    assert.equal(restored.text,note(oracle).toString(),`round ${round}`);
    assert.equal(await (await store.get('note.md')).text(),restored.text);
    for(const client of clients) {
      const reloaded=fork(encoded(client));Y.applyUpdate(reloaded,bytes(restored.update));
      assert.equal(note(reloaded).toString(),restored.text);reloaded.destroy();client.destroy();
    }
    oracle.destroy();
  }
});

test('same Markdown bytes after delete/retype do not reuse an older editing base',async()=>{
  const store=new Bucket();await store.put('note.md','Original sentence.');
  const first=await readDocument(store,'note.md');
  const doc=fork(first.update);note(doc).delete(0,note(doc).length);note(doc).insert(0,'Original sentence.');
  await commitUpdate(store,'note.md',{documentId:first.documentId,update:encoded(doc)});
  const fresh=await readDocument(store,'note.md');
  assert.notEqual(first.etag,fresh.etag,'read versions must distinguish different editing identities');
  const changed=await replaceText(store,'note.md',{expectedEtag:fresh.etag,text:'Revised sentence.'});
  assert.equal(changed.text,'Revised sentence.');doc.destroy();
});

test('two concurrent retries of the same agent replacement insert only once',async()=>{
  const store=new Bucket();await store.put('note.md','Header\nBody\n');
  const base=await readDocument(store,'note.md');
  const edit={expectedEtag:base.etag,text:'Header\nBody\nOne agent addition.\n'};
  await Promise.all([replaceText(store,'note.md',edit),replaceText(store,'note.md',edit)]);
  const result=await readDocument(store,'note.md');
  assert.equal(result.text,edit.text);
});

test('a long multi-section rewrite preserves a concurrent edit between changed sections',async()=>{
  const store=new Bucket();
  const middle='unchanged paragraph '.repeat(300);
  const original=`Header\n${middle}\nFooter`;
  await store.put('note.md',original);const base=await readDocument(store,'note.md');
  const human=fork(base.update),where=20;
  note(human).insert(where,'HUMAN');
  await commitUpdate(store,'note.md',{documentId:base.documentId,update:encoded(human)});
  const revised=`New heading\n${middle}\nNew ending`;
  const result=await replaceText(store,'note.md',{expectedEtag:base.etag,text:revised});
  const expected=`New heading\n${original.slice(7,where)}HUMAN${original.slice(where,-7)}\nNew ending`;
  assert.equal(result.text,expected);human.destroy();
});

test('concurrent first opens share one seed, including empty notes',async()=>{
  for(const content of ['', 'One copy only.']) {
    const store=new Bucket();await store.put('note.md',content);
    const results=await Promise.all(Array.from({length:5},()=>readDocument(store,'note.md')));
    assert.equal(new Set(results.map(r=>r.documentId)).size,1);
    assert.equal(new Set(results.map(r=>r.update)).size,1);
    assert.equal((await readDocument(store,'note.md')).text,content);
  }
});

test('a delayed old materializer cannot leave newer accepted text rolled back',async()=>{
  const store=new Bucket();await store.put('note.md','Original');
  const base=await readDocument(store,'note.md');
  const put=store.put.bind(store);
  let release,pausedResolve;
  const paused=new Promise(r=>pausedResolve=r),held=new Promise(r=>release=r);
  let intercept=true;
  store.put=async(key,value,options)=>{
    if(intercept&&key==='note.md'&&value==='Intermediate') {
      intercept=false;pausedResolve();await held;
    }
    return put(key,value,options);
  };
  const old=replaceText(store,'note.md',{expectedEtag:base.etag,text:'Intermediate'});
  await paused;
  // Another request helps complete the pending save while its first writer is
  // delayed. A later revision restores identical bytes and therefore the old
  // Markdown etag. The old request must not mistake that for its original base.
  const middle=await readDocument(store,'note.md');
  await replaceText(store,'note.md',{expectedEtag:middle.etag,text:'Original'});
  release();await old.catch(()=>{});
  const current=await readDocument(store,'note.md');
  assert.equal(current.text,'Original');
  assert.equal(await (await store.get('note.md')).text(),'Original');
});

test('trash and restore keep identity and accept the original offline edits',async()=>{
  const store=new Bucket();await store.put('note.md','Keep this history.');
  const base=await readDocument(store,'note.md'), offline=fork(base.update);
  note(offline).insert(note(offline).length,' Offline addition.');
  await tombstoneDocument(store,'note.md',{expectedEtag:base.etag});
  assert.equal(await store.get('note.md'),null);
  const restored=await restoreDocument(store,'note.md');
  assert.equal(restored.documentId,base.documentId);
  const merged=await commitUpdate(store,'note.md',{documentId:base.documentId,update:encoded(offline)});
  assert.equal(merged.text,'Keep this history. Offline addition.');offline.destroy();
});

test('recreating the same path and same bytes cannot attach an old offline device',async()=>{
  const store=new Bucket();await store.put('note.md','Same bytes.');
  const base=await readDocument(store,'note.md'), offline=fork(base.update);
  note(offline).insert(0,'OLD DEVICE ');
  await tombstoneDocument(store,'note.md',{expectedEtag:base.etag});
  await store.put('note.md','Same bytes.',{onlyIf:{absent:true}});
  const recreated=await readDocument(store,'note.md');
  assert.notEqual(recreated.documentId,base.documentId);
  await assert.rejects(commitUpdate(store,'note.md',{documentId:base.documentId,update:encoded(offline)}),error=>error.code==='GENERATION_MISMATCH');
  assert.equal((await readDocument(store,'note.md')).text,'Same bytes.');offline.destroy();
});

test('permanent deletion after a move removes every retained content copy',async()=>{
  const marker='ERASE_THIS_PRIVATE_SENTENCE_84';
  const store=new Bucket();await store.put('note.md',marker);
  const base=await readDocument(store,'note.md');
  await replaceText(store,'note.md',{expectedEtag:base.etag,text:marker+' edited'});
  await moveDocument(store,'note.md','renamed.md');
  await tombstoneDocument(store,'renamed.md',{permanent:true});
  assert.equal(await store.get('renamed.md'),null);
  for(const [key,object] of store.objects) {
    assert.ok(!object.text.includes(marker),`${key} retained deleted prose`);
    const record=JSON.parse(object.text);
    assert.ok(!record.snapshot&&!record.initialSnapshot&&!record.update,`${key} retained encoded editing content`);
  }
});

test('a stale pre-collaboration etag cannot authorize deleting newer edits',async()=>{
  const store=new Bucket();const original=await store.put('note.md','First.');
  const base=await readDocument(store,'note.md');
  await replaceText(store,'note.md',{expectedEtag:base.etag,text:'First. New writing.'});
  await assert.rejects(tombstoneDocument(store,'note.md',{expectedEtag:original.etag}),error=>error.code==='CONFLICT');
  assert.equal((await readDocument(store,'note.md')).text,'First. New writing.');
});

test('move recovers when the process disappears after each storage mutation',async()=>{
  for(let crashAt=1;crashAt<=12;crashAt++) {
    const store=new Bucket();await store.put('from.md','Never lose this.');
    const initial=await readDocument(store,'from.md');
    const put=store.put.bind(store),remove=store.delete.bind(store);let writes=0;
    const crashed=()=>{if(++writes===crashAt)throw new Error('simulated process exit');};
    store.put=async(...args)=>{const result=await put(...args);crashed();return result;};
    store.delete=async(...args)=>{const result=await remove(...args);crashed();return result;};
    await moveDocument(store,'from.md','to.md').catch(()=>{});
    store.put=put;store.delete=remove;
    let restored;
    for(let attempt=0;attempt<3&&!restored;attempt++) {
      try {restored=await readDocument(store,'to.md');}catch {}
      if(!restored)await moveDocument(store,'from.md','to.md').catch(()=>{});
    }
    assert.ok(restored,`move stranded after mutation ${crashAt}`);
    assert.equal(restored.documentId,initial.documentId);
    assert.equal(restored.text,'Never lose this.');
    assert.equal(await store.get('from.md'),null);
    assert.equal(await (await store.get('to.md')).text(),restored.text);
  }
});

test('an aborted move clears its prepared destination after the copied body is journaled',async()=>{
  const store=new Bucket();await store.put('from.md','Original source.');
  let injected=false;
  const put=store.put.bind(store);
  store.put=async(key,value,options={})=>{
    const result=await put(key,value,options);
    if(!injected&&key==='to.md'&&options.onlyIf?.absent===true){
      injected=true;
      await put('from.md','Source changed during the move.');
    }
    return result;
  };
  const get=store.get.bind(store);let reads=0;
  store.get=async(...args)=>{if(++reads>160)throw new Error('move recovery exceeded test operation budget');return get(...args);};
  await assert.rejects(moveDocument(store,'from.md','to.md'),error=>error.code==='DESTINATION_EXISTS');
  assert.equal(injected,true);
  assert.equal(await (await get('from.md')).text(),'Source changed during the move.');
  await assert.rejects(readDocument(store,'to.md'),error=>error.code==='DOCUMENT_MISSING');
  assert.ok(reads<160);
});

test('a recreated destination after an aborted move becomes an independent generation',async()=>{
  const store=new Bucket();await store.put('from.md','Original source.');
  let injected=false;
  const put=store.put.bind(store);
  store.put=async(key,value,options={})=>{
    const result=await put(key,value,options);
    if(!injected&&key==='to.md'&&options.onlyIf?.absent===true){
      injected=true;
      await put('from.md','Source changed during the move.');
    }
    return result;
  };
  await assert.rejects(moveDocument(store,'from.md','to.md'),error=>error.code==='DESTINATION_EXISTS');
  store.put=put;
  const recreated=await put('to.md','Independent destination.',{onlyIf:{absent:true}});
  assert.ok(recreated);
  const opened=await readDocument(store,'to.md');
  assert.equal(opened.text,'Independent destination.');
  assert.equal(await (await store.get('to.md')).text(),'Independent destination.');
});

test('an edit racing the destination copy is preserved when ownership was not journaled',async()=>{
  const store=new Bucket();await store.put('from.md','Original source.');
  let injected=false;
  const put=store.put.bind(store);
  store.put=async(key,value,options={})=>{
    const result=await put(key,value,options);
    if(!injected&&key==='to.md'&&options.onlyIf?.absent===true){
      injected=true;
      queueMicrotask(()=>{void put('to.md','Independent writer.');});
    }
    return result;
  };
  await assert.rejects(moveDocument(store,'from.md','to.md'),error=>error.code==='DESTINATION_EXISTS');
  store.put=put;
  assert.equal(await (await store.get('to.md')).text(),'Independent writer.');
  assert.equal(await (await store.get('from.md')).text(),'Original source.');
  const opened=await readDocument(store,'to.md');
  assert.equal(opened.text,'Independent writer.');
});

test('an interrupted aborted-move cleanup resumes from its journal',async()=>{
  const store=new Bucket();await store.put('from.md','Original source.');
  let injected=false,interruptCleanup=true;
  const put=store.put.bind(store),remove=store.delete.bind(store);
  store.put=async(key,value,options={})=>{
    const result=await put(key,value,options);
    if(!injected&&key==='to.md'&&options.onlyIf?.absent===true){
      injected=true;
      await put('from.md','Source changed during the move.');
    }
    return result;
  };
  store.delete=async(key,options={})=>{
    if(interruptCleanup&&key==='to.md'){interruptCleanup=false;throw new Error('simulated cleanup interruption');}
    return remove(key,options);
  };
  await assert.rejects(moveDocument(store,'from.md','to.md'),error=>error.message==='simulated cleanup interruption');
  store.put=put;store.delete=remove;
  let reads=0;const get=store.get.bind(store);
  store.get=async(...args)=>{if(++reads>160)throw new Error('move recovery exceeded test operation budget');return get(...args);};
  await assert.rejects(readDocument(store,'to.md'),error=>error.code==='DOCUMENT_MISSING');
  assert.ok(reads<160);
  assert.equal(await (await get('from.md')).text(),'Source changed during the move.');
});

test('the plaintext protocol rejects hidden maps and embedded objects',async()=>{
  for(const kind of ['map','embed']) {
    const store=new Bucket();await store.put('note.md','Plain prose.');
    const initial=await readDocument(store,'note.md');
    const hostile=new Y.Doc();
    if(kind==='map')hostile.getMap('note').set('invisible','hidden non-Markdown content');
    else hostile.getText('note').insertEmbed(0,{invisible:'hidden non-Markdown content'});
    await assert.rejects(commitUpdate(store,'note.md',{documentId:initial.documentId,update:encoded(hostile)}),error=>error.code==='INVALID_UPDATE');
    assert.equal((await readDocument(store,'note.md')).text,'Plain prose.');hostile.destroy();
  }
});

test('permanent deletion resumes its history purge after each interrupted mutation',async()=>{
  for(let crashAt=1;crashAt<=14;crashAt++) {
    const marker='PURGE_ON_RETRY_77';
    const store=new Bucket();await store.put('note.md',marker);
    const initial=await readDocument(store,'note.md');
    await replaceText(store,'note.md',{expectedEtag:initial.etag,text:marker+' newer'});
    const put=store.put.bind(store),remove=store.delete.bind(store);let writes=0;
    const crashed=()=>{if(++writes===crashAt)throw new Error('simulated process exit');};
    store.put=async(...args)=>{const result=await put(...args);crashed();return result;};
    store.delete=async(...args)=>{const result=await remove(...args);crashed();return result;};
    await tombstoneDocument(store,'note.md',{permanent:true}).catch(()=>{});
    store.put=put;store.delete=remove;
    await tombstoneDocument(store,'note.md',{permanent:true}).catch(error=>{error.message=`mutation ${crashAt}: ${error.message}`;throw error;});
    assert.equal(await store.get('note.md'),null);
    for(const [key,object] of store.objects) {
      const record=JSON.parse(object.text);
      assert.ok(!object.text.includes(marker)&&!record.snapshot&&!record.initialSnapshot&&!record.update,`mutation ${crashAt}: ${key} retained deleted content after retry`);
    }
  }
});

test('the real trash handle preserves identity, without exposing plumbing through public APIs',async()=>{
  const store=new Bucket();await store.put('note.md','Original identity.');
  const original=await readDocument(store,'note.md');
  const trash='.context/trash/2026-09-22/note.md';
  await assert.rejects(moveDocument(store,'note.md',trash),error=>error.code==='INELIGIBLE_DOCUMENT');
  const moved=await moveDocument(store,'note.md',trash,{internalTrash:true,expectedEtag:original.etag});
  assert.equal(moved.documentId,original.documentId);
  assert.equal(await (await store.get(trash)).text(),'Original identity.');
  await assert.rejects(readDocument(store,trash),error=>error.code==='INELIGIBLE_DOCUMENT');
  const restored=await moveDocument(store,trash,'note.md',{internalTrash:true});
  assert.equal(restored.documentId,original.documentId);
  assert.equal(await store.get(trash),null);
});

test('a reused old filename starts its own identity after a move',async()=>{
  const store=new Bucket();await store.put('from.md','First identity.');
  const first=await readDocument(store,'from.md');
  await moveDocument(store,'from.md','to.md');
  await store.put('from.md','New identity.',{onlyIf:{absent:true}});
  const second=await readDocument(store,'from.md');
  assert.notEqual(second.documentId,first.documentId);
  assert.equal((await readDocument(store,'to.md')).documentId,first.documentId);
});

test('an in-flight rejected edit removes its unpublished revision after permanent deletion',async()=>{
  const store=new Bucket();await store.put('note.md','Earlier prose.');
  const initial=await readDocument(store,'note.md'), client=fork(initial.update);
  note(client).insert(0,'LATE_PRIVATE_REVISION ');
  const put=store.put.bind(store);let resume,reached;
  const paused=new Promise(resolve=>{reached=resolve;});
  const release=new Promise(resolve=>{resume=resolve;});
  let injected=false;
  store.put=async(key,value,...rest)=>{
    if(!injected&&key.includes('/revisions/')&&String(value).includes('LATE_PRIVATE_REVISION')) {
      injected=true;reached();await release;
    }
    return put(key,value,...rest);
  };
  const editing=commitUpdate(store,'note.md',{documentId:initial.documentId,update:encoded(client)});
  await paused;
  await tombstoneDocument(store,'note.md',{permanent:true});
  resume();
  await assert.rejects(editing,error=>error.code==='DELETED');
  assert.equal(await store.get('note.md'),null);
  for(const [key,object] of store.objects)assert.ok(!object.text.includes('LATE_PRIVATE_REVISION'),`${key} retained rejected content`);
  client.destroy();
});

test('agent edits preserve emoji and combining text alongside a human insertion', async()=>{
  const store=new Bucket();
  const original='# 😀 café\n\ne\u0301 and 👩\u200d💻\n';
  await store.put('unicode.md',original);
  const base=await readDocument(store,'unicode.md');
  const human=fork(base.update);
  note(human).insert(note(human).length,'Human 👋\n');
  await commitUpdate(store,'unicode.md',{documentId:base.documentId,update:encoded(human)});
  const target=original.replace('😀','😎').replace('café','cafe\u0301');
  const result=await replaceText(store,'unicode.md',{expectedEtag:base.etag,text:target});
  assert.equal(result.text,target+'Human 👋\n');
  assert.equal((await readDocument(store,'unicode.md')).text,result.text);
  human.destroy();
});
