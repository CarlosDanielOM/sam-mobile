import type { RetrievalSqlConnection, SqlValue } from './sqlite-retrieval-store';
declare const android: any;
declare const java: any;
/** Worker-owned connection to the existing migrated sam.db. No schema runner here. */
export function openRetrievalConnection(path: string): RetrievalSqlConnection & { close(): void } {
  const db = android.database.sqlite.SQLiteDatabase.openDatabase(path, null, android.database.sqlite.SQLiteDatabase.OPEN_READWRITE);
  db.execSQL('PRAGMA foreign_keys=ON');
  const bind = (value: SqlValue): any => {
    if (!(value instanceof Uint8Array)) return value;
    const bytes = (Array as any).create('byte',value.length);
    for(let i=0;i<value.length;i++)bytes[i]=value[i]>127?value[i]-256:value[i];
    return bytes;
  };
  return {
    run(sql,args=[]) {
      const statement=db.compileStatement(sql);
      try {
        args.forEach((v,i)=>{ const n=i+1;if(v===null)statement.bindNull(n);else if(v instanceof Uint8Array)statement.bindBlob(n,bind(v));else if(typeof v==='number') { if(Number.isInteger(v))statement.bindLong(n,v);else statement.bindDouble(n,v); }else statement.bindString(n,v); });
        statement.execute();
      } finally { statement.close(); }
    },
    all(sql,args=[]) {
      const strings=(Array as any).create('java.lang.String',args.length);args.forEach((v,i)=>strings[i]=String(v));
      const cursor=db.rawQuery(sql,strings), rows:Record<string,any>[]=[];
      try {
        const columns=Number(cursor.getColumnCount());
        while(cursor.moveToNext()) {
          const row:Record<string,any>={};
          for(let i=0;i<columns;i++) {
            const key=String(cursor.getColumnName(i)),type=cursor.getType(i);
            if(type===0)row[key]=null;else if(type===1)row[key]=Number(cursor.getLong(i));else if(type===2)row[key]=Number(cursor.getDouble(i));
            else if(type===4) { const blob=cursor.getBlob(i), bytes=new Uint8Array(blob.length);for(let j=0;j<bytes.length;j++)bytes[j]=blob[j]&255;row[key]=bytes; }
            else row[key]=String(cursor.getString(i));
          }
          rows.push(row);
        }
      } finally { cursor.close(); }
      return rows;
    },
    transaction<T>(work:()=>T):T { db.beginTransaction();try { const result=work();db.setTransactionSuccessful();return result; }finally{db.endTransaction();} },
    close:()=>db.close(),
  };
}
