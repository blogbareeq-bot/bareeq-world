import {createHash} from 'node:crypto';
import {compareExactSpokenText,normalizeForVerbalComparison} from './audio-exact-match.mjs';

// Opt-in, one documented retirement only. Requests and actual model identities
// remain separate in every report; unrelated substitutions remain forbidden.
export const DOCUMENTED_FLASH_REDIRECT=Object.freeze({
 requestedModel:'gemini-3.5-flash',actualResponseModel:'gemini-3.6-flash',
 effectiveAt:'2026-10-08',source:'https://ai.google.dev/gemini-api/docs/changelog',
 verifiedAt:'2026-10-11',reason:'Google automatically routes retired 3.5 Flash requests to 3.6 Flash.'
});
export function resolveAsrResponseModel(requested,actual,allowDocumentedRedirect=false){
 if(!actual||String(actual).includes(requested))return {accepted:true,redirect:null};
 if(allowDocumentedRedirect&&requested===DOCUMENTED_FLASH_REDIRECT.requestedModel&&actual===DOCUMENTED_FLASH_REDIRECT.actualResponseModel)return {accepted:true,redirect:DOCUMENTED_FLASH_REDIRECT};
 return {accepted:false,redirect:null};
}
export function recoverRedirectedMicroReport({report,expectedText,audioSha256,extractTranscript,sourceReportSha256}){
 if(report.httpStatus!==200||report.fullSha256!==audioSha256||report.requestedModel!==DOCUMENTED_FLASH_REDIRECT.requestedModel||report.actualResponseModel!==DOCUMENTED_FLASH_REDIRECT.actualResponseModel||!report.error?.includes('does not match requested'))throw new Error('Retained redirect report binding failed');
 const payload=JSON.parse(report.rawTranscript);
 if(payload.model!==report.actualResponseModel||payload.id!==report.responseId||payload.status!=='completed')throw new Error('Retained response identity/integrity failed');
 const transcript=extractTranscript(payload);if(!transcript)throw new Error('Retained transcript empty');
 const comparison=compareExactSpokenText(expectedText,transcript);
 return {...report,status:comparison.passed?'passed':'failed',error:null,
  originalFailure:report.error,sourceReportSha256,
  rawResponseSha256:createHash('sha256').update(report.rawTranscript).digest('hex'),
  recoveryMethod:'offline-comparison-of-complete-retained-provider-response',additionalProviderCalls:0,
  documentedModelRedirect:DOCUMENTED_FLASH_REDIRECT,transcript,rawTranscript:transcript,
  normalizedTranscript:normalizeForVerbalComparison(transcript),expectedNormalized:normalizeForVerbalComparison(expectedText),
  substitutions:comparison.substitutions,deletions:comparison.deletions,insertions:comparison.insertions,differences:comparison.differences
 };
}
export function assertIndependentActualModels(reports){
 if(reports.length!==2||reports.some(r=>r.httpStatus!==200||!r.transcript||!r.actualResponseModel)||new Set(reports.map(r=>r.actualResponseModel)).size!==2)throw new Error('Two distinct actual ASR models required');
 return reports.map(r=>r.actualResponseModel);
}
