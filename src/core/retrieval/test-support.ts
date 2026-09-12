import { DatabaseSync } from 'node:sqlite';
import type { EmbeddingService, EmbeddingResult } from '../embeddings/types';
import { SqliteRetrievalStore, type RetrievalSqlConnection } from '../persistence/sqlite-retrieval-store';
import { RETRIEVAL_SCHEMA } from './schema';
import { LocalIndexingService } from './indexing';
import { LocalRetrievalService } from './retrieval';
import { embeddingFingerprint, type IndexableItem } from './types';
export function sqlite(db:DatabaseSync):RetrievalSqlConnection {
  return {run:(sql,args=[])=>{db.prepare(sql).run(...args);},all:(sql,args=[])=>db.prepare(sql).all(...args),
    transaction<T>(work:()=>T):T{db.exec('BEGIN');try{const r=work();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
}
export function item(id='a',content='Alex works at Acme.'):IndexableItem {
  return {id,namespace:'test.facts',type:'fact',source:{system:'test',type:'record',id},content,createdAt:1,updatedAt:2,scope:{kind:'global',key:'*'}};
}
export const access={grants:[{kind:'global',key:'*'}]};
export class FakeEmbeddings implements EmbeddingService {
  loaded=true;documents=0;queries=0;batches=0;fail=false;gate?:()=>Promise<void>;
  info={modelId:'test/model',revision:'a',quantization:'none',dimensions:3,maxTokens:512};
  async load(){this.loaded=true;return {loadDurationMs:0,modelInfo:this.info};}async unload(){this.loaded=false;}
  isLoaded(){return this.loaded;}getState(){return this.loaded?'ready' as const:'unloaded' as const;}getModelInfo(){return this.info;}
  async countTokens(){return 1;}
  result(text:string):EmbeddingResult {return {...this.info,vector:text.includes('river')?[0,1,0]:[1,0,0],tokenCount:4,inferenceDurationMs:1,warm:true};}
  async embedDocument(text:string,options:any={}) {this.documents++;await this.gate?.();if(options.signal?.aborted)throw Object.assign(new Error('cancelled'),{code:'cancelled'});if(this.fail)throw new Error('PRIVATE content must not be persisted');return this.result(text);}
  async embedDocuments(texts:string[],options:any={}){this.batches++;return Promise.all(texts.map(t=>this.embedDocument(t,options)));}
  async embedQuery(text:string,options:any={}){this.queries++;if(options.signal?.aborted)throw new Error('cancelled');return this.result(text);}
}
export function setup(backend:'fts4'|'fts5'='fts5',path=':memory:') {
  const db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON');for(const sql of RETRIEVAL_SCHEMA)db.exec(sql);
  const store=new SqliteRetrievalStore(sqlite(db),backend),embeddings=new FakeEmbeddings();
  const indexing=new LocalIndexingService(store,store.lexical,store.vectors,embeddings);
  const retrieval=new LocalRetrievalService(store,store.lexical,store.vectors,embeddings);
  return {db,store,embeddings,indexing,retrieval,f:embeddingFingerprint(embeddings.info)};
}
