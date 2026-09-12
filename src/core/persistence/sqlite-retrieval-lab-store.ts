import type { RetrievalSqlConnection, SqliteRetrievalStore } from './sqlite-retrieval-store';
import { LAB_NAMESPACE, LAB_SCOPE, LAB_PRIVATE_SCOPE, testCorpus } from '../retrieval/lab';
import { RetrievalError, type IndexableItem } from '../retrieval/types';
import { validateItem } from '../retrieval/validation';
/** Durable source fixtures belong to the lab. Clearing the index preserves these rows. */
export class SqliteRetrievalLabStore {
  private db:RetrievalSqlConnection; private index:SqliteRetrievalStore;
  constructor(db:RetrievalSqlConnection,index:SqliteRetrievalStore) {this.db=db;this.index=index;}
  save(item:IndexableItem) {
    validateItem(item);
    if(!item.id.startsWith('retrieval-lab:') || !item.namespace.startsWith(LAB_NAMESPACE+'.') || item.source.system!=='retrieval-lab'
      || item.scope.kind!=='lab' || ![LAB_SCOPE.key,LAB_PRIVATE_SCOPE.key].includes(item.scope.key))throw new RetrievalError('lab_boundary','Item must remain in the isolated Retrieval Lab.');
    const old=this.db.all('SELECT item_json FROM retrieval_lab_sources WHERE id=?',[item.id])[0];
    if(old && JSON.parse(old.item_json).updatedAt>item.updatedAt)throw new RetrievalError('older_source_version','An older lab source cannot replace the current record.');
    this.db.run('INSERT INTO retrieval_lab_sources(id,item_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET item_json=excluded.item_json',[item.id,JSON.stringify(item)]);
  }
  list():IndexableItem[] { return this.db.all('SELECT item_json FROM retrieval_lab_sources ORDER BY id').map(r=>JSON.parse(r.item_json)); }
  create() { this.db.transaction(()=>{ for(const item of testCorpus()) if(!this.db.all('SELECT id FROM retrieval_lab_sources WHERE id=?',[item.id]).length)this.save(item); });return this.list(); }
  async delete(id:string) { if(!id.startsWith('retrieval-lab:'))throw new RetrievalError('lab_boundary','Invalid lab item ID.');const projection=await this.index.get(id);if(projection && (projection.source.system!=='retrieval-lab' || !projection.namespace.startsWith(LAB_NAMESPACE+'.') || projection.scope.kind!=='lab' || ![LAB_SCOPE.key,LAB_PRIVATE_SCOPE.key].includes(projection.scope.key)))throw new RetrievalError('lab_boundary','ID belongs to another subsystem.');await this.index.remove(id);this.db.run('DELETE FROM retrieval_lab_sources WHERE id=?',[id]); }
  async clearIndex() {
    const rows=this.db.all("SELECT id FROM retrieval_items WHERE scope_kind='lab' AND scope_key IN (?,?) AND (namespace=? OR substr(namespace,1,?)=?)",[LAB_SCOPE.key,LAB_PRIVATE_SCOPE.key,LAB_NAMESPACE,LAB_NAMESPACE.length+1,LAB_NAMESPACE+'.']);
    for(const row of rows)await this.index.remove(row.id);return rows.length;
  }
  async reset() { await this.clearIndex();this.db.transaction(()=>{this.db.run('DELETE FROM retrieval_lab_sources');for(const item of testCorpus())this.save(item);});return this.list(); }
}
