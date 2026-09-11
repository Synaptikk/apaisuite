const fs=require('fs'),path=require('path'),AdmZip=require('../scripts/node_modules/adm-zip');
const root=path.resolve(__dirname,'..'),out=path.resolve(root,'apaisuite-latest.zip');const zip=new AdmZip();
const skip=new Set(['dev','docs','scripts','node_modules','.git']);
function walk(dir,rel=''){for(const ent of fs.readdirSync(dir,{withFileTypes:true})){if(skip.has(ent.name)||ent.name.endsWith('.zip')||ent.name.endsWith('.kit'))continue;const abs=path.join(dir,ent.name),r=path.join(rel,ent.name);if(ent.isDirectory())walk(abs,r);else zip.addLocalFile(abs,'',r.replaceAll('\\','/'));}}
walk(root);zip.writeZip(out);console.log(out,fs.statSync(out).size);
