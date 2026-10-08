import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {assertNarrowCarry} from './audio-round1-satellite-binding.mjs';
const ID='لماذا-لا-تسقط-الاقمار-الصناعيه-من-السماء',FP='0e8e0e8b14ee1892061b86ef796cc65951d1ab09be67f4c622cf64db73e75486';
const valid={base:{articleId:ID,fingerprint:FP,fullSha256:'8fe4fd364e2f9d13bd256d9359ef5814da74692588f6fb7619aed236a388239d',consensus:{substitutions:1,deletions:0,insertions:0,unresolved:0},substantiveDifferences:[{type:'substitution',expectedIndex:221,expected:'إذن',actual:'إذا'}],unresolved:[]},mapping:{articleId:ID,fingerprint:FP,fullSha256:'bf977577f07c000c92a6c1ddd4e2b04a5f30785da4e8967f19fe3c4d43e0b304',partIndex:0,expectedIndex:221,expectedToken:'إذن'},approved:true,sourcePartSha256:'a'.repeat(64),candidatePartSha256:'a'.repeat(64)};
assert.doesNotThrow(()=>assertNarrowCarry(valid));
for(const mutate of [
 x=>{x.candidatePartSha256='b'.repeat(64)},
 x=>{x.mapping.expectedIndex=222},
 x=>{x.approved=false},
 x=>{x.base.fullSha256=x.mapping.fullSha256},
 x=>{x.base.consensus.substitutions=2;x.base.substantiveDifferences.push({type:'substitution',expectedIndex:700,expected:'قوى',actual:'قوة'})},
 x=>{x.base.consensus.unresolved=1;x.base.unresolved.push({expectedIndex:964,expected:'أجره'})},
]){const altered=structuredClone(valid);mutate(altered);assert.throws(()=>assertNarrowCarry(altered));}
console.log('ROUND1_NARROW_BINDING=PASS valid=1 rejected-tamper-or-extra-errors=6');
