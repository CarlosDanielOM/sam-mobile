import { ChangeDetectionStrategy, Component, NO_ERRORS_SCHEMA, OnDestroy, inject, signal } from '@angular/core';
import { NativeScriptCommonModule } from '@nativescript/angular';
import { DrawerComponent } from '../shell/drawer.component';
import { DrawerService } from '../shell/drawer.service';
import { SamActionsDirective, SamActionDirective, SamButtonDirective, SamSurfaceDirective, SamTextDirective, SamFieldDirective, SamChoiceComponent, SamThemeScopeDirective } from '../../core/ui';
import { obtainRetrievalRuntime, type RetrievalRuntime } from '../../core/retrieval/android';
import { LAB_ACCESS, LAB_ALL_ACCESS, LAB_FILTER, LAB_NAMESPACE, LAB_SCOPE, LAB_PRIVATE_SCOPE, testCorpus, runEvaluation } from '../../core/retrieval/lab';
import { RetrievalError, type IndexRecord, type IndexStatistics, type IndexableItem, type RetrievalMode, type SearchResponse, type RetrievalFilter } from '../../core/retrieval/types';

@Component({selector:'ns-retrieval',templateUrl:'./retrieval.component.html',
  imports:[NativeScriptCommonModule,DrawerComponent,SamActionsDirective,SamActionDirective,SamButtonDirective,SamSurfaceDirective,SamTextDirective,SamFieldDirective,SamChoiceComponent,SamThemeScopeDirective],
  schemas:[NO_ERRORS_SCHEMA],changeDetection:ChangeDetectionStrategy.OnPush})
export class RetrievalComponent implements OnDestroy {
  readonly drawer=inject(DrawerService);
  readonly busy=signal(false);readonly status=signal('Opening local retrieval storage…');readonly error=signal('');
  readonly stats=signal<IndexStatistics|null>(null);readonly sources=signal<IndexableItem[]>([]);readonly selected=signal<IndexRecord|null>(null);
  readonly response=signal<SearchResponse|null>(null);readonly report=signal('');readonly expanded=signal('');readonly diagnostics=signal(false);
  readonly loaded=signal(false);readonly mode=signal<RetrievalMode>('hybrid');readonly degraded=signal(true);readonly privateAccess=signal(false);
  readonly query=signal('Where does Alex work?');readonly namespace=signal('');readonly subtree=signal(true);readonly type=signal('');
  readonly limit=signal('10');readonly candidates=signal('50');readonly from=signal('');readonly to=signal('');readonly scopeFilter=signal('');
  readonly manualNamespace=signal(LAB_NAMESPACE+'.manual');readonly manualType=signal('document');readonly sourceId=signal('manual-1');
  readonly content=signal('');readonly createdAt=signal('');readonly updatedAt=signal('');readonly metadata=signal('{}');readonly manualPrivate=signal(false);
  readonly batchSize=signal('1');
  private runtime:RetrievalRuntime;
  private abort?:AbortController;
  private destroyed=false;
  constructor(){void this.run('Open lab',async()=>{this.runtime=await obtainRetrievalRuntime();await this.refresh();});}
  text(event:any):string{return String(event.value??event.object?.text??'');}
  json(value:unknown):string{return JSON.stringify(value,null,2);}
  date(value:number):string{return new Date(value).toISOString();}
  private async refresh(){if(this.selected())this.selected.set(await this.runtime.indexing.getStatus(this.selected().id));this.stats.set(await this.runtime.indexing.getStatistics(LAB_FILTER));this.sources.set(await this.runtime.lab.list());this.loaded.set(this.runtime.environment.service.isLoaded());}
  private async run(label:string,action:(signal:AbortSignal)=>Promise<void>){
    if(this.busy())return;this.busy.set(true);this.error.set('');this.status.set(label+'…');this.abort=new AbortController();
    try{await action(this.abort.signal);if(this.runtime)await this.refresh();this.status.set(this.abort.signal.aborted?'Cancelled; committed projections are retained.':label+' finished.');}
    catch(error){this.error.set(error instanceof RetrievalError?error.message:'Operation failed. Inspect lab state and retry.');this.status.set((error as any)?.code??'failed');}
    finally{this.busy.set(false);this.abort=undefined;}
  }
  cancel(){this.abort?.abort();}
  ngOnDestroy(){this.destroyed=true;this.cancel();}
  load(){void this.run('Load installed model',async signal=>{await this.runtime.environment.service.load({signal});});}
  create(){void this.run('Create test corpus',async signal=>{const items=await this.runtime.lab.create();await this.runtime.indexing.indexMany(items,{signal});});}
  reset(){void this.run('Reset test corpus',async signal=>{const items=await this.runtime.lab.reset();await this.runtime.indexing.indexMany(items,{signal});this.response.set(null);this.selected.set(null);});}
  clear(){void this.run('Clear lab index',async()=>{await this.runtime.lab.clearIndex();this.response.set(null);this.selected.set(null);});}
  rebuild(){void this.run('Rebuild lab index',async signal=>{await this.runtime.indexing.indexMany(await this.runtime.lab.list(),{signal});await this.runtime.indexing.reindex({filter:LAB_FILTER});await this.process(signal);});}
  retry(){void this.run('Retry failed and pending',async signal=>{const ids=(await this.runtime.lab.list()).map(i=>i.id),failed:string[]=[];for(const id of ids){const r=await this.runtime.indexing.getStatus(id);if(r?.failure)failed.push(id);}if(failed.length)await this.runtime.indexing.reindex({ids:failed,filter:LAB_FILTER});await this.process(signal);});}
  stale(){void this.run('Reindex stale vectors',async signal=>{await this.runtime.indexing.reindex({filter:LAB_FILTER,staleOnly:true});await this.process(signal);});}
  drain(){void this.run('Process pending vectors',signal=>this.process(signal));}
  private memory(sample:any){return sample?{appPssBytes:sample.appPssBytes,rssBytes:sample.rssBytes,nativeHeapBytes:sample.nativeHeapBytes,javaHeapBytes:sample.javaHeapBytes}:null;}
  private async process(signal:AbortSignal){
    const batch=Number(this.batchSize());if(!Number.isInteger(batch)||batch<1||batch>16)throw new RetrievalError('invalid_batch','Batch size must be 1–16.');
    this.runtime.indexing.policy.batchSize=batch;this.runtime.indexing.policy.batchMode=batch===1?'sequential':'true_batch';
    const before=await this.runtime.environment.sampleDevice().catch(()=>null);
    const result=await this.runtime.indexing.drain({signal,maxItems:1000,filter:LAB_FILTER});
    const after=await this.runtime.environment.sampleDevice().catch(()=>null);
    this.report.set(this.json({kind:'real_indexing',...result,memoryBefore:this.memory(before),memoryAfter:this.memory(after)}));
    if(result.pending)this.status.set('Lexical content persisted; vectors pending until the installed model is loaded.');
  }
  edit(item:IndexableItem){this.sourceId.set(item.source.id);this.manualNamespace.set(item.namespace);this.manualType.set(item.type);this.content.set(item.content);
    this.createdAt.set(String(item.createdAt));this.updatedAt.set(String(item.updatedAt));this.metadata.set(this.json(item.metadata??{}));this.manualPrivate.set(item.scope.key===LAB_PRIVATE_SCOPE.key);
    void this.run('Inspect item',async()=>{this.selected.set(await this.runtime.indexing.getStatus(item.id));});}
  private parseMetadata(){try{return JSON.parse(this.metadata()||'{}');}catch{throw new RetrievalError('invalid_metadata','Metadata must be valid JSON.');}}
  save(){void this.run('Index manual item',async signal=>{
    const sourceId=this.sourceId().trim();const now=Date.now();
    const item:IndexableItem={id:'retrieval-lab:'+sourceId,namespace:this.manualNamespace().trim(),type:this.manualType().trim(),source:{system:'retrieval-lab',type:'fixture',id:sourceId},
      content:this.content(),createdAt:this.createdAt()?Number(this.createdAt()):now,updatedAt:this.updatedAt()?Number(this.updatedAt()):now,
      scope:this.manualPrivate()?LAB_PRIVATE_SCOPE:LAB_SCOPE,metadata:this.parseMetadata(),projectionVersion:1};
    await this.runtime.lab.save(item);const t=Date.now();this.selected.set(await this.runtime.indexing.index(item,{signal}));this.report.set(this.json({admissionMs:Date.now()-t,note:'Embedding is queued; use Process pending vectors.'}));
  });}
  delete(){void this.run('Delete manual source and projection',async()=>{await this.runtime.lab.delete('retrieval-lab:'+this.sourceId().trim());this.selected.set(null);this.response.set(null);});}
  private filter():RetrievalFilter {
    const namespace=this.namespace().trim();if(namespace && namespace!==LAB_NAMESPACE && !namespace.startsWith(LAB_NAMESPACE+'.'))throw new RetrievalError('lab_boundary','Search remains inside lab.retrieval.');
    const from=this.from()?Date.parse(this.from()):undefined,to=this.to()?Date.parse(this.to()):undefined;
    return {namespaces:[{value:namespace||LAB_NAMESPACE,subtree:namespace?this.subtree():true}],types:this.type().trim()?[this.type().trim()]:undefined,
      createdAt:from!==undefined||to!==undefined?{from,to}:undefined,scopes:this.scopeFilter()?[{kind:'lab',key:this.scopeFilter()}]:undefined};
  }
  search(){void this.run('Search',async signal=>{this.response.set(await this.runtime.retrieval.search({text:this.query(),mode:this.mode(),access:this.privateAccess()?LAB_ALL_ACCESS:LAB_ACCESS,
    filter:this.filter(),limit:Number(this.limit()),candidateLimit:Number(this.candidates()),allowDegraded:this.degraded(),signal}));});}
  indexBenchmark(){void this.run('Benchmark real indexing',async signal=>{
    if(!this.runtime.environment.service.isLoaded())throw new RetrievalError('embedding_unavailable','Load the installed model before the indexing benchmark.');
    const fixtureIds=new Set(testCorpus().map(i=>i.id));const items=(await this.runtime.lab.create()).filter(i=>fixtureIds.has(i.id));await this.runtime.lab.clearIndex();
    const diagnosticBaseline=new Set(this.runtime.diagnostics);
    const start=Date.now(),before=await this.runtime.environment.sampleDevice().catch(()=>null);
    await this.runtime.indexing.indexMany(items,{signal});const admissionMs=Date.now()-start;
    const admissionLexicalMs=this.runtime.diagnostics.filter(e=>!diagnosticBaseline.has(e) && e.event==='lexical_ready').reduce((sum,e)=>sum+(e.durationMs??0),0);
    const report=await this.runtime.indexing.drain({signal,maxItems:1000,filter:LAB_FILTER});
    const endToEndMs=Date.now()-start;
    this.report.set(this.json({kind:'real_indexing',items:items.length,admissionMs,admissionLexicalMs,...report,endToEndMs,itemsPerSecond:report.ready*1000/Math.max(1,endToEndMs),memoryBefore:this.memory(before),memoryAfter:this.memory(await this.runtime.environment.sampleDevice().catch(()=>null))}));
  });}
  evaluate(){void this.run('Evaluate English / Spanish and hard negatives',async signal=>{this.report.set(this.json(await runEvaluation(this.runtime.retrieval,signal,(n,total)=>{if(!this.destroyed)this.status.set(`Evaluation ${n}/${total}`);})));});}
  benchmark(scale:number){void this.run(`Benchmark ${scale} synthetic vectors`,async signal=>{this.report.set(this.json(await this.runtime.benchmark(scale,signal)));});}
  showDiagnostics(){this.diagnostics.update(v=>!v);if(this.diagnostics())this.report.set(this.json(this.runtime.diagnostics));}
}
