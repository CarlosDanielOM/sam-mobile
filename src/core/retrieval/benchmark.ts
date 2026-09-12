import { LocalRetrievalService } from './retrieval';
import { contentHash } from './hash';
import { checkAbort } from './validation';
import { RetrievalError, embeddingFingerprint, type IndexRepository, type LexicalIndex, type VectorIndex, type IndexStatistics, type RetrievalMode } from './types';
import type { EmbeddingService } from '../embeddings/types';

export interface BackendBenchmarkReport {
  kind:'synthetic_backend';scale:number;dimensions:number;repetitions:number;setupMs:number;
  backend:string;lexicalBackend:string;metrics:{mode:RetrievalMode;p50Ms:number;p95Ms:number;candidateCounts:number[]}[];
  storage:IndexStatistics;databaseGrowthBytes:number;memoryBeforeBytes:number|null;memoryAfterBytes:number|null;
  notes:string[];
}
export function syntheticVector(seed:number,dimensions=1024):number[] {
  let state=(seed+1)>>>0;
  const values=Array.from({length:dimensions},()=>{state=(Math.imul(1664525,state)+1013904223)>>>0;return state/4294967296-0.5;});
  const norm=Math.sqrt(values.reduce((s,v)=>s+v*v,0));return values.map(v=>v/norm);
}
export function percentile(values:number[],p:number):number { const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(p*sorted.length)-1)]??0; }
export async function runBackendBenchmark(store:IndexRepository & {lexical:LexicalIndex;vectors:VectorIndex},scale:number,
  options:{signal?:AbortSignal;memoryBytes?:()=>number;repetitions?:number}={}):Promise<BackendBenchmarkReport> {
  if(![100,1000,10000].includes(scale))throw new Error('Benchmark scale must be 100, 1000 or 10000.');
  const signal=options.signal,repetitions=options.repetitions??7;
  const model={modelId:'sam/retrieval-synthetic',revision:'lcg_v1',quantization:'none',dimensions:1024,maxTokens:512,backendRevision:'synthetic_v1'};
  const f=embeddingFingerprint(model),namespace='lab.retrieval.benchmark',scope={kind:'lab',key:'retrieval.benchmark'},access={grants:[scope]},filter={namespaces:[{value:namespace}]};
  const before=await store.statistics(f),memoryBeforeBytes=options.memoryBytes?.()??null,begin=Date.now();
  const owns=(record:any)=>record && record.namespace===namespace && record.scope.kind===scope.kind && record.scope.key===scope.key && record.source.system==='retrieval-lab-benchmark';
  const ids=Array.from({length:scale},(_,i)=>`retrieval-benchmark:${String(i).padStart(5,'0')}`);
  try {
    for(let i=0;i<scale;i++) {
      checkAbort(signal);
      const existing=await store.get(ids[i]);if(existing && !owns(existing))throw new RetrievalError('lab_boundary','Benchmark ID collides with another subsystem.');
      const content=`Synthetic retrieval benchmark item ${i} category ${i%20} identifier BENCH-${i}.`;
      const record=await store.stage({id:ids[i],namespace,type:'benchmark',source:{system:'retrieval-lab-benchmark',type:'synthetic',id:String(i)},content,
        createdAt:1,updatedAt:1,scope},contentHash(content),f);
      await store.lexical.upsert(record);await store.vectors.upsert(record,syntheticVector(i),f);
      if(i%32===0)await new Promise<void>(resolve=>setTimeout(resolve,0));
    }
    const setupMs=Date.now()-begin;
    let queryVector=syntheticVector(0);
    const embeddings={isLoaded:()=>true,getModelInfo:()=>model,embedQuery:async()=>({vector:queryVector,...model,tokenCount:0,inferenceDurationMs:0,warm:true})} as unknown as EmbeddingService;
    const retrieval=new LocalRetrievalService(store,store.lexical,store.vectors,embeddings);
    const metrics:BackendBenchmarkReport['metrics']=[];
    for(const mode of ['lexical','vector','hybrid'] as const) {
      const times:number[]=[],counts:number[]=[];
      // One warm-up per modality is excluded from percentiles.
      for(let run=-1;run<repetitions;run++) {
        checkAbort(signal);const n=((run+2)*97)%scale;queryVector=syntheticVector(n);
        const response=await retrieval.search({text:`"BENCH-${n}" category ${n%20}`,mode,access,filter,limit:10,candidateLimit:50,signal});
        if(run>=0){times.push(response.durationMs);counts.push(response.candidates.merged);}
      }
      metrics.push({mode,p50Ms:percentile(times,0.5),p95Ms:percentile(times,0.95),candidateCounts:counts});
    }
    const storage=await store.statistics(f,filter);
    return {kind:'synthetic_backend',scale,dimensions:1024,repetitions,setupMs,backend:store.vectors.backend,lexicalBackend:store.lexical.backend,
      metrics,storage,databaseGrowthBytes:storage.databaseBytes-before.databaseBytes,memoryBeforeBytes,memoryAfterBytes:options.memoryBytes?.()??null,
      notes:['No model inference: deterministic normalized vectors. Exact scan, not ANN.',
        'Database bytes cover the shared database; growth includes projection overhead. Freed pages may be reused.',
        'Temporary benchmark rows are removed after measurement; no VACUUM or source-data deletion.',
        'Compare Android worker results with host results separately; native BLOB bridge overhead is platform-dependent.']};
  } finally {
    // Cleanup only our reserved synthetic IDs, including interrupted prior runs at this scale.
    for(const id of ids)if(owns(await store.get(id)))await store.remove(id);
  }
}
