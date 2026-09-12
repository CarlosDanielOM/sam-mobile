import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS,SCHEMA_VERSION } from '../persistence/schema.ts';
import { SqliteRetrievalStore } from '../persistence/sqlite-retrieval-store.ts';
import { SqliteRetrievalLabStore } from '../persistence/sqlite-retrieval-lab-store.ts';
import { evaluateRanking,summarizeEvaluation,testCorpus,EVALUATION_CASES,LAB_ACCESS,LAB_FILTER } from './lab.ts';
import { syntheticVector,runBackendBenchmark } from './benchmark.ts';
import { setup,sqlite } from './test-support.ts';

test('migration 6 upgrades version 5 additively, preserves sessions/messages/telemetry and rolls back failure',()=>{
 const db=new DatabaseSync(':memory:');try{
  for(const m of MIGRATIONS.filter(m=>m.version<=5))for(const sql of m.statements)db.exec(sql);
  db.exec("INSERT INTO conversations(id,title,created_at,updated_at) VALUES('s','saved',1,2);INSERT INTO messages(id,conversation_id,role,content,status,created_at,updated_at) VALUES('m','s','user','private original','completed',1,2)");
  const before=db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  db.exec('BEGIN');db.exec(MIGRATIONS[5].statements[0]);assert.throws(()=>db.exec(MIGRATIONS[5].statements[0]));db.exec('ROLLBACK');
  assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all(),before);
  db.exec('BEGIN');for(const sql of MIGRATIONS[5].statements)db.exec(sql);db.exec('COMMIT');
  assert.equal(SCHEMA_VERSION,6);assert.equal(db.prepare('SELECT content FROM messages').get().content,'private original');
  assert.equal(db.prepare('SELECT count(*) AS n FROM retrieval_items').get().n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM model_calls').get().n,0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  const store=new SqliteRetrievalStore(sqlite(db));assert.match(store.lexicalBackend,/fts5/);
 }finally{db.close();}
});
test('fresh database creates retrieval schema through normal migration chain',()=>{
 const db=new DatabaseSync(':memory:');try{for(const migration of MIGRATIONS)for(const sql of migration.statements)db.exec(sql);
  assert.equal(db.prepare('SELECT count(*) AS n FROM retrieval_items').get().n,0);new SqliteRetrievalStore(sqlite(db));
 }finally{db.close();}
});
test('lab sources survive clear, recreate idempotently, rebuild, reset, delete; lab visibility is isolated',async()=>{
 const t=setup();try{
  const lab=new SqliteRetrievalLabStore(sqlite(t.db),t.store);lab.create();lab.create();assert.equal(lab.list().length,40);
  await t.indexing.indexMany(lab.list());await t.indexing.drain();
  assert.equal((await t.retrieval.search({text:'Alex',mode:'lexical',access:{grants:[{kind:'global',key:'*'}]}})).results.length,0);
  assert.ok((await t.retrieval.search({text:'Alex',mode:'lexical',access:LAB_ACCESS,filter:LAB_FILTER})).results.length);
  await lab.clearIndex();assert.equal(lab.list().length,40);assert.equal((await t.indexing.getStatistics()).total,0);
  await t.indexing.indexMany(lab.list());assert.equal((await t.indexing.getStatistics()).total,40);
  await lab.delete(testCorpus()[0].id);assert.equal(lab.list().length,39);await lab.reset();assert.equal(lab.list().length,40);assert.equal((await t.indexing.getStatistics()).total,0);
  assert.throws(()=>lab.save({...testCorpus()[0],namespace:'production',scope:{kind:'global',key:'*'}}),{code:'lab_boundary'});
 }finally{t.db.close();}
});
test('semantic labels cover all four language directions, exact and hard-negative; metrics are rank-based',()=>{
 assert.equal(new Set(EVALUATION_CASES.map(c=>c.category)).size,6);const first=EVALUATION_CASES[0];
 const row={...evaluateRanking(first,['retrieval-lab:wrong','retrieval-lab:alex-job'],'vector'),actualMode:'vector' as const};
 const summary=summarizeEvaluation([row]).find(s=>s.mode==='vector');assert.equal(summary.mrr,0.5);assert.equal(summary.top1,0);assert.equal(summary.recall3,1);
 const unavailable=summarizeEvaluation([{...row,error:'embedding_unavailable'}]).find(s=>s.mode==='vector');assert.equal(unavailable.mrr,null);assert.equal(unavailable.unavailable,1);
});
test('synthetic backend benchmark never invokes real embeddings, records sizes/percentiles and cleans projections',async()=>{
 const t=setup();try{
  assert.deepEqual(syntheticVector(4),syntheticVector(4));const report=await runBackendBenchmark(t.store,100,{repetitions:2,memoryBytes:()=>process.memoryUsage().rss});
  assert.equal(report.storage.vectorBytes,100*1024*4);assert.equal(report.backend,'exact_flat');assert.equal(report.metrics.length,3);
  assert.ok(report.metrics.every(m=>m.p95Ms>=m.p50Ms));assert.equal((await t.indexing.getStatistics()).total,0);assert.equal(t.embeddings.documents,0);
 }finally{t.db.close();}
});
test('backend benchmark actually retrieves synthetic vector candidates with a compatible fingerprint',async()=>{
 const t=setup();try{const report=await runBackendBenchmark(t.store,100,{repetitions:1});
  assert.ok(report.metrics.find(m=>m.mode==='vector').candidateCounts.every(n=>n===50));
 }finally{t.db.close();}
});
test('benchmark cleanup never deletes an unrelated projection with a colliding index ID',async()=>{
 const t=setup();try{
  await t.indexing.index({id:'retrieval-benchmark:00000',namespace:'production',type:'document',source:{system:'owner',type:'record',id:'source'},content:'Keep this projection',createdAt:1,updatedAt:2,scope:{kind:'global',key:'*'}});
  await assert.rejects(runBackendBenchmark(t.store,100,{repetitions:1}));assert.ok(await t.indexing.getStatus('retrieval-benchmark:00000'));
 }finally{t.db.close();}
});
