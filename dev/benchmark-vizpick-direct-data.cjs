// Run probe-vizpick-direct-data.cjs first in the same open tab.
// Market 120 roster observed on the live summary view on 2026-09-11.
// This updates only the temporary Tableau session's Store parameter.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || require('node:path').join(require('node:os').homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const stores=['658','669','756','1089','1215','1458','2988','3660','5151','5173'];
const sheets=['Download Department Breakout (Current Day)','VizPick Donut Health','Department Groups Donuts Health','Download Location Details'];
(async()=>{const b=await chromium.connectOverCDP(process.env.CDP_URL||'http://127.0.0.1:9222');const extra=[];try{
 const p=b.contexts()[0].pages().find(p=>p.url().includes('/views/VizPick/VizPickDetails'));
 if(!p)throw Error('VizPick Details tab missing');
 // Learn the actual parameter identity from a UI operation, rather than hardcoding it.
 const current=await p.getByRole('textbox',{name:'Store',exact:true}).inputValue();
 const seed=current==='1458'?'1':'1458';
 const rp=p.waitForResponse(r=>r.url().includes('/commands/tabdoc/set-parameter-value'),{timeout:25000});
 await p.getByRole('textbox',{name:'Store',exact:true}).fill(seed);await p.getByRole('textbox',{name:'Store',exact:true}).press('Enter');
 const response=await rp;await response.finished();
 const field=(response.request().postData().match(/name="globalFieldName"\r?\n\r?\n([^\r\n]+)/)||[])[1];
 if(!field)throw Error('Could not learn Store parameter identity');
 const laneCount=process.argv.includes('--lanes=3')?3:1;
 const helper=await p.evaluate(()=>window.__vpDirectRequest.toString());
 const start=Date.now(),samples=[];
 const pages=[p];
 for(let i=1;i<laneCount;i++){const page=await b.contexts()[0].newPage();extra.push(page);pages.push(page);}
 await Promise.all(extra.map(async page=>{
   await page.setViewportSize({width:1600,height:1000});
   await page.goto('https://stores.tableau.wal-mart.com/t/OnlineGrocery/views/VizPick/VizPickDetails?:embed=y&:showVizHome=n&:toolbar=top',{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>window.tsConfig?.sessionid&&document.querySelector('textarea[aria-label="Store"],input[aria-label="Store"]'),{},{timeout:60000});
   await page.addScriptTag({content:'window.__vpDirectProbe={results:[]};window.__vpDirectRequest='+helper+';'});
 }));
 const startupMs=Date.now()-start;let next=0;
 await Promise.all(pages.map(async p=>{for(;;){
  const store=stores[next++];if(!store)return;
  const t=Date.now();
  const parameter=await p.evaluate(async({store,field})=>{
   const c=tsConfig,[wb,v]=c.repositoryUrl.split('/');const fd=new FormData();
   for(const[k,v]of Object.entries({globalFieldName:field,valueString:store,useUsLocale:'false'}))fd.append(k,v);
   const start=performance.now();const r=await fetch(location.origin+'/vizql'+c.site_root+'/w/'+wb+'/v/'+v+'/sessions/'+c.sessionid+'/commands/tabdoc/set-parameter-value',{method:'POST',body:fd});const body=await r.text();
   if(!r.ok||/"valid"\s*:\s*false|"errorMessage"/.test(body))throw Error('Store parameter failed for '+store);
   return {ms:Math.round(performance.now()-start),status:r.status};
  },{store,field});
  const pulls=[];
  for(const sheet of sheets){
   // Bounded pacing; no simultaneous mutations of one Tableau session.
   await new Promise(r=>setTimeout(r,750));
   pulls.push(await p.evaluate(sheet=>window.__vpDirectRequest(sheet,'tabdoc/api-get-worksheet-summary-logical-table-data'),sheet));
  }
  const sample={store,elapsedMs:Date.now()-t,parameterMs:parameter.ms,queryMs:pulls.reduce((s,r)=>s+r.ms,0),rows:pulls.map(r=>r.rowCount)};samples.push(sample);console.log(JSON.stringify(sample));
 }}));
 const result={stores:samples.length,lanes:laneCount,totalMs:Date.now()-start,startupMs,newSessionsIncluded:extra.length,primarySessionAlreadyWarm:true,parameterMs:samples.reduce((s,r)=>s+r.parameterMs,0),queryMs:samples.reduce((s,r)=>s+r.queryMs,0),pacingMs:stores.length*sheets.length*750,samples};
 await p.evaluate(result=>{window.__vpBenchmark=result},result);
 console.log(JSON.stringify({benchmark:result}));
 }finally{for(const p of extra)await p.close().catch(()=>{});await b.close()}})().catch(e=>{console.error(e.message);process.exitCode=1});
