/** Host backend-only benchmark. Never loads/downloads an embedding model. */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RETRIEVAL_SCHEMA } from '../src/core/retrieval/schema.ts';
import { SqliteRetrievalStore } from '../src/core/persistence/sqlite-retrieval-store.ts';
import { sqlite,FakeEmbeddings } from '../src/core/retrieval/test-support.ts';
import { runBackendBenchmark } from '../src/core/retrieval/benchmark.ts';
import { LocalIndexingService } from '../src/core/retrieval/indexing.ts';
import { LocalRetrievalService } from '../src/core/retrieval/retrieval.ts';
import { testCorpus,runEvaluation } from '../src/core/retrieval/lab.ts';
const folder=mkdtempSync(join(tmpdir(),'sam-retrieval-bench-'));
const reports=[];
try{
 for(const backend of ['fts5','fts4'] as const){
  const db=new DatabaseSync(join(folder,backend+'.db'));db.exec('PRAGMA foreign_keys=ON');for(const sql of RETRIEVAL_SCHEMA)db.exec(sql);
  const store=new SqliteRetrievalStore(sqlite(db),backend);
  try{
   for(const scale of [100,1000,10000]){
    const report=await runBackendBenchmark(store,scale,{memoryBytes:()=>process.memoryUsage().rss});reports.push(report);
    console.log(backend,scale,report.metrics.map(m=>`${m.mode} p50=${m.p50Ms} p95=${m.p95Ms}`).join('; '));
   }
   // Lexical results are real SQL. No fake semantic scores are reported as model evaluation.
   const embeddings=new FakeEmbeddings();embeddings.loaded=false;
   const indexer=new LocalIndexingService(store,store.lexical,store.vectors,embeddings);
   await indexer.indexMany(testCorpus());const retrieval=new LocalRetrievalService(store,store.lexical,store.vectors,embeddings);
   const evaluation=await runEvaluation(retrieval);reports.push({kind:'host_lexical_evaluation',backend,...evaluation});
  }finally{db.close();}
 }
 const report={platform:process.platform,architecture:process.arch,node:process.version,date:new Date().toISOString(),note:'Host SQLite. Android worker and real-model evaluations require a device.',reports};
 writeFileSync('docs/retrieval/host-results.json',JSON.stringify(report,null,2)+'\n');
}finally{rmSync(folder,{recursive:true,force:true});}
