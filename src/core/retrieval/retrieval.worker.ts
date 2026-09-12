import '@nativescript/core/globals/index.js';
import { AbortController as NativeAbortController } from '@nativescript/core/abortcontroller/index.js';
import { openRetrievalConnection } from '../persistence/android-retrieval-connection';
import { SqliteRetrievalStore } from '../persistence/sqlite-retrieval-store';
import { SqliteRetrievalLabStore } from '../persistence/sqlite-retrieval-lab-store';
import { RetrievalError } from './types';
import { checkAbort } from './validation';
import { runBackendBenchmark } from './benchmark';
declare const self: any;
declare const java: any;
if (typeof globalThis.AbortController === 'undefined') globalThis.AbortController = NativeAbortController as any;
let store: SqliteRetrievalStore;
let lab: SqliteRetrievalLabStore;
let connection: ReturnType<typeof openRetrievalConnection>;
let tail=Promise.resolve();
const operations=new Map<number,AbortController>();
self.onmessage=(event:{data:any})=>{
  const { id,method,args=[] }=event.data;
  if(method==='cancel') { operations.get(id)?.abort();return; }
  if(operations.size>=128) { self.postMessage({id,error:{code:'queue_full'}});return; }
  const controller=new AbortController();operations.set(id,controller);
  tail=tail.then(async()=>{
    try {
      checkAbort(controller.signal);let result:unknown;
      if(method==='initialize') {
        if(!store) { connection=openRetrievalConnection(args[0]);store=new SqliteRetrievalStore(connection);lab=new SqliteRetrievalLabStore(connection,store); }
        result={lexical:store.lexical.backend,vector:store.vectors.backend};
      } else {
        if(!store)throw new RetrievalError('storage_unavailable','Retrieval storage has not initialized.');
        switch(method) {
          case 'labList':result=lab.list();break;
          case 'labCreate':result=lab.create();break;
          case 'labSave':result=lab.save(args[0]);break;
          case 'labDelete':result=await lab.delete(args[0]);break;
          case 'labReset':result=await lab.reset();break;
          case 'labClearIndex':result=await lab.clearIndex();break;
          case 'stage':result=await store.stage(args[0],args[1],args[2]);break;
          case 'get':result=await store.get(args[0]);break;
          case 'getMany':result=await store.getMany(args[0],args[1],args[2]);break;
          case 'work':result=await store.work(args[0],args[1]);break;
          case 'fail':result=await store.fail(args[0],args[1]);break;
          case 'remove':result=await store.remove(args[0]);break;
          case 'removeBySource':result=await store.removeBySource(args[0]);break;
          case 'requeue':result=await store.requeue(args[0],args[1]);break;
          case 'statistics':result=await store.statistics(args[0],args[1]);break;
          case 'lexicalUpsert':result=await store.lexical.upsert(args[0]);break;
          case 'lexicalRemove':result=await store.lexical.remove(args[0]);break;
          case 'lexicalSearch':result=await store.lexical.search(args[0],{...args[1],signal:controller.signal});break;
          case 'vectorUpsert':result=await store.vectors.upsert(args[0],args[1],args[2]);break;
          case 'vectorRemove':result=await store.vectors.remove(args[0]);break;
          case 'vectorSearch':result=await store.vectors.search(args[0],args[1],{...args[2],signal:controller.signal});break;
          case 'benchmark':result=await runBackendBenchmark(store,args[0],{signal:controller.signal,memoryBytes:()=>{const r=java.lang.Runtime.getRuntime();return Number(r.totalMemory())-Number(r.freeMemory());}});break;
          default:throw new RetrievalError('invalid_operation','Unknown retrieval operation.');
        }
      }
      self.postMessage({id,result});
    } catch(error) {
      // Native exceptions/SQL can contain source content. Only public structured codes cross this boundary.
      self.postMessage({id,error:{code:error instanceof RetrievalError?error.code:'storage_failed'}});
    } finally { operations.delete(id); }
  });
};
self.onclose=()=>connection?.close();
