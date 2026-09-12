import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRetrievalStore } from '../persistence/sqlite-retrieval-store.ts';
import { contentHash } from './hash.ts';
import { allowed,cosine,encodeVector,decodeVector,lexicalExpression,validateItem,validateAccess } from './validation.ts';
import { fuse,LocalRetrievalService } from './retrieval.ts';
import { setup,item,access,sqlite } from './test-support.ts';

for(const backend of ['fts5','fts4'] as const) {
 test(`${backend}: Unicode English/Spanish punctuation, phrases, identifiers, injection and empty query`,async()=>{
  const t=setup(backend);try{
   await t.indexing.indexMany([item('a','Lucía vive en Málaga. Factura INV-2026-0042 por 149.95 euros.'),item('b','Alex works at Acme.'),item('c','Acme employs Alexa.')]);
   for(const q of ['Lucía','lucia','Málaga','malaga','"INV-2026-0042"','"149.95"','"vive en"'])assert.equal((await t.store.lexical.search(q,{access,limit:5}))[0]?.id,'a',q);
   assert.equal((await t.store.lexical.search('"works at"',{access,limit:5}))[0]?.id,'b');
   assert.deepEqual(await t.store.lexical.search('!!!',{access,limit:5}),[]);assert.deepEqual(await t.store.lexical.search('',{access,limit:5}),[]);
   await t.store.lexical.search('" OR 1=1; DROP TABLE retrieval_items; --',{access,limit:5});assert.equal((await t.indexing.getStatistics()).total,3);
  }finally{t.db.close();}
 });
 test(`${backend}: access and namespace/type/source/time filters apply before candidate limit`,async()=>{
  const t=setup(backend);try{
   await t.indexing.indexMany([item('a'),{...item('b'),scope:{kind:'session',key:'secret'}},{...item('c'),namespace:'test.facts.child'},
    {...item('d'),namespace:'test.facts2'},{...item('e'),type:'other'},{...item('f'),createdAt:20,updatedAt:21}]);await t.indexing.drain();
   for(const mode of ['lexical','vector','hybrid'] as const){
    const r=await t.retrieval.search({text:'Alex',mode,access,limit:10,filter:{namespaces:[{value:'test.facts',subtree:true}],types:['fact'],createdAt:{from:0,to:10}}});
    assert.deepEqual(r.results.map(x=>x.item.id).sort(),['a','c']);assert.ok(r.results.every(x=>x.item.source.id));
    assert.equal((await t.retrieval.search({text:'Alex',mode,access,filter:{scopes:[{kind:'session',key:'secret'}]},limit:1,candidateLimit:1})).results.length,0);
    assert.equal((await t.retrieval.search({text:'Alex',mode,access:{grants:[{kind:'session',key:'secret'}]},filter:{source:{system:'test',type:'record',id:'b'}},limit:1,candidateLimit:1})).results[0]?.item.id,'b');
   }
   t.db.prepare("UPDATE retrieval_items SET scope_kind='global',scope_key='' WHERE id='a'").run();assert.equal((await t.store.getMany(['a'],access)).length,0);
  }finally{t.db.close();}
 });
}
test('SHA-256 matches known crypto outputs for Unicode, empty text, blocks and surrogate replacement',()=>{
 for(const text of ['', 'abc', 'ñ Lucía 😀', 'a'.repeat(64), 'a'.repeat(1000),'\ud800'])assert.equal(contentHash(text),createHash('sha256').update(text).digest('hex'));
});
test('validation fails closed for malformed items, JSON, access, namespace and scope',()=>{
 assert.throws(()=>validateItem({...item(),namespace:'test%'}));assert.throws(()=>validateItem({...item(),scope:undefined}));
 assert.throws(()=>validateItem({...item(),metadata:{nan:NaN}}));assert.throws(()=>validateItem({...item(),metadata:[] as any}));
 assert.throws(()=>validateAccess({grants:[{kind:'global',key:'arbitrary'}]}));assert.throws(()=>validateAccess(undefined));
 assert.equal(allowed({...item(),scope:{kind:'global',key:''}},access),false);assert.equal(allowed(item(),access),true);
 assert.equal(lexicalExpression('hi; OR "exact phrase" -hello'), '"hi" OR "OR" OR "exact phrase" OR "hello"');
});
test('Float32 little endian roundtrip, dimensions, finite values, normalization, cosine and ordering',async()=>{
 const t=setup();try{
  assert.equal(cosine([1,0],[0,1]),0);assert.equal(cosine([2,0],[3,0]),1);assert.equal(cosine([1,0],[-1,0]),-1);
  assert.throws(()=>cosine([1],[1,2]));assert.throws(()=>cosine([0],[0]));assert.throws(()=>cosine([NaN],[1]));
  assert.deepEqual([...encodeVector([1,0,0],t.f)].slice(0,4),[0,0,128,63]);assert.deepEqual(decodeVector(encodeVector([1,0,0],t.f),t.f),[1,0,0]);
  for(const v of [[1,0],[NaN,0,0],[Infinity,0,0],[0,0,0],[2,0,0]])assert.throws(()=>encodeVector(v,t.f));
  await t.indexing.indexMany([item('z','river'),item('a','Alex'),item('b','Alex')]);await t.indexing.drain();
  const results=await t.store.vectors.search([1,0,0],t.f,{access,limit:5});assert.deepEqual(results.map(r=>r.id),['a','b','z']);assert.equal(results[2].score,0);
  const wrong={...t.f,revision:'different'};assert.deepEqual(await t.store.vectors.search([1,0,0],wrong,{access,limit:5}),[]);
  await assert.rejects(t.store.vectors.search([1,0],t.f,{access,limit:5}),{code:'invalid_vector'});
 }finally{t.db.close();}
});
test('vector and lexical projections survive close/reopen with binary storage',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sam-retrieval-'));let db:DatabaseSync;
 try{const t=setup('fts5',join(dir,'sam.db'));await t.indexing.index(item());await t.indexing.drain();
  assert.equal(t.db.prepare('SELECT typeof(data) AS type,length(data) AS bytes FROM retrieval_vectors').get().type,'blob');t.db.close();
  db=new DatabaseSync(join(dir,'sam.db'));const restored=new SqliteRetrievalStore(sqlite(db));
  assert.equal((await restored.vectors.search([1,0,0],t.f,{access,limit:1}))[0].id,'a');assert.equal((await restored.lexical.search('Acme',{access,limit:1}))[0].id,'a');
 }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});
test('RRF sums ranks rather than incomparable raw scores; duplicates, solo candidates, weights, stable ties',()=>{
 const c=(id:string,rank:number,score=1)=>({id,rank,score,revision:'1',scoreKind:'test'});
 const result=fuse([c('a',1,10000),c('b',2),c('b',2)],[c('b',1,0.99),c('c',2)]);
 assert.deepEqual(result.map(r=>r.id),['b','a','c']);assert.equal(result[0].score,1/62+1/61);
 assert.equal(fuse([c('a',1)],[c('b',1)])[0].id,'a');assert.equal(fuse([c('a',1)],[c('b',1)],{k:60,lexicalWeight:1,vectorWeight:2})[0].id,'b');
 assert.equal(fuse([c('a',1)],[{...c('a',1),revision:'2'}])[0].vector,undefined);
});
test('one query embedding per search, truthful degradation and strict unavailable vector/hybrid',async()=>{
 const t=setup();try{
  await t.indexing.index(item());await t.indexing.drain();const r=await t.retrieval.search({text:'Alex',mode:'hybrid',access});assert.equal(t.embeddings.queries,1);assert.equal(r.results[0].mode,'hybrid');assert.ok(r.results[0].vector);assert.ok(r.results[0].lexical);assert.ok(!('vector' in r.results[0].item));
  t.embeddings.loaded=false;
  const degraded=await t.retrieval.search({text:'Alex',mode:'hybrid',access,allowDegraded:true});assert.equal(degraded.actualMode,'lexical');assert.deepEqual(degraded.degradedReasons,['embedding_unavailable']);
  await assert.rejects(t.retrieval.search({text:'Alex',mode:'vector',access}),{code:'embedding_unavailable'});
  await assert.rejects(t.retrieval.search({text:'Alex',mode:'hybrid',access}),{code:'embedding_unavailable'});
  assert.equal((await t.retrieval.search({text:'Alex',mode:'lexical',access})).results.length,1);
 }finally{t.db.close();}
});
test('lexical failure may degrade hybrid to vector; both modalities failing never succeeds',async()=>{
 const t=setup();try{
  await t.indexing.index(item());await t.indexing.drain();const retrieval=new LocalRetrievalService(t.store,{...t.store.lexical,search:async()=>{throw new Error('bad');}},t.store.vectors,t.embeddings);
  assert.equal((await retrieval.search({text:'Alex',mode:'hybrid',access,allowDegraded:true})).actualMode,'vector');t.embeddings.loaded=false;
  await assert.rejects(retrieval.search({text:'Alex',mode:'hybrid',access,allowDegraded:true}));
 }finally{t.db.close();}
});
test('cancellation stops exact scan cooperatively and later queries still work',async()=>{
 const t=setup();try{
  await t.indexing.indexMany(Array.from({length:150},(_,i)=>item(String(i))));await t.indexing.drain({maxItems:200});const c=new AbortController();
  const search=t.store.vectors.search([1,0,0],t.f,{access,limit:5,signal:c.signal});c.abort();await assert.rejects(search,{code:'cancelled'});
  assert.equal((await t.store.vectors.search([1,0,0],t.f,{access,limit:5})).length,5);
 }finally{t.db.close();}
});
test('final access/revision guard discards candidates after concurrent source or scope changes',async()=>{
 const t=setup();try{
  await t.indexing.index(item());await t.indexing.drain();
  const vectors={...t.store.vectors,search:async(...args:any[])=>{const candidates=await (t.store.vectors.search as any)(...args);await t.indexing.index({...item(),scope:{kind:'private',key:'owner'}});return candidates;}};
  const retrieval=new LocalRetrievalService(t.store,t.store.lexical,vectors,t.embeddings);
  assert.equal((await retrieval.search({text:'Alex',mode:'hybrid',access})).results.length,0);
 }finally{t.db.close();}
});
