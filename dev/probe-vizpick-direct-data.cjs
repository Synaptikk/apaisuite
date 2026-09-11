// Read-only live probe. Attach to an already authenticated debug browser.
// No cookies, session ids, or associate rows are written to disk or console.
// PLAYWRIGHT_MODULE may point to a local playwright installation.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || require('node:path').join(require('node:os').homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const sheets = ['Download Department Breakout (Current Day)', 'VizPick Donut Health', 'Department Groups Donuts Health', 'Download Location Details', 'Last update'];
(async () => {
  const browser = await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:9222');
  try {
    const page = browser.contexts()[0].pages().find(p => p.url().includes('/views/VizPick/VizPickDetails'));
    if (!page) throw Error('Open VizPickDetails in the debug browser first');
    await page.evaluate(() => {
      window.__vpDirectProbe = {results: []};
      window.__vpDirectRequest = async (sheet, command, extra = {}) => {
        const c = window.tsConfig, [wb, view] = c.repositoryUrl.split('/');
        const base = location.origin + '/vizql' + c.site_root + '/w/' + wb + '/v/' + view + '/sessions/' + c.sessionid;
        const form = new FormData();
        const args = command.includes('summary-logical') ? {
          visualIdPresModel: JSON.stringify({worksheet: sheet, dashboard: 'VizPick Details'}),
          versionName: '1.0', maxRows: '0', ignoreAliases: 'false', ignoreSelection: 'true',
        } : extra;
        for (const [key, value] of Object.entries(args)) form.append(key, value);
        const start = performance.now();
        const response = await fetch(base + '/commands/' + command, {method: 'POST', body: form});
        const body = await response.text();
        const json = JSON.parse(body);
        const ret = json.vqlCmdResponse?.cmdResultList?.[0]?.commandReturn;
        if (command.includes('summary-logical')) {
          const model = ret?.dataTablePresModel;
          if (!model) throw Error('Summary failed: ' + body.slice(0,250));
          const raw = JSON.parse(model.showDataTable).table;
          const formatted = JSON.parse(model.showDataFormattedTable).table;
          const columns = raw.schema.map(name => model.showDataTableColumnPresModels.find(c => c.uniqueName === name)?.fieldCaption || name);
          const result = {sheet, status: response.status, ms: Math.round(performance.now()-start), bytes:body.length, columns, rowCount:raw.tuples.length, topN:model.topN, raw, formatted};
          window.__vpDirectProbe.results.push(result);
          return {sheet, status:result.status, ms:result.ms, bytes:result.bytes, rowCount:result.rowCount, topN:result.topN, columns};
        }
        const key = ret?.resultKey || (body.match(/"resultKey"\s*:\s*"?(\d+)/)||[])[1];
        if (!key) throw Error('Export failed: '+body.slice(0,250));
        const file = await fetch(base.replace('/sessions/','/tempfile/sessions/')+'?key='+key+'&keepfile=yes&attachment=yes');
        const bytes = new Uint8Array(await file.arrayBuffer());
        const text = new TextDecoder(bytes[0]===255&&bytes[1]===254?'utf-16le':'utf-8').decode(bytes);
        window.__vpDirectProbe.exports = window.__vpDirectProbe.exports || [];
        window.__vpDirectProbe.exports.push({sheet,text});
        const lines = text.trim().split(/\r?\n/);
        return {sheet,status:file.status,ms:Math.round(performance.now()-start),bytes:bytes.length,rowCount:lines.length-1,header:lines[0]};
      };
    });
    for (const sheet of sheets) {
      console.log(JSON.stringify(await page.evaluate(sheet => window.__vpDirectRequest(sheet,'tabdoc/api-get-worksheet-summary-logical-table-data'), sheet)));
      await new Promise(r=>setTimeout(r,750));
    }
    // Discover GUIDs from Tableau's own dialog, rather than assuming a publish/layout.
    const responsePromise = page.waitForResponse(r=>r.url().includes('/export-crosstab-server-dialog'),{timeout:15000});
    await page.getByRole('button',{name:'Download',exact:true}).click();
    await page.getByRole('menuitem',{name:'Crosstab',exact:true}).click();
    const dialogText = await (await responsePromise).text();
    const discovered = [...dialogText.matchAll(/"sheetName"\s*:\s*"([^"]+)"\s*,\s*"sheetdocId"\s*:\s*"(\{[^}]+\})"/g)].map(m=>({name:m[1],id:m[2]}));
    await page.getByRole('button',{name:'Close dialog',exact:true}).click();
    console.log(JSON.stringify({discoveredSheets:discovered.map(s=>s.name)}));
    for (const sheet of sheets) {
      const found = discovered.find(s=>s.name===sheet);
      if(!found){console.log(JSON.stringify({sheet,error:'not listed in dialog'}));continue;}
      await new Promise(r=>setTimeout(r,750));
      console.log(JSON.stringify({export:await page.evaluate(({sheet,id})=>window.__vpDirectRequest(sheet,'tabsrv/export-crosstab-to-csvserver',{sheetdocId:id,sendNotifications:'true',telemetryCommandId:'probe'+Date.now()}),{sheet,id:found.id})}));
    }
  } finally { await browser.close(); }
})().catch(e=>{console.error(e.message);process.exitCode=1});
