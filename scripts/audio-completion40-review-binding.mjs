import {createHash} from 'node:crypto';
export const SUBMISSION_SHA='5bc2e476bd49d57007aab6a51c1e27fa388b6ed6db3d4ffaeb6c551e60924ce3';
export const PACKET_SHA='9f6ded41d758c8bc56ae5c6ae9e06f3152a50a81ac1105fee5eccd4e1f084b95';
export const MANIFEST_SHA='7edd77f7aae106b6f21daddf6adf94f32bd179fd75f63e3f1f69f8214187a014';
export const hash=x=>createHash('sha256').update(x).digest('hex');
export function stable(x){return JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);}
const same=(a,b)=>stable(a)===stable(b);
export function bindCompletion40({issued,submissionBytes,supplement}){
 const submission=JSON.parse(submissionBytes);
 if(hash(submissionBytes)!==SUBMISSION_SHA||hash(stable(issued))!==PACKET_SHA)throw new Error('Immutable submission or issued packet SHA mismatch');
 if(submission.schema!=='bareeq.audio-completion40-review-submission.v1'||submission.packageId!==issued.packageId||submission.issuedPacketSha256!==PACKET_SHA||submission.sourceReviewManifestSha256!==MANIFEST_SHA||issued.sourceReviewManifestSha256!==MANIFEST_SHA||submission.completed!==true||!submission.reviewer||!submission.submittedAt)throw new Error('Review package is incomplete or unbound');
 if(issued.cases.length!==28||submission.decisions.length!==28||new Set(issued.cases.map(x=>x.caseId)).size!==28||new Set(submission.decisions.map(x=>x.caseId)).size!==28)throw new Error('Exactly 28 unique decisions are required');
 for(const d of submission.decisions){
  const original=issued.cases.find(x=>x.caseId===d.caseId);if(!original)throw new Error('Unissued case '+d.caseId);
  for(const [k,v] of Object.entries(original))if(!same(d[k],v))throw new Error(d.caseId+': issued field mismatch '+k);
  if(d.humanReviewPerformed!==true||!d.reviewer||!d.decisionDate||d.issuedPacketSha256!==PACKET_SHA||!['EXPECTED_PRONUNCIATION_CONFIRMED','ACTUAL_AUDIO_ERROR'].includes(d.decision))throw new Error(d.caseId+': invalid human decision');
 }
 const confirmed=submission.decisions.filter(x=>x.decision==='EXPECTED_PRONUNCIATION_CONFIRMED'),actual=submission.decisions.filter(x=>x.decision==='ACTUAL_AUDIO_ERROR');
 if(confirmed.length!==27||actual.length!==1||actual[0].caseId!=='S-01-450')throw new Error('Unexpected approved review outcome');
 const parent=issued.cases.find(x=>x.clipCaseId==='C1-01');
 for(const k of ['articleId','fingerprint','fullSha256','speechScriptHash','sourcePartSha256','partNumber','clipSha256','clipStart','clipEnd','segmentId','expectedText'])if(!same(supplement[k],parent[k]))throw new Error('Supplement source binding mismatch '+k);
 if(supplement.caseId!=='C1-01-617-owner'||supplement.clipCaseId!=='C1-01'||supplement.expectedIndex!==617||supplement.expectedToken!=='ويعرض'||supplement.heard!=='ويُغرض'||supplement.decision!=='ACTUAL_AUDIO_ERROR'||supplement.humanReviewPerformed!==true||supplement.sourceSubmissionSha256!==SUBMISSION_SHA||supplement.sourceImageSha256!=='b331108ae07eb2d3f22645d07b503efd18d8083cce29bc9fcceb8225df12615a'||issued.cases.some(x=>x.expectedIndices.includes(617)&&x.articleId===supplement.articleId))throw new Error('Additional owner audio defect is not bound');
 return {schema:'bareeq.audio-completion40-bound-review.v1',sourceSubmissionSha256:SUBMISSION_SHA,issuedPacketSha256:PACKET_SHA,sourceReviewManifestSha256:MANIFEST_SHA,reviewer:submission.reviewer,submittedAt:submission.submittedAt,confirmed,actual,supplement,ttsCalls:0,newAsrCalls:0};
}
