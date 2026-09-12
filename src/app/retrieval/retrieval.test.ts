import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const read=(path:string)=>readFileSync(new URL(path,import.meta.url),'utf8');
test('Retrieval Lab is a menu destination using shared native UI primitives',()=>{
 assert.match(read('../app.routes.ts'),/path: 'retrieval'/);assert.match(read('../shell/drawer.component.html'),/Retrieval Lab/);
 const template=read('./retrieval.component.html');assert.match(template,/samThemeScope/);assert.match(template,/samActions/);assert.match(template,/Create Test Corpus/);assert.match(template,/Clear Lab Index/);
 assert.match(read('./retrieval.component.ts'),/ChangeDetectionStrategy.OnPush/);
});
test('retrieval integration remains separate from chat/provider/tool execution and external analytics',()=>{
 for(const path of ['../../core/retrieval/android.ts','../../core/retrieval/indexing.ts','../../core/retrieval/retrieval.ts','./retrieval.component.ts']){
  const source=read(path);assert.doesNotMatch(source,/GenerationManager|SessionStore|PolicyEngine|posthog|fetch\(|HttpClient|embedQuery\(['"]query:/);
 }
 assert.match(read('../../core/retrieval/android.ts'),/new Worker\('\.\/retrieval.worker'\)/);
 assert.doesNotMatch(read('../../core/retrieval/retrieval.worker.ts'),/getEmbeddingsEnvironment|Activity|PostHog/);
});
