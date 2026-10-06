import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT=process.cwd();
const WORKFLOWS=path.join(ROOT,'.github','workflows');

export function topLevelOnBlock(text) {
  const lines=String(text).split(/\r?\n/);
  const start=lines.findIndex(line=>/^on:\s*(?:#.*)?$/.test(line));
  if(start<0) {
    const inline=lines.find(line=>/^on:\s*\[/.test(line));
    return inline||'';
  }
  const out=[lines[start]];
  for(let i=start+1;i<lines.length;i++){
    const line=lines[i];
    if(/^\S/.test(line) && line.trim()!=='' && !line.trim().startsWith('#')) break;
    out.push(line);
  }
  return out.join('\n');
}

export function triggersFromWorkflow(text) {
  const block=topLevelOnBlock(text);
  const found=new Set();
  for(const name of ['workflow_dispatch','push','pull_request','schedule','workflow_call']){
    const re=new RegExp('(?:^|[\\s\\[,])'+name.replace('_','_')+'\\s*(?=[:,\\]])','m');
    if(re.test(block)) found.add(name);
  }
  return [...found];
}

export function isGate4ScientificWorkflow(name,text) {
  const hay=(name+'\n'+text).toLowerCase();
  return (
    /audio-gate4-.*\.(ya?ml)$/.test(name.toLowerCase()) ||
    hay.includes('gate4_scientific_run') ||
    hay.includes('audio-gate4-whisperx-pilot.py') ||
    (hay.includes('gate 4') && hay.includes('whisperx')) ||
    hay.includes('gate 4 approved recovery run')
  );
}

export function auditWorkflow(name,text) {
  const triggers=triggersFromWorkflow(text);
  const scientific=isGate4ScientificWorkflow(name,text);
  const errors=[];
  if(scientific){
    if(!triggers.includes('workflow_dispatch')) errors.push('Gate 4 scientific workflow must include workflow_dispatch');
    for(const forbidden of ['push','pull_request','schedule']){
      if(triggers.includes(forbidden)) errors.push(`Gate 4 scientific workflow must not use ${forbidden}`);
    }
  }
  return {name,scientific,triggers,errors};
}

export async function auditDirectory(dir=WORKFLOWS){
  const names=(await readdir(dir)).filter(n=>/\.ya?ml$/i.test(n)).sort();
  const rows=[];
  for(const name of names){
    rows.push(auditWorkflow(name,await readFile(path.join(dir,name),'utf8')));
  }
  return rows;
}

async function cli(){
  const rows=await auditDirectory();
  const scientific=rows.filter(r=>r.scientific);
  const errors=rows.flatMap(r=>r.errors.map(error=>({workflow:r.name,error})));
  console.log(`AUDIO_WORKFLOW_TRIGGER_AUDIT workflows=${rows.length} gate4Scientific=${scientific.length} errors=${errors.length}`);
  for(const row of scientific) console.log(`GATE4_TRIGGER ${row.name} triggers=${row.triggers.join(',')||'none'}`);
  if(errors.length){
    for(const e of errors) console.error(`TRIGGER_AUDIT_FAIL ${e.workflow}: ${e.error}`);
    process.exitCode=2;
  }
}
const isCli=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isCli) await cli();
