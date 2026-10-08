import argparse,json,pathlib,hashlib,re,unicodedata,subprocess
from difflib import SequenceMatcher
import numpy as np
RATE=48000
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def norm(s):return re.sub(r'[^0-9\u0621-\u064a]','', ''.join(c for c in unicodedata.normalize('NFKD',s) if not unicodedata.combining(c)).replace('ى','ي').replace('ـ',''))
def pcm(p):return np.frombuffer(subprocess.check_output(['ffmpeg','-v','error','-i',str(p),'-f','s16le','-ac','1','-ar',str(RATE),'-']),dtype='<i2').copy()
def boundary(samples,before,after):
 # Timings may include a sentence pause in the following word. Search only the
 # narrow shared boundary, never a broad low-energy stretch inside a sentence.
 mid=(before['end']+after['start'])/2
 lo=max(0,round((before['end']-.12)*RATE));hi=min(len(samples),round((after['start']+.30)*RATE));half=round(.020*RATE);choices=[]
 for n in range(lo+half,hi-half,round(.005*RATE)):
  x=samples[n-half:n+half].astype(float)/32768;rms=float(np.sqrt(np.mean(x*x)));peak=float(np.max(np.abs(x)))
  if rms<=10**(-42/20) and peak<=10**(-30/20):choices.append((abs(n/RATE-mid),n,rms,peak))
 if not choices:raise ValueError('No quiet 40ms source boundary at the aligned sentence edge')
 _,n,rms,peak=min(choices);return n/RATE,{'sample':n,'windowSamples':2*half,'rmsDb':20*np.log10(max(rms,1e-12)),'peakDb':20*np.log10(max(peak,1e-12))}
def edge_anchor(expected,actual,blocks,edge,left):
 candidates=[]
 for b in blocks:
  if left:
   stop=min(b.a+b.size,edge);size=stop-b.a
   if stop==edge and size>=2:
    count=min(5,size);at=b.b+stop-b.a;tokens=actual[at-count:at];candidates.append((at-1,tokens,count))
  else:
   start=max(b.a,edge);size=b.a+b.size-start
   if start==edge and size>=2:
    count=min(5,size);at=b.b+start-b.a;tokens=actual[at:at+count];candidates.append((at,tokens,count))
 safe=[]
 for at,tokens,count in candidates:
  if len(''.join(tokens))<8:continue
  if sum(actual[i:i+count]==tokens for i in range(len(actual)-count+1))==1:safe.append((at,tokens))
 if len(safe)!=1:raise ValueError('Missing or ambiguous unique adjacent sentence anchor')
 return safe[0]
def anchors(expected,actual,start,end):
 blocks=SequenceMatcher(None,expected,actual,autojunk=False).get_matching_blocks()
 if start==0:left=-1;before=['SOURCE_START']
 else:left,before=edge_anchor(expected,actual,blocks,start,True)
 if end==len(expected)-1:
  suffix=expected[-3:]
  if actual[-3:]!=suffix or sum(actual[i:i+3]==suffix for i in range(len(actual)-2))!=1:raise ValueError('Final sentence suffix does not uniquely reach the source end')
  right=len(actual);after=['SOURCE_END']
 else:right,after=edge_anchor(expected,actual,blocks,end+1,False)
 if right<=left+1:raise ValueError('Sentence has no retained source audio')
 return left,right,{'before':before,'after':after,'minimumUniqueFlankTokens':2,'wholeApprovedSentence':True}
def run(root):
 j=json.loads((root/'preflight-input.json').read_text());rows=[]
 for t in j['targets']:
  try:
   source=root/t['sourceFile'];assert sha(source)==t['sourcePartSha256'];timing=json.loads((root/t['wordFile']).read_text());assert timing['sourcePartSha256']==t['sourcePartSha256'] and timing['partIndex']==t['partIndex']
   words=timing['words'];actual=[w['norm'] for w in words];expected=list(map(norm,t['partExpectedTokens']));a,b,proof=anchors(expected,actual,t['repairExpectedStart'],t['repairExpectedEnd']);samples=pcm(source)
   if a<0:
    start,q1=boundary(samples,{'end':0},words[0])
   else:start,q1=boundary(samples,words[a],words[a+1])
   if b==len(words):end,q2=boundary(samples,words[-1],{'start':len(samples)/RATE})
   else:end,q2=boundary(samples,words[b-1],words[b])
   if not 1<=end-start<=65:raise ValueError('Unexpected whole-sentence duration')
   clip=root/(t['id']+'-baseline-context.mp3');cs=max(0,start-5);ce=min(len(samples)/RATE,end+5)
   subprocess.run(['ffmpeg','-v','error','-y','-ss',str(cs),'-i',str(source),'-t',str(ce-cs),'-ac','1','-ar','24000','-codec:a','libmp3lame','-q:a','2',str(clip)],check=True)
   rows.append({**t,'preflightPassed':True,'cutStartSeconds':start,'cutEndSeconds':end,'quietStart':q1,'quietEnd':q2,'anchors':proof,'baselineContextFile':clip.name,'baselineContextSha256':sha(clip),'baselineRegionTranscript':' '.join(w['raw'].strip() for w in words[a+1:b])})
  except Exception as e:rows.append({**t,'preflightPassed':False,'reason':str(e)})
 result={**j,'schema':'bareeq.audio-tranche40-preflight.v1','targets':rows,'passedTargets':sum(x['preflightPassed'] for x in rows),'providerCalls':0,'ttsCalls':0,'publicationPerformed':False}
 (root/'preflight-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps([{'id':t['id'],'passed':t['preflightPassed'],'reason':t.get('reason'),'cut':[t.get('cutStartSeconds'),t.get('cutEndSeconds')]} for t in rows],ensure_ascii=False),flush=True)
if __name__=='__main__':
 ap=argparse.ArgumentParser();ap.add_argument('--root',type=pathlib.Path,required=True);run(ap.parse_args().root)
