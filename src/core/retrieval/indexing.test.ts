import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalIndexingService } from './indexing.ts';
import { embeddingFingerprint } from './types.ts';
import { setup,item,access } from './test-support.ts';

test('admission is durable lexical-only; drain indexes new item once, repeated upsert is idempotent',async()=>{
 const t=setup();try{
  const a=await t.indexing.index(item());assert.equal(a.lexicalState,'ready');assert.equal(a.vectorState,'pending');assert.equal(t.embeddings.documents,0);
  assert.equal((await t.indexing.drain()).ready,1);await t.indexing.index(item());await t.indexing.drain();assert.equal(t.embeddings.documents,1);
  assert.equal(t.db.prepare('SELECT count(*) AS n FROM retrieval_fts').get().n,1);assert.equal((await t.indexing.getStatistics()).compatible,1);
 }finally{t.db.close();}
});
test('metadata-only and scope changes do not embed again, changed text invalidates old vectors immediately',async()=>{
 const t=setup();try{
  await t.indexing.index(item());await t.indexing.drain();
  await t.indexing.index({...item(),metadata:{note:'changed'},updatedAt:3});await t.indexing.drain();assert.equal(t.embeddings.documents,1);
  const updated=await t.indexing.index({...item('a','river bank'),updatedAt:4});assert.equal(updated.vectorState,'stale');
  assert.equal((await t.store.vectors.search([1,0,0],t.f,{access,limit:5})).length,0);
  assert.equal((await t.store.lexical.search('river',{access,limit:5})).length,1);
  await t.indexing.drain();assert.equal(t.embeddings.documents,2);assert.equal((await t.indexing.getStatistics()).stale,0);
 }finally{t.db.close();}
});
test('delete and repeated deletion clean every projection and preserve unrelated source rows',async()=>{
 const t=setup();try{
  t.db.exec("CREATE TABLE source_records(id TEXT,content TEXT);INSERT INTO source_records VALUES('a','source')");
  await t.indexing.index(item());await t.indexing.drain();await t.indexing.remove('a');await t.indexing.remove('a');
  assert.equal((await t.indexing.getStatistics()).total,0);assert.equal(t.db.prepare('SELECT count(*) AS n FROM retrieval_fts').get().n,0);
  assert.equal(t.db.prepare('SELECT content FROM source_records').get().content,'source');
  await t.indexing.index(item('b'));assert.equal(await t.indexing.removeBySource(item('b').source),1);
 }finally{t.db.close();}
});
test('unloaded embeddings persist pending work, failures preserve lexical results, explicit retry recovers',async()=>{
 const t=setup();try{
  t.embeddings.loaded=false;await t.indexing.index(item());await t.indexing.drain();assert.equal((await t.indexing.getStatus('a')).vectorState,'pending');
  t.embeddings.loaded=true;t.embeddings.fail=true;assert.equal((await t.indexing.drain()).failed,1);
  const failed=await t.indexing.getStatus('a');assert.equal(failed.lexicalState,'ready');assert.equal(failed.vectorState,'failed');assert.ok(!JSON.stringify(failed.failure).includes('PRIVATE'));
  t.embeddings.fail=false;await t.indexing.reindex({ids:['a']});await t.indexing.drain();assert.equal((await t.indexing.getStatus('a')).vectorState,'ready');
 }finally{t.db.close();}
});
test('lexical failure is isolated from vector completion and can be retried without another embedding',async()=>{
 const t=setup();try{
  const indexer=new LocalIndexingService(t.store,{...t.store.lexical,upsert:async()=>{throw new Error('lexical disk error');}},t.store.vectors,t.embeddings);
  await indexer.index(item());await indexer.drain();assert.equal((await indexer.getStatus('a')).lexicalState,'failed');assert.equal((await indexer.getStatus('a')).vectorState,'ready');
  await t.store.lexical.remove('a');await t.indexing.drain();assert.equal((await t.indexing.getStatus('a')).lexicalState,'ready');assert.equal(t.embeddings.documents,1);
 }finally{t.db.close();}
});
test('configurable batching uses embedDocuments and isolates bad batch documents',async()=>{
 const t=setup();try{
  const indexer=new LocalIndexingService(t.store,t.store.lexical,t.store.vectors,t.embeddings,{batchSize:2,batchMode:'true_batch'});
  await indexer.indexMany([item('a'),item('b'),item('c')]);assert.equal((await indexer.drain()).ready,3);assert.equal(t.embeddings.batches,1);
 }finally{t.db.close();}
});
test('fingerprint migration detects stale vectors, filters incompatible vectors, selectively reindexes',async()=>{
 const t=setup();try{
  await t.indexing.indexMany([item('a'),item('b')]);await t.indexing.drain();t.embeddings.info.revision='b';
  const stats=await t.indexing.getStatistics();assert.equal(stats.vectors,2);assert.equal(stats.compatible,0);assert.equal(stats.stale,2);
  assert.equal((await t.store.vectors.search([1,0,0],embeddingFingerprint(t.embeddings.info),{access,limit:5})).length,0);
  assert.equal(await t.indexing.reindex({ids:['a'],staleOnly:true}),1);await t.indexing.drain();assert.equal((await t.indexing.getStatistics()).compatible,1);assert.equal((await t.indexing.getStatistics()).stale,1);
 }finally{t.db.close();}
});
test('cancellation leaves durable pending state and future drains work',async()=>{
 const t=setup();try{
  const controller=new AbortController();controller.abort();await assert.rejects(t.indexing.index(item(),{signal:controller.signal}),{code:'cancelled'});assert.equal((await t.indexing.getStatistics()).total,0);
  await t.indexing.index(item());const active=new AbortController();t.embeddings.gate=async()=>{active.abort();};
  assert.equal((await t.indexing.drain({signal:active.signal})).cancelled,true);assert.equal((await t.indexing.getStatus('a')).vectorState,'pending');
  t.embeddings.gate=undefined;assert.equal((await t.indexing.drain()).ready,1);
 }finally{t.db.close();}
});
test('inflight embedding cannot resurrect deleted or newer revisions, including delete/recreate ABA',async()=>{
 const t=setup();try{
  await t.indexing.index(item());let release:()=>void;let entered:()=>void;const started=new Promise<void>(r=>entered=r);
  t.embeddings.gate=()=>{entered();return new Promise<void>(r=>release=r);};const drain=t.indexing.drain();await started;
  await assert.rejects(t.indexing.drain(),{code:'indexing_busy'});await t.indexing.remove('a');await t.indexing.index(item());release();await drain;
  assert.equal((await t.indexing.getStatus('a')).vectorState,'pending');t.embeddings.gate=undefined;await t.indexing.drain();assert.equal((await t.indexing.getStatistics()).compatible,1);
 }finally{t.db.close();}
});
test('concurrent identical writes coalesce durable identity; provenance reassignment and old updates rejected',async()=>{
 const t=setup();try{
  await Promise.all(Array.from({length:10},()=>t.indexing.index(item())));await t.indexing.drain();assert.equal(t.embeddings.documents,1);
  await assert.rejects(t.indexing.index({...item(),source:{...item().source,id:'different'}}),{code:'identity_conflict'});
  await assert.rejects(t.indexing.index({...item(),updatedAt:1}),{code:'older_source_version'});
 }finally{t.db.close();}
});
test('removeBySource waits for prior admitted writes and cannot resurrect them',async()=>{
 const t=setup();try{
  const admission=t.indexing.index(item());const deletion=t.indexing.removeBySource(item().source);await admission;await deletion;
  assert.equal(await t.indexing.getStatus('a'),null);assert.equal((await t.indexing.drain()).ready,0);
 }finally{t.db.close();}
});
test('bounded admissions and pending count reject overload without losing admitted work',async()=>{
 const t=setup();try{
  const indexer=new LocalIndexingService(t.store,t.store.lexical,t.store.vectors,t.embeddings,{maxAdmissions:1,maxPending:1});
  const first=indexer.index(item('a'));await assert.rejects(indexer.index(item('b')),{code:'queue_full'});await first;
  await assert.rejects(indexer.index(item('b')),{code:'queue_full'});await indexer.drain();await indexer.index(item('b'));assert.equal((await indexer.getStatistics()).total,2);
 }finally{t.db.close();}
});
test('late content completion is discarded; cancellation retains the previous stale vector bytes safely',async()=>{
 const t=setup();try{
  await t.indexing.index(item());await t.indexing.drain();await t.indexing.index({...item('a','new content'),updatedAt:3});
  let release:()=>void;let entered:()=>void;const started=new Promise<void>(r=>entered=r);t.embeddings.gate=()=>{entered();return new Promise<void>(r=>release=r);};
  const drain=t.indexing.drain();await started;await t.indexing.index({...item('a','latest river content'),updatedAt:4});release();await drain;
  assert.equal((await t.indexing.getStatus('a')).vectorState,'stale');assert.equal((await t.indexing.getStatistics()).vectors,1);
  assert.equal((await t.store.vectors.search([1,0,0],t.f,{access,limit:5})).length,0);t.embeddings.gate=undefined;await t.indexing.drain();
  assert.equal((await t.indexing.getStatus('a')).vectorState,'ready');
 }finally{t.db.close();}
});
test('vector persistence failure leaves lexical content and old vector intact until explicit retry',async()=>{
 const t=setup();try{
  await t.indexing.index(item());await t.indexing.drain();await t.indexing.index({...item('a','changed content'),updatedAt:3});
  const bytes=t.db.prepare('SELECT hex(data) AS bytes FROM retrieval_vectors').get().bytes;
  const failing=new LocalIndexingService(t.store,t.store.lexical,{...t.store.vectors,upsert:async()=>{throw new Error('disk');}},t.embeddings);
  assert.equal((await failing.drain()).failed,1);assert.equal((await t.indexing.getStatus('a')).lexicalState,'ready');
  assert.equal(t.db.prepare('SELECT hex(data) AS bytes FROM retrieval_vectors').get().bytes,bytes);
  assert.equal((await t.store.vectors.search([1,0,0],t.f,{access,limit:5})).length,0);
  await t.indexing.reindex({ids:['a']});await t.indexing.drain();assert.equal((await t.indexing.getStatistics()).compatible,1);
 }finally{t.db.close();}
});
test('failed batches retry individual documents and isolate a poisonous record',async()=>{
 const t=setup();try{
  const original=t.embeddings.embedDocument.bind(t.embeddings);t.embeddings.embedDocuments=async()=>{t.embeddings.batches++;throw new Error('batch failed');};
  t.embeddings.embedDocument=async(text,options)=>{if(text==='bad')throw new Error('bad document');return original(text,options);};
  const indexer=new LocalIndexingService(t.store,t.store.lexical,t.store.vectors,t.embeddings,{batchSize:2});
  await indexer.indexMany([item('a','good'),item('b','bad')]);const report=await indexer.drain();assert.equal(report.ready,1);assert.equal(report.failed,1);
  assert.equal((await indexer.getStatus('a')).vectorState,'ready');assert.equal((await indexer.getStatus('b')).lexicalState,'ready');
 }finally{t.db.close();}
});
