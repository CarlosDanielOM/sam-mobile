import { checkAbort } from './validation';
import { type IndexableItem, type RetrievalAccess, type RetrievalMode, type RetrievalService, type SearchResponse } from './types';
export const LAB_NAMESPACE='lab.retrieval';
export const LAB_SCOPE={kind:'lab',key:'retrieval'};
export const LAB_PRIVATE_SCOPE={kind:'lab',key:'retrieval.private'};
export const LAB_ACCESS:RetrievalAccess={grants:[LAB_SCOPE]};
/** Only the developer lab owns these fixture grants; a query filter never grants access. */
export const LAB_ALL_ACCESS:RetrievalAccess={grants:[LAB_SCOPE,LAB_PRIVATE_SCOPE]};
export const LAB_FILTER={namespaces:[{value:LAB_NAMESPACE,subtree:true}]};
const at=Date.UTC(2026,0,15,12);
const rows:[string,string,string,string][]=[
 ['alex-job','facts','person.fact','Alex is employed by Acme as a software engineer.'],
 ['alex-visit','events','event.visit','Alex visited the Acme store to buy headphones. Alex does not work there.'],
 ['alexa-job','facts','person.fact','Alexa works at Northstar Hospital as a nurse.'],
 ['alejandro-job','facts','person.fact','Alejandro trabaja como arquitecto en Estudio Sol.'],
 ['lucia-home','facts','person.fact','Lucía vive en Valencia, cerca del Jardín del Turia.'],
 ['lucia-trip','events','event.travel','Lucía visitó Madrid durante sus vacaciones; regresó a su casa en Valencia.'],
 ['ben-home','facts','person.fact','Ben lives in Seattle near Lake Union.'],
 ['ben-trip','events','event.travel','Ben visited Boston for a conference and then returned home.'],
 ['ana-allergy','facts','person.fact','Ana es alérgica a los cacahuetes y evita comer maní.'],
 ['ana-food','facts','person.fact','A Ana le gustan las manzanas y la sopa de verduras.'],
 ['omar-bike','facts','person.fact','Omar commutes to his office by bicycle every morning.'],
 ['omar-car','events','event.visit','Omar rented a car once during a holiday in Portugal.'],
 ['invoice-42','finance','finance.invoice','Invoice INV-2026-0042 totals USD 149.95 and is due on 2026-03-18.'],
 ['invoice-43','finance','finance.invoice','Invoice INV-2026-0043 totals USD 1499.50 and is due on 2026-03-19.'],
 ['invoice-es','finance','finance.invoice','La factura FAC-7781 tiene un importe de 82,40 euros y vence el 12 de abril de 2026.'],
 ['device-a56','documents','document','Device SM-A566B is a Samsung Galaxy A56; asset tag SAM-DEVICE-017.'],
 ['device-s24','documents','document','Device SM-S921B is a Samsung Galaxy S24; asset tag SAM-DEVICE-071.'],
 ['meeting','events','event.calendar','The telescope club meeting starts at 19:30 on 2026-04-09 in Room C12.'],
 ['dentist','events','event.calendar','La cita con el dentista es el 21 de mayo de 2026 a las 10:00.'],
 ['bank-river','documents','document','The river bank is covered in reeds where herons nest.'],
 ['bank-money','documents','document','The bank processes savings deposits and mortgage payments.'],
 ['jaguar-animal','documents','document','The jaguar is a large spotted feline living in tropical forests.'],
 ['jaguar-car','documents','document','The Jaguar automobile needs an oil change and new tires.'],
 ['python-code','documents','document','Python functions use def and indentation to organize program code.'],
 ['python-snake','documents','document','A python is a nonvenomous snake that constricts its prey.'],
 ['password-reset','documents','document','To recover account access, choose Forgot password and follow the reset link in your email.'],
 ['password-negative','documents','document','Password strength is measured by resistance to guessing; never reuse weak passwords.'],
 ['library-hours','documents','document','La biblioteca municipal abre de lunes a viernes de 09:00 a 18:00.'],
 ['library-code','documents','document','A software library provides reusable functions to other programs.'],
 ['train','documents','document','El tren a Barcelona sale del andén siete a las ocho y media de la mañana.'],
 ['train-negative','documents','document','Train a neural network by optimizing weights on examples.'],
 ['refund','documents','document','Refund requests must include a receipt and arrive within thirty days of purchase.'],
 ['refund-es','documents','document','Los reembolsos se abonan al método de pago original en cinco días laborables.'],
 ['space','documents','document','Neptune is a distant planet with strong winds and a deep blue atmosphere.'],
 ['bread','documents','document','Sourdough bread rises through fermentation by yeast and lactic acid bacteria.'],
 ['music','documents','document','El violonchelo produce tonos graves y se toca con un arco.'],
 ['garden','documents','document','Tomato seedlings need sunlight, consistent watering, and well-drained soil.'],
 ['maria','facts','person.fact','María García owns a yellow kayak named Aurora.'],
 ['mario','facts','person.fact','Mario García owns a red canoe named Borealis.'],
 ['private','facts','person.fact','The lab-only private locker code is LAB-PRIVATE-932.'],
];
export function testCorpus():IndexableItem[] {
  return rows.map(([id,namespace,type,content],i)=>({id:`retrieval-lab:${id}`,namespace:`${LAB_NAMESPACE}.${namespace}`,type,
    source:{system:'retrieval-lab',type:'fixture',id},content,createdAt:at+i*86400000,updatedAt:at+i*86400000,
    scope:id==='private'?LAB_PRIVATE_SCOPE:LAB_SCOPE,metadata:{fixture:true,corpusVersion:1},projectionVersion:1}));
}
export interface EvaluationCase {id:string;text:string;category:'en-en'|'es-es'|'en-es'|'es-en'|'hard-negative'|'exact';relevant:string[]}
export const EVALUATION_CASES:EvaluationCase[]=[
 {id:'employment',text:'Where does Alex work?',category:'hard-negative',relevant:['alex-job']},
 {id:'residence',text:'¿En qué ciudad vive Lucía?',category:'es-es',relevant:['lucia-home','lucia-trip']},
 {id:'cross-home',text:'What city does Lucia live in?',category:'en-es',relevant:['lucia-home','lucia-trip']},
 {id:'cross-ben',text:'¿Dónde vive Ben?',category:'es-en',relevant:['ben-home']},
 {id:'allergy',text:'Which food is Ana allergic to?',category:'en-es',relevant:['ana-allergy']},
 {id:'commute',text:'How does Omar travel to work?',category:'en-en',relevant:['omar-bike']},
 {id:'commute-es',text:'¿Cómo llega Omar a su oficina cada mañana?',category:'es-en',relevant:['omar-bike']},
 {id:'account',text:'I cannot log in because I forgot my password. How can I regain access?',category:'en-en',relevant:['password-reset']},
 {id:'library',text:'¿A qué hora abre la biblioteca municipal?',category:'es-es',relevant:['library-hours']},
 {id:'river',text:'Where do herons nest on the river bank?',category:'hard-negative',relevant:['bank-river']},
 {id:'invoice',text:'"INV-2026-0042"',category:'exact',relevant:['invoice-42']},
 {id:'device',text:'"SM-A566B"',category:'exact',relevant:['device-a56']},
 {id:'amount',text:'"149.95"',category:'exact',relevant:['invoice-42']},
 {id:'date',text:'"2026-04-09"',category:'exact',relevant:['meeting']},
 {id:'names',text:'Who owns the yellow kayak Aurora?',category:'hard-negative',relevant:['maria']},
];
export interface EvaluationRow {id:string;category:string;mode:RetrievalMode;actualMode?:RetrievalMode;ids:string[];firstRelevantRank:number|null;recall3:number;recall5:number;error?:string}
export function evaluateRanking(test:EvaluationCase,ids:string[],mode:RetrievalMode):EvaluationRow {
  const relevant=new Set(test.relevant.map(id=>'retrieval-lab:'+id));
  const first=ids.findIndex(id=>relevant.has(id));
  const recall=(k:number)=>new Set(ids.slice(0,k).filter(id=>relevant.has(id))).size/relevant.size;
  return {id:test.id,category:test.category,mode,ids,firstRelevantRank:first<0?null:first+1,recall3:recall(3),recall5:recall(5)};
}
export function summarizeEvaluation(rows:EvaluationRow[]) {
  return (['lexical','vector','hybrid'] as const).map(mode=>{
    const all=rows.filter(r=>r.mode===mode),valid=all.filter(r=>!r.error && r.actualMode===mode),n=valid.length;
    return {mode,queries:n,unavailable:all.length-n,top1:n?valid.filter(r=>r.firstRelevantRank===1).length/n:null,
      recall3:n?valid.reduce((s,r)=>s+r.recall3,0)/n:null,recall5:n?valid.reduce((s,r)=>s+r.recall5,0)/n:null,
      mrr:n?valid.reduce((s,r)=>s+(r.firstRelevantRank?1/r.firstRelevantRank:0),0)/n:null};
  });
}
export async function runEvaluation(retrieval:RetrievalService,signal?:AbortSignal,onProgress?:(done:number,total:number)=>void) {
  const rows:EvaluationRow[]=[];
  for(const mode of ['lexical','vector','hybrid'] as const)for(const test of EVALUATION_CASES) {
    checkAbort(signal);
    try {
      const response:SearchResponse=await retrieval.search({text:test.text,mode,access:LAB_ACCESS,filter:LAB_FILTER,limit:5,candidateLimit:50,allowDegraded:false,signal});
      rows.push({...evaluateRanking(test,response.results.map(r=>r.item.id),mode),actualMode:response.actualMode});
    }catch(error) { checkAbort(signal);rows.push({...evaluateRanking(test,[],mode),error:(error as any).code??'search_failed'}); }
    onProgress?.(rows.length,EVALUATION_CASES.length*3);
  }
  return {corpusVersion:1,summary:summarizeEvaluation(rows),rows};
}
