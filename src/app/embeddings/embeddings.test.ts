import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseTemplate } from '@angular/compiler';

// Native layout is device-only. These source contracts complement ngc and pure controller tests.
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const component = source('./embeddings.component.ts');
const template = source('./embeddings.component.html');
const service = source('./embeddings-lab.service.ts');

test('Embeddings Lab is reachable through its route and drawer without diagnostic session registration', () => {
  assert.match(source('../app.routes.ts'), /path: 'embeddings', component: EmbeddingsComponent/);
  const drawer = source('../shell/drawer.component.ts');
  assert.match(drawer, /goEmbeddings\(\): void\s*\{\s*this.go\('\/embeddings', 'embeddings'\)/);
  assert.match(source('../shell/drawer.component.html'), /text="Embeddings Lab"[\s\S]*?\(tap\)="goEmbeddings\(\)"/);
  assert.match(template, /active="embeddings"/);
  assert.doesNotMatch(service, /SessionStore|registerWork|GenerationManager|Activity|inject\(Page\)/);
});

test('template parses all nine sections and accepts unknown events at native boundaries', () => {
  const parsed = parseTemplate(template, 'embeddings.component.html');
  assert.equal(parsed.errors, null);
  for (const title of ['01 / Device', '02 / Installation', '03 / Runtime', '04 / Single Embedding',
    '05 / Similarity', '06 / Cross-Language', '07 / Benchmarks', '08 / Batching Lab', '09 / Export']) {
    assert.ok(template.includes(`text="${title}"`), title);
  }
  assert.match(component, /layout\(event: unknown\)/);
  assert.match(component, /text\(event: unknown\)/);
  assert.match(component, /event as \{ object\?: View \}/);
  assert.match(component, /event as \{ object\?: TextField \}/);
  assert.doesNotMatch(component, /event: EventData/);
});

test('batching uses readable wrapped native metrics, explicit units and safe controls without redesign', () => {
  assert.ok(template.indexOf('08 / Batching Lab') > template.indexOf('07 / Benchmarks'));
  assert.match(template, /text="Run Batch Comparison"[^>]*\[isEnabled\]="lab.ready\(\)"[^>]*\(tap\)="batch\(true\)"/);
  assert.match(template, /lab.ready\(\) && !lab.batchUnsupported\(\)/);
  assert.match(template, /Max \(near 512\)/);
  assert.match(template, /\['benchmark', 'batch-comparison', 'batch-benchmark'/);
  assert.match(template, /lab.batchLiveText\(\)/);
  assert.match(template, /columns="\*, \*, \*"/);
  assert.match(template, /track comparison.timestamp/);
  assert.match(template, /track run.target/);
  assert.match(template, /\[accessibilityLabel\]="metric.name \+ ': ' \+ metric.value" textWrap="true"/);
  assert.doesNotMatch(template, /orientation="horizontal"|embedDocuments is sequential/);
  assert.match(template, /legacy benchmarks explicitly remain sequential/);
  assert.match(component, /this.lab.runBatch\(fullMatrix, message => Dialogs.confirm/);
  assert.match(source('./embeddings.component.css'), /lab-batch-cell \{[^}]*font-size: 14/);
  for (const tag of template.matchAll(/<(Button|TextView)\b[^>]*>/g)) {
    if (/Open menu|Retry native availability/.test(tag[0])) continue;
    assert.match(tag[0], /\[isEnabled\]=/, `Missing busy binding: ${tag[0]}`);
  }
});

test('page mounts poll at 500 ms, unmount only stops polling, and facade attaches to process work', () => {
  assert.match(service, /@Injectable\(\{ providedIn: 'root' \}\)/);
  assert.match(service, /readonly state = signal<LabState>/);
  assert.match(service, /obtainEmbeddingsLabRuntime\(\)/);
  assert.match(service, /runtime.subscribe\(state => this.state.set\(state\)\)/);
  assert.doesNotMatch(service, /new EmbeddingsLabController/);
  assert.match(service, /ngOnDestroy\(\): void \{\s*this.unsubscribe\?\.\(\);\s*this.unsubscribe = null;\s*\}/);
  assert.match(component, /setInterval\(\(\) => this.lab.refresh\(\), 500\)/);
  assert.match(component, /unmounted\(\): void \{\s*if \(this.poll !== null\) clearInterval\(this.poll\);\s*this.poll = null;\s*\}/);
  assert.match(component, /ngOnDestroy\(\): void \{ this.unmounted\(\); \}/);
  assert.match(template, /\(loaded\)="mounted\(\)" \(unloaded\)="unmounted\(\)"/);
  assert.doesNotMatch(component.slice(component.indexOf('mounted():'), component.indexOf('unmounted():')), /benchmark\(|warmUp\(|single\(|load\(/);
});

test('stress is manually confirmed, live telemetry is beside progress, and controls remain adaptive', () => {
  assert.match(component, /async thousand\(\)[\s\S]*?await Dialogs.confirm\([\s\S]*?this.lab.benchmark\(1000, false, true\)/);
  assert.match(template, /Manual \/ 1000 documents\.\.\.[\s\S]*?\(tap\)="thousand\(\)"/);
  assert.match(template, /Manual size checklist: select Short, ~128, ~256, then Near 512/);
  assert.match(template, /lab.state\(\).progress[\s\S]*?lab.activeBenchmark\(\)[\s\S]*?lab.deviceSample\(active.latestDevice\)/);
  assert.match(service, /Token throughput \(total elapsed\):.*run.tokensPerSecond/);
  assert.match(service, /Token throughput \(inference only\):.*run.inferenceTokensPerSecond/);
  assert.match(service, /TTFB:/); assert.doesNotMatch(service, /TTBF:/);
  assert.match(service, /formatTransferRate\(i\['recentBytesPerSecond'\]\)/);
  assert.match(service, /formatSeconds\(i\['elapsedMs'\]\)/);
  assert.match(source('./embeddings.component.css'), /Button \{ min-height: 48;/);
  assert.match(source('./embeddings.component.css'), /flex-wrap: wrap/);
  assert.match(template, /lab-content-wide/);
});
