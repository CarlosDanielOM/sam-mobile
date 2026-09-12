import { isAndroid } from '@nativescript/core';
import { getEmbeddingsEnvironment } from '../embeddings/android';
import { persistence } from '../persistence/store';
import { SqliteStore } from '../persistence/sqlite-store';
import { LocalIndexingService } from './indexing';
import { LocalRetrievalService } from './retrieval';
import { RetrievalError, type DiagnosticSink, type IndexableItem, type IndexRepository, type LexicalIndex, type VectorIndex } from './types';
import { checkAbort } from './validation';
import type { BackendBenchmarkReport } from './benchmark';

class WorkerClient {
  private worker: Worker;
  private sequence=0;
  private failed=false;
  private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;cleanup:()=>void}>();
  constructor() {
    this.worker=new Worker('./retrieval.worker');
    this.worker.onmessage=(event)=>{
      const {id,result,error}=event.data,p=this.pending.get(id);if(!p)return;
      this.pending.delete(id);p.cleanup();
      if(error)p.reject(new RetrievalError(error.code,'Local retrieval operation failed ('+error.code+').'));else p.resolve(result);
    };
    this.worker.onerror=()=>{
      this.failed=true;
      for(const p of this.pending.values()) {p.cleanup();p.reject(new RetrievalError('worker_failed','Retrieval worker failed. Restart the app to reopen durable pending work.'));}
      this.pending.clear();
    };
  }
  call<T>(method:string,args:any[]=[],signal?:AbortSignal):Promise<T> {
    checkAbort(signal);
    if(this.failed)return Promise.reject(new RetrievalError('worker_failed','Retrieval worker is unavailable. Restart the app.'));
    if(this.pending.size>=128)return Promise.reject(new RetrievalError('queue_full','Retrieval worker admission is full.'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const cancel=()=>this.worker.postMessage({id,method:'cancel'});
      this.pending.set(id,{resolve,reject,cleanup:()=>signal?.removeEventListener('abort',cancel)});
      signal?.addEventListener('abort',cancel,{once:true});
      try {this.worker.postMessage({id,method,args});}catch {this.pending.delete(id);signal?.removeEventListener('abort',cancel);reject(new RetrievalError('worker_failed','Unable to submit retrieval operation.'));}
    });
  }
}
export interface RetrievalRuntime {
  indexing: LocalIndexingService;
  retrieval: LocalRetrievalService;
  repository: IndexRepository;
  environment: ReturnType<typeof getEmbeddingsEnvironment>;
  diagnostics: Parameters<DiagnosticSink>[0][];
  lab: { list():Promise<IndexableItem[]>; create():Promise<IndexableItem[]>; save(item:IndexableItem):Promise<void>; delete(id:string):Promise<void>; reset():Promise<IndexableItem[]>; clearIndex():Promise<number> };
  benchmark(scale:number,signal?:AbortSignal):Promise<BackendBenchmarkReport>;
}
let runtime:Promise<RetrievalRuntime>;
/** One coordinator and one worker per process; opening this runtime does not load or index anything. */
export function obtainRetrievalRuntime():Promise<RetrievalRuntime> {
  if(runtime)return runtime;
  runtime=(async()=>{
    if(!isAndroid)throw new RetrievalError('unsupported_platform','Local retrieval currently requires Android.');
    const sourceStore=persistence();
    if(!(sourceStore instanceof SqliteStore))throw new RetrievalError('storage_unavailable','Android SQLite is required.');
    const path=sourceStore.prepareRetrievalDatabase(),client=new WorkerClient();
    const backends=await client.call<{lexical:string;vector:string}>('initialize',[path]);
    const repository:IndexRepository={
      stage:(...args)=>client.call('stage',args),get:(...args)=>client.call('get',args),getMany:(...args)=>client.call('getMany',args),
      work:(...args)=>client.call('work',args),fail:(...args)=>client.call('fail',args),remove:(...args)=>client.call('remove',args),
      removeBySource:(...args)=>client.call('removeBySource',args),requeue:(...args)=>client.call('requeue',args),statistics:(...args)=>client.call('statistics',args),
    };
    const lexical:LexicalIndex={backend:backends.lexical,upsert:r=>client.call('lexicalUpsert',[r]),remove:id=>client.call('lexicalRemove',[id]),
      search:(text,{signal,...o})=>client.call('lexicalSearch',[text,o],signal)};
    const vector:VectorIndex={backend:backends.vector,upsert:(r,v,f)=>client.call('vectorUpsert',[r,v,f]),remove:id=>client.call('vectorRemove',[id]),
      search:(v,f,{signal,...o})=>client.call('vectorSearch',[v,f,o],signal)};
    const diagnostics:Parameters<DiagnosticSink>[0][]=[],sink:DiagnosticSink=e=>{diagnostics.push(e);if(diagnostics.length>200)diagnostics.shift();};
    const environment=getEmbeddingsEnvironment();
    return {repository,environment,diagnostics,lab:{list:()=>client.call('labList'),create:()=>client.call('labCreate'),save:item=>client.call('labSave',[item]),delete:id=>client.call('labDelete',[id]),reset:()=>client.call('labReset'),clearIndex:()=>client.call('labClearIndex')},indexing:new LocalIndexingService(repository,lexical,vector,environment.service,{},sink),
      retrieval:new LocalRetrievalService(repository,lexical,vector,environment.service,sink),benchmark:(scale,signal)=>client.call('benchmark',[scale],signal)};
  })();
  runtime.catch(()=>{runtime=undefined;});return runtime;
}
