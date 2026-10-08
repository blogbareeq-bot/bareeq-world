const ID='لماذا-لا-تسقط-الاقمار-الصناعيه-من-السماء',FP='0e8e0e8b14ee1892061b86ef796cc65951d1ab09be67f4c622cf64db73e75486',BASE='bf977577f07c000c92a6c1ddd4e2b04a5f30785da4e8967f19fe3c4d43e0b304',FULL='8fe4fd364e2f9d13bd256d9359ef5814da74692588f6fb7619aed236a388239d';
export function assertNarrowCarry({base,mapping,approved,sourcePartSha256,candidatePartSha256}){
 if(base.articleId!==ID||base.fingerprint!==FP||base.fullSha256!==FULL||base.consensus.substitutions!==1||base.consensus.deletions!==0||base.consensus.insertions!==0||base.consensus.unresolved!==0||base.substantiveDifferences.length!==1||base.unresolved.length!==0)throw new Error('Only the known single issue may be resolved');
 const issue=base.substantiveDifferences[0];
 if(!approved||mapping.articleId!==ID||mapping.fingerprint!==FP||mapping.fullSha256!==BASE||mapping.partIndex!==0||mapping.expectedIndex!==221||mapping.expectedToken!=='إذن'||issue.type!=='substitution'||issue.expectedIndex!==221||issue.expected!=='إذن'||issue.actual!=='إذا'||!sourcePartSha256||sourcePartSha256!==candidatePartSha256)throw new Error('Historical T21 is not an unchanged source-bound case');
}
