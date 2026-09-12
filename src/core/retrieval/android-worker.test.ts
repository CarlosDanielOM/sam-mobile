import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mock,test } from 'node:test';
import { RETRIEVAL_SCHEMA } from './schema.ts';
import { item,access } from './test-support.ts';
import { contentHash } from './hash.ts';
import { embeddingFingerprint } from './types.ts';
// Exercise actual worker dispatch and native connection binding against a SQLite-backed Android API shim.
mock.module('@nativescript/core/globals/index.js',{namedExports:{}});
mock.module('@nativescript/core/abortcontroller/index.js',{namedExports:{AbortController}});
const db=new DatabaseSync(':memory:');for(const sql of RETRIEVAL_SCHEMA)db.exec(sql);
let transactionSucceeded=false;
(Array as any).create=(_type:string,length:number)=>new Array(length);
const native={
 execSQL(sql:string){db.exec(sql);},
 compileStatement(sql:string){const args:any[]=[];return {
  bindNull:(n:number)=>args[n-1]=null,bindString:(n:number,v:string)=>args[n-1]=v,bindLong:(n:number,v:number)=>args[n-1]=v,bindDouble:(n:number,v:number)=>args[n-1]=v,
  bindBlob:(n:number,v:number[])=>args[n-1]=Uint8Array.from(v.map(x=>x&255)),execute:()=>db.prepare(sql).run(...args),close(){}
 };},
 rawQuery(sql:string,args:string[]){const statement=db.prepare(sql),columns=statement.columns().map(c=>c.name),rows=statement.all(...args);let row=-1;
  const value=(i:number)=>rows[row][columns[i]];
  return {getColumnCount:()=>columns.length,getColumnName:(i:number)=>columns[i],moveToNext:()=>++row<rows.length,
   getType:(i:number)=>value(i)===null?0:typeof value(i)==='number'?Number.isInteger(value(i))?1:2:value(i) instanceof Uint8Array?4:3,
   getLong:value,getDouble:value,getString:value,getBlob:(i:number)=>Array.from(value(i) as Uint8Array,x=>x>127?x-256:x),close(){}};
 },
 beginTransaction(){db.exec('BEGIN');transactionSucceeded=false;},setTransactionSuccessful(){transactionSucceeded=true;},endTransaction(){db.exec(transactionSucceeded?'COMMIT':'ROLLBACK');},close(){db.close();}
};
(globalThis as any).android={database:{sqlite:{SQLiteDatabase:{OPEN_READWRITE:0,openDatabase:()=>native}}}};
let sequence=0;const requests=new Map<number,{resolve:(v:any)=>void;reject:(e:any)=>void}>();
(globalThis as any).self={postMessage(message:any){const p=requests.get(message.id);requests.delete(message.id);message.error?p.reject(message.error):p.resolve(message.result);}};
await import('./retrieval.worker.ts');
function call(method:string,args:any[]=[]){const id=++sequence;const promise=new Promise<any>((resolve,reject)=>{requests.set(id,{resolve,reject});(globalThis as any).self.onmessage({data:{id,method,args}});});return {id,promise};}

test('Android worker initializes actual capability probe, binds binary vectors, retrieves and cancels queued search safely',async()=>{
 const backends=await call('initialize',['sam.db']).promise;assert.equal(backends.lexical,'fts5_unicode61');
 const f=embeddingFingerprint({modelId:'test',revision:'1',quantization:'none',dimensions:3,maxTokens:512});
 const record=await call('stage',[item(),contentHash(item().content),f]).promise;
 await call('lexicalUpsert',[record]).promise;await call('vectorUpsert',[record,[-1,0,0],f]).promise;
 assert.equal(db.prepare('SELECT hex(data) AS bytes FROM retrieval_vectors').get().bytes,'000080BF0000000000000000');
 const result=await call('vectorSearch',[[-1,0,0],f,{access,limit:5}]).promise;assert.equal(result[0].id,'a');assert.equal(result[0].score,1);
 const pending=call('vectorSearch',[[-1,0,0],f,{access,limit:5}]);(globalThis as any).self.onmessage({data:{id:pending.id,method:'cancel'}});
 await assert.rejects(pending.promise,{code:'cancelled'});
 assert.equal((await call('lexicalSearch',['Acme',{access,limit:5}]).promise)[0].id,'a');
 await assert.rejects(call('vectorUpsert',[record,[NaN,0,0],f]).promise,{code:'invalid_vector'});
 assert.equal((await call('get',['a']).promise).vectorState,'ready');await call('remove',['a']).promise;assert.equal(await call('get',['a']).promise,null);
 (globalThis as any).self.onclose();
});
