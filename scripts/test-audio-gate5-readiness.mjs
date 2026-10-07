import assert from 'node:assert/strict';
import { rankGate5Candidates } from './audio-gate5-readiness.mjs';

const active=[
 ['why-some-passports-are-stronger','جوازات'],
 ['intuition-first-impression-decisions-signature','الحدس'],
 ['لماذا-لا-تسقط-الاقمار-الصناعيه-من-السماء','الأقمار'],
 ['how-touchscreens-work','اللمس'],
 ['language-soft-power-politics','القوة'],
];
const status={exactCount:9,publishedCount:9,fallbackCount:6,rows:[
 ...Array.from({length:9},(_,i)=>({articleId:'e'+i,exact:true})),
 ...active.map(([articleId])=>({articleId,exact:false})),
 {articleId:'اعط-الصباح-فرصة-قراءة-في-كتاب-عبد-الوهاب-مطاوع',exact:false},
]};
const ids=['T03','T22','T13','T14','T29','T32','T15','T23','T25','T28','T36'];
const clusters=[
 {id:'pass',cases:['T03']},{id:'intuition',cases:['T22']},{id:'sat',cases:['T13']},
 {id:'touch1',cases:['T14']},{id:'touch2',cases:['T29']},{id:'touch3',cases:['T32']},
 {id:'soft',cases:['T15','T23','T25','T28','T36']},
];
const triage={packageId:'p',confirmedTargetAudioErrors:ids,defectClusters:clusters};
const mapping={
 T03:{kind:'pending',articleId:active[0][0],title:'جوازات',expectedIndex:1,expectedToken:'لا',issueType:'deletion',partIndex:0,segmentId:'a',fingerprint:'f',fullSha256:'s',hidden:{expected:'لا',actual:null,automatedType:'deletion'}},
 T22:{kind:'pending',articleId:active[1][0],title:'الحدس',expectedIndex:2,expectedToken:'11',issueType:'substitution',partIndex:0,segmentId:'b',fingerprint:'f',fullSha256:'s',hidden:{expected:'11',actual:'12',automatedType:'substitution'}},
 T13:{kind:'pending',articleId:active[2][0],title:'الأقمار',expectedIndex:3,expectedToken:'قوى',issueType:'substitution',partIndex:0,segmentId:'c',fingerprint:'f',fullSha256:'s',hidden:{expected:'قوى',actual:'قوة',automatedType:'substitution'}},
};
for(const [i,id] of ['T14','T29','T32'].entries()) mapping[id]={kind:'pending',articleId:active[3][0],title:'اللمس',expectedIndex:10+i,expectedToken:'x',issueType:'substitution',partIndex:i,segmentId:'t'+i,fingerprint:'f',fullSha256:'s',hidden:{expected:'x',actual:'y',automatedType:'substitution'}};
for(const [i,id] of ['T15','T23','T25','T28','T36'].entries()) mapping[id]={kind:'pending',articleId:active[4][0],title:'القوة',expectedIndex:20+i,expectedToken:'w',issueType:'deletion',partIndex:0,segmentId:'soft',fingerprint:'f',fullSha256:'s',hidden:{expected:'w',actual:null,automatedType:'deletion'}};
const r=rankGate5Candidates({status,triage,internal:{packageId:'p',mapping}});
assert.equal(r.rows.length,5);
assert.equal(r.recommended.articleId,'why-some-passports-are-stronger');
assert.equal(r.recommended.successfulTtsRequestsRequired,1);
assert.equal(r.recommended.authorizationStatus,'NOT_AUTHORIZED');
assert.equal(r.ttsCalls,0);
console.log('Gate 5 readiness ranking tests passed.');
