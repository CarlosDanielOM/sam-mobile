import { compareId } from '../retrieval/retrieval';
import { allowed, checkAbort, cosine, decodeVector, encodeVector, lexicalExpression, validScope, validateAccess, validateFilter, validateItem, validateVector } from '../retrieval/validation';
import { fingerprintKey, RetrievalError, type Candidate, type EmbeddingFingerprint, type IndexableItem, type IndexFailure, type IndexRecord, type IndexRepository, type IndexStatistics, type LexicalIndex, type RetrievalAccess, type RetrievalFilter, type SearchOptions, type SourceRef, type VectorIndex } from '../retrieval/types';

export type SqlValue = string | number | null | Uint8Array;
export interface RetrievalSqlConnection {
  run(sql: string, args?: SqlValue[]): void;
  all(sql: string, args?: SqlValue[]): Record<string, any>[];
  transaction<T>(work: () => T): T;
}
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
let revisionSequence = 0;
const revision = () => `${Date.now().toString(36)}-${(++revisionSequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
/** This adapter is synchronous internally and MUST live on a worker on Android. */
export class SqliteRetrievalStore implements IndexRepository {
  readonly lexical: LexicalIndex;
  readonly vectors: VectorIndex;
  readonly lexicalBackend: string;
  private db: RetrievalSqlConnection;
  constructor(db: RetrievalSqlConnection, preferred?: 'fts4' | 'fts5') {
    this.db=db;
    const backend = db.all('SELECT lexical, version FROM retrieval_backend WHERE id=1')[0];
    if (backend) {
      if (backend.version !== 1 || !['fts5_unicode61','fts4_unicode61'].includes(backend.lexical)) throw new RetrievalError('unsupported_backend', 'Unsupported lexical projection version.');
      this.lexicalBackend = backend.lexical;
    } else {
      let fts5 = preferred !== 'fts4';
      if (fts5) {
        try { db.run("CREATE VIRTUAL TABLE temp.retrieval_fts_probe USING fts5(content, tokenize='unicode61 remove_diacritics 2')"); db.run('DROP TABLE temp.retrieval_fts_probe'); }
        catch (error) { if (preferred === 'fts5') throw error; fts5 = false; }
      }
      this.lexicalBackend = fts5 ? 'fts5_unicode61' : 'fts4_unicode61';
      db.transaction(() => {
        db.run(fts5 ? "CREATE VIRTUAL TABLE retrieval_fts USING fts5(id UNINDEXED, content, tokenize='unicode61 remove_diacritics 2')"
          : 'CREATE VIRTUAL TABLE retrieval_fts USING fts4(id, content, notindexed=id, tokenize=unicode61 "remove_diacritics=2")');
        db.run('INSERT INTO retrieval_backend(id,lexical,version) VALUES(1,?,1)', [this.lexicalBackend]);
        // Reopening a lost/rebuilt lexical projection is explicit durable work, never model loading.
        db.run("UPDATE retrieval_items SET lexical_state='pending'");
      });
    }
    this.lexical = { backend: this.lexicalBackend, upsert: r => this.lexicalUpsert(r), remove: id => this.lexicalRemove(id), search: (text, o) => this.lexicalSearch(text, o) };
    this.vectors = { backend: 'exact_flat', upsert: (r,v,f) => this.vectorUpsert(r,v,f), remove: id => this.vectorRemove(id), search: (v,f,o) => this.vectorSearch(v,f,o) };
  }
  private read(row: Record<string, any>): IndexRecord {
    return { id: row.id, namespace: row.namespace, type: row.type,
      source: { system: row.source_system, type: row.source_type, id: row.source_id }, content: row.content,
      contentHash: row.content_hash, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, indexedAt: row.indexed_at,
      scope: { kind: row.scope_kind, key: row.scope_key }, metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
      projectionVersion: row.projection_version, schemaVersion: row.schema_version, lexicalState: row.lexical_state,
      vectorState: row.vector_state, embeddingFingerprint: row.fingerprint_json ? JSON.parse(row.fingerprint_json) : null,
      failure: row.failure_json ? JSON.parse(row.failure_json) : null };
  }
  private one(id: string): IndexRecord | null { const row = this.db.all('SELECT * FROM retrieval_items WHERE id=?', [id])[0]; return row ? this.read(row) : null; }
  async get(id: string) { return this.one(id); }
  async stage(item: IndexableItem, hash: string, fingerprint: EmbeddingFingerprint): Promise<IndexRecord> {
    validateItem(item);
    return this.db.transaction(() => {
      const old = this.one(item.id);
      if (old && (old.source.system !== item.source.system || old.source.type !== item.source.type || old.source.id !== item.source.id)) throw new RetrievalError('identity_conflict', 'An index ID cannot be reassigned to another source.');
      if (old && item.updatedAt < old.updatedAt) throw new RetrievalError('older_source_version', 'An older source update cannot replace the current projection.');
      const changed = !old || old.contentHash !== hash || old.content !== item.content || old.projectionVersion !== (item.projectionVersion ?? 1);
      const incompatible = !!old?.embeddingFingerprint && fingerprintKey(old.embeddingFingerprint) !== fingerprintKey(fingerprint);
      const next: IndexRecord = { ...item, projectionVersion: item.projectionVersion ?? 1, contentHash: hash,
        revision: changed ? revision() : old.revision, indexedAt: Date.now(), schemaVersion: 1,
        lexicalState: changed ? 'pending' : old.lexicalState,
        vectorState: changed ? (old?.embeddingFingerprint ? 'stale' : 'pending') : incompatible ? 'stale' : old.vectorState,
        embeddingFingerprint: old?.embeddingFingerprint ?? null, failure: changed ? null : old.failure };
      this.db.run(`INSERT INTO retrieval_items(id,namespace,type,source_system,source_type,source_id,content,content_hash,revision,
        created_at,updated_at,indexed_at,scope_kind,scope_key,metadata_json,projection_version,schema_version,lexical_state,vector_state,fingerprint_json,failure_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        namespace=excluded.namespace,type=excluded.type,content=excluded.content,content_hash=excluded.content_hash,revision=excluded.revision,
        created_at=excluded.created_at,updated_at=excluded.updated_at,indexed_at=excluded.indexed_at,scope_kind=excluded.scope_kind,scope_key=excluded.scope_key,
        metadata_json=excluded.metadata_json,projection_version=excluded.projection_version,schema_version=excluded.schema_version,
        lexical_state=excluded.lexical_state,vector_state=excluded.vector_state,fingerprint_json=excluded.fingerprint_json,failure_json=excluded.failure_json`,
      [next.id,next.namespace,next.type,next.source.system,next.source.type,next.source.id,next.content,next.contentHash,next.revision,
        next.createdAt,next.updatedAt,next.indexedAt,next.scope.kind,next.scope.key,next.metadata ? JSON.stringify(next.metadata) : null,
        next.projectionVersion,next.schemaVersion,next.lexicalState,next.vectorState,next.embeddingFingerprint ? JSON.stringify(next.embeddingFingerprint) : null,
        next.failure ? JSON.stringify(next.failure) : null]);
      return next;
    });
  }
  private where(filter?: RetrievalFilter, access?: RetrievalAccess): { sql: string; args: SqlValue[] } {
    validateFilter(filter); const clauses: string[] = ['1=1'], args: SqlValue[] = [];
    const scopes = (list: readonly { kind: string; key: string }[]) => {
      clauses.push(list.length ? '(' + list.map(() => '(e.scope_kind=? AND e.scope_key=?)').join(' OR ') + ')' : '0=1');
      for (const s of list) args.push(s.kind,s.key);
    };
    if (access) { validateAccess(access); scopes(access.grants); }
    if (filter?.scopes) scopes(filter.scopes);
    if (filter?.namespaces) {
      clauses.push(filter.namespaces.length ? '(' + filter.namespaces.map(n => n.subtree ? '(e.namespace=? OR substr(e.namespace,1,?)=?)' : 'e.namespace=?').join(' OR ') + ')' : '0=1');
      for (const n of filter.namespaces) { args.push(n.value); if (n.subtree) args.push(n.value.length+1,n.value+'.'); }
    }
    if (filter?.types) { clauses.push(filter.types.length ? `e.type IN (${filter.types.map(() => '?').join(',')})` : '0=1'); args.push(...filter.types); }
    for (const key of ['system','type','id'] as const) if (filter?.source?.[key] !== undefined) { clauses.push(`e.source_${key}=?`); args.push(filter.source[key]); }
    for (const [column,range] of [['created_at',filter?.createdAt],['updated_at',filter?.updatedAt]] as const) {
      if (range?.from !== undefined) { clauses.push(`e.${column}>=?`); args.push(range.from); }
      if (range?.to !== undefined) { clauses.push(`e.${column}<=?`); args.push(range.to); }
    }
    return { sql: clauses.join(' AND '), args };
  }
  async getMany(ids: string[], access: RetrievalAccess, filter?: RetrievalFilter) {
    validateAccess(access); const w = this.where(filter,access); if (!ids.length) return [];
    const records: IndexRecord[] = [];
    for (let i=0; i<ids.length; i+=100) {
      const batch=ids.slice(i,i+100);
      for (const row of this.db.all(`SELECT e.* FROM retrieval_items e WHERE ${w.sql} AND e.id IN (${batch.map(()=>'?').join(',')})`,[...w.args,...batch])) {
        try { const record=this.read(row); if (allowed(record,access)) records.push(record); } catch { /* Malformed durable scope/metadata fails closed. */ }
      }
    }
    return records;
  }
  async work(limit: number, filter?: RetrievalFilter) {
    const w=this.where(filter);
    return this.db.all(`SELECT e.* FROM retrieval_items e WHERE ${w.sql} AND (e.lexical_state='pending' OR e.vector_state IN ('pending','stale')) ORDER BY e.indexed_at,e.id LIMIT ?`,[...w.args,limit]).map(row=>this.read(row));
  }
  async fail(record: IndexRecord, failure: IndexFailure) {
    const column=failure.stage==='lexical'?'lexical_state':'vector_state';
    this.db.run(`UPDATE retrieval_items SET ${column}='failed',failure_json=? WHERE id=? AND revision=?`,[JSON.stringify(failure),record.id,record.revision]);
  }
  private deleteOne(id: string) {
    this.db.run('DELETE FROM retrieval_fts WHERE id=?',[id]);
    this.db.run('DELETE FROM retrieval_vectors WHERE id=?',[id]);
    this.db.run('DELETE FROM retrieval_items WHERE id=?',[id]);
  }
  async remove(id: string) { this.db.transaction(()=>this.deleteOne(id)); }
  async removeBySource(source: SourceRef) {
    return this.db.transaction(()=>{
      const rows=this.db.all('SELECT id FROM retrieval_items WHERE source_system=? AND source_type=? AND source_id=?',[source.system,source.type,source.id]);
      for(const row of rows) this.deleteOne(row.id); return rows.length;
    });
  }
  async requeue(fingerprint: EmbeddingFingerprint, options: { ids?: string[]; filter?: RetrievalFilter; staleOnly?: boolean }) {
    const w=this.where(options.filter);
    if (options.ids) { if(options.ids.length>1000) throw new RetrievalError('invalid_limit','Select at most 1000 IDs.'); if (!options.ids.length) return 0; w.sql+=` AND e.id IN (${options.ids.map(()=>'?').join(',')})`;w.args.push(...options.ids); }
    if(options.staleOnly) { w.sql+=" AND (e.vector_state='stale' OR (v.id IS NOT NULL AND (v.fingerprint<>? OR v.revision<>e.revision)))";w.args.push(fingerprintKey(fingerprint)); }
    return this.db.transaction(()=>{
      const rows=this.db.all(`SELECT e.id,e.lexical_state FROM retrieval_items e LEFT JOIN retrieval_vectors v ON v.id=e.id WHERE ${w.sql}` ,w.args);
      for(const row of rows) this.db.run("UPDATE retrieval_items SET vector_state='pending',lexical_state=CASE WHEN lexical_state='failed' THEN 'pending' ELSE lexical_state END,failure_json=NULL,revision=? WHERE id=?",[revision(),row.id]);
      // FTS content is unchanged; ready lexical rows use the new record revision when searching.
      return rows.length;
    });
  }
  async statistics(fingerprint: EmbeddingFingerprint, filter?: RetrievalFilter): Promise<IndexStatistics> {
    const w=this.where(filter), key=fingerprintKey(fingerprint);
    const row=this.db.all(`SELECT COUNT(*) AS total,
      COALESCE(SUM(e.lexical_state='ready'),0) AS lexical,
      COALESCE(SUM(v.id IS NOT NULL),0) AS vectors,
      COALESCE(SUM(v.id IS NOT NULL AND v.fingerprint=? AND v.revision=e.revision AND e.vector_state='ready'),0) AS compatible,
      COALESCE(SUM(e.vector_state='pending' OR e.lexical_state='pending'),0) AS pending,
      COALESCE(SUM(e.vector_state='stale' OR (v.id IS NOT NULL AND (v.fingerprint<>? OR v.revision<>e.revision))),0) AS stale,
      COALESCE(SUM(e.vector_state='failed' OR e.lexical_state='failed'),0) AS failed,
      COALESCE(SUM(length(v.data)),0) AS vectorBytes
      FROM retrieval_items e LEFT JOIN retrieval_vectors v ON v.id=e.id WHERE ${w.sql}`,[key,key,...w.args])[0];
    const pages=Number(this.db.all('PRAGMA page_count')[0].page_count), size=Number(this.db.all('PRAGMA page_size')[0].page_size), free=Number(this.db.all('PRAGMA freelist_count')[0].freelist_count);
    return { ...row, databaseBytes:pages*size, databaseAllocatedBytes:(pages-free)*size,averageVectorBytes:row.vectors?row.vectorBytes/row.vectors:0, lexicalBackend:this.lexicalBackend,vectorBackend:'exact_flat' } as IndexStatistics;
  }
  private async lexicalUpsert(record: IndexRecord): Promise<boolean> {
    return this.db.transaction(()=>{
      const current=this.one(record.id);if(!current || current.revision!==record.revision) return false;
      if(current.lexicalState==='ready') return true;
      this.db.run('DELETE FROM retrieval_fts WHERE id=?',[record.id]);
      this.db.run('INSERT INTO retrieval_fts(id,content) VALUES(?,?)',[record.id,current.content]);
      this.db.run("UPDATE retrieval_items SET lexical_state='ready',failure_json=? WHERE id=?",[current.failure?.stage==='lexical'?null:current.failure?JSON.stringify(current.failure):null,record.id]);
      return true;
    });
  }
  private async lexicalRemove(id: string) { this.db.transaction(()=>{ this.db.run('DELETE FROM retrieval_fts WHERE id=?',[id]);this.db.run("UPDATE retrieval_items SET lexical_state='pending' WHERE id=?",[id]); }); }
  private async vectorRemove(id: string) { this.db.transaction(()=>{ this.db.run('DELETE FROM retrieval_vectors WHERE id=?',[id]);this.db.run("UPDATE retrieval_items SET vector_state='pending',fingerprint_json=NULL WHERE id=?",[id]); }); }
  private async vectorUpsert(record: IndexRecord, vector: readonly number[], f: EmbeddingFingerprint): Promise<boolean> {
    const bytes=encodeVector(vector,f);
    return this.db.transaction(()=>{
      const current=this.one(record.id);if(!current || current.revision!==record.revision) return false;
      this.db.run(`INSERT INTO retrieval_vectors(id,revision,fingerprint,dimensions,data) VALUES(?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,fingerprint=excluded.fingerprint,dimensions=excluded.dimensions,data=excluded.data`,[record.id,record.revision,fingerprintKey(f),f.dimensions,bytes]);
      this.db.run("UPDATE retrieval_items SET vector_state='ready',fingerprint_json=?,failure_json=?,indexed_at=? WHERE id=? AND revision=?",
        [JSON.stringify(f),current.failure?.stage==='vector'?null:current.failure?JSON.stringify(current.failure):null,Date.now(),record.id,record.revision]);
      return true;
    });
  }
  private options(options: SearchOptions) { validateAccess(options.access);checkAbort(options.signal);if(!Number.isSafeInteger(options.limit)||options.limit<1||options.limit>500)throw new RetrievalError('invalid_limit','Candidate limit must be 1–500.');return this.where(options.filter,options.access); }
  private keep(top: Candidate[], candidate: Candidate, limit: number) {
    top.push(candidate);top.sort((a,b)=>b.score-a.score||compareId(a.id,b.id));if(top.length>limit)top.pop();
  }
  private async lexicalSearch(text: string, options: SearchOptions): Promise<Candidate[]> {
    const w=this.options(options), expression=lexicalExpression(text);if(!expression)return [];
    if(this.lexicalBackend==='fts5_unicode61') {
      return this.db.all(`SELECT e.id,e.revision,-bm25(retrieval_fts) AS score FROM retrieval_fts CROSS JOIN retrieval_items e ON e.id=retrieval_fts.id
        WHERE retrieval_fts MATCH ? AND e.lexical_state='ready' AND ${w.sql} ORDER BY score DESC,e.id LIMIT ?`,[expression,...w.args,options.limit])
        .map((row,i)=>({id:row.id,revision:row.revision,score:row.score,rank:i+1,scoreKind:'fts5_negative_bm25'}));
    }
    // Keep the virtual MATCH scan outermost: SQLite otherwise rescans all FTS matches per scoped item.
    // FTS4 has no built-in bm25. Score its real inverted-index matches with explicitly labelled TF-IDF.
    const top:Candidate[]=[];let after=0;
    while(true) {
      checkAbort(options.signal);
      const rows=this.db.all(`SELECT retrieval_fts.docid AS cursor_id,e.id,e.revision,matchinfo(retrieval_fts,'pcxn') AS info FROM retrieval_fts CROSS JOIN retrieval_items e ON e.id=retrieval_fts.id
        WHERE retrieval_fts MATCH ? AND e.lexical_state='ready' AND ${w.sql} AND retrieval_fts.docid>? ORDER BY retrieval_fts.docid LIMIT 128`,[expression,...w.args,after]);
      if(!rows.length)break;
      for(const row of rows) {
        const data:Uint8Array=row.info, view=new DataView(data.buffer,data.byteOffset,data.byteLength);
        const phrases=view.getUint32(0,true),columns=view.getUint32(4,true), n=view.getUint32(8+phrases*columns*12,true);let score=0;
        for(let p=0;p<phrases;p++)for(let c=0;c<columns;c++) {
          const offset=8+(p*columns+c)*12,tf=view.getUint32(offset,true),df=view.getUint32(offset+8,true);
          if(tf)score+=(1+Math.log(tf))*Math.log(1+n/Math.max(1,df));
        }
        this.keep(top,{id:row.id,revision:row.revision,score,rank:0,scoreKind:'fts4_tf_idf'},options.limit);
      }
      after=rows[rows.length-1].cursor_id;await pause();
    }
    return top.map((c,i)=>({...c,rank:i+1}));
  }
  private async vectorSearch(vector: readonly number[], f: EmbeddingFingerprint, options: SearchOptions): Promise<Candidate[]> {
    const w=this.options(options);validateVector(vector,f);const top:Candidate[]=[];let after='';
    // Keyset paging bounds memory. All distance arithmetic runs on the Android retrieval worker.
    while(true) {
      checkAbort(options.signal);
      const rows=this.db.all(`SELECT e.id,e.revision,v.data FROM retrieval_vectors v CROSS JOIN retrieval_items e ON e.id=v.id
        WHERE v.fingerprint=? AND v.dimensions=? AND v.revision=e.revision AND e.vector_state='ready' AND ${w.sql} AND v.id>? ORDER BY v.id LIMIT 64`,[fingerprintKey(f),f.dimensions,...w.args,after]);
      if(!rows.length)break;
      for(const row of rows) {
        checkAbort(options.signal);
        const stored=decodeVector(row.data,f);
        this.keep(top,{id:row.id,revision:row.revision,score:cosine(vector,stored),rank:0,scoreKind:'cosine'},options.limit);
      }
      after=rows[rows.length-1].id;await pause();
    }
    return top.map((c,i)=>({...c,rank:i+1}));
  }
}
