import argparse,json,pathlib,hashlib,re,unicodedata,subprocess,wave
from difflib import SequenceMatcher
import numpy as np
RATE=48000
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def norm(s):return re.sub(r'[^0-9\u0621-\u064a]','', ''.join(c for c in unicodedata.normalize('NFKD',s) if not unicodedata.combining(c)).replace('ى','ي').replace('ـ',''))
def pcm(p):return np.frombuffer(subprocess.check_output(['ffmpeg','-v','error','-i',str(p),'-f','s16le','-ac','1','-ar',str(RATE),'-']),dtype='<i2').copy()
def quiet(samples,before,after):
 lo=max(0,int((before['end']-.12)*RATE));hi=min(len(samples),int((after['start']+.04)*RATE));mid=int((before['end']+after['start'])/2*RATE);half=int(.02*RATE);choices=[]
 for n in range(lo+half,hi-half,int(.005*RATE)):
  x=samples[n-half:n+half].astype(float)/32768;rms=float(np.sqrt(np.mean(x*x)));peak=float(np.max(np.abs(x)))
  if rms<=10**(-42/20) and peak<=10**(-30/20):choices.append((abs(n-mid),n,rms,peak))
 if not choices:raise ValueError('No safe quiet boundary: '+str((before,after)))
 _,n,rms,peak=min(choices);return n/RATE,{'sample':n,'rmsDb':20*np.log10(max(rms,1e-12)),'peakDb':20*np.log10(max(peak,1e-12))}
def transcribe(model,p):
 segments,_=model.transcribe(str(p),language='ar',beam_size=5,word_timestamps=True,vad_filter=False,condition_on_previous_text=False)
 return [{'start':w.start,'end':w.end,'raw':w.word,'norm':norm(w.word)} for s in segments for w in (s.words or []) if norm(w.word)]
def anchors(expected,actual,start,end):
 blocks=SequenceMatcher(None,expected,actual,autojunk=False).get_matching_blocks()
 left=[b for b in blocks if b.size>=3 and b.a+b.size<=start and start-(b.a+b.size)<=25]
 right=[b for b in blocks if b.size>=3 and b.a>end and b.a-end<=25]
 if not left or not right:raise ValueError('No strong flanking anchors')
 l=max(left,key=lambda b:b.a+b.size);r=min(right,key=lambda b:b.a)
 if l.a+l.size!=start or r.a!=end+1:raise ValueError('Segment boundary does not align exactly; refuse uncertain splice')
 lt=actual[l.b+l.size-3:l.b+l.size];rt=actual[r.b:r.b+3]
 for t in [lt,rt]:
  if sum(actual[i:i+len(t)]==t for i in range(len(actual)-len(t)+1))!=1:raise ValueError('Non-unique anchor')
 return l.b+l.size-1,r.b,{'before':lt,'after':rt}
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--root',type=pathlib.Path,required=True);args=ap.parse_args();root=args.root;j=json.loads((root/'preflight-input.json').read_text())
 from faster_whisper import WhisperModel
 model=WhisperModel('small',device='cpu',compute_type='int8',cpu_threads=4);rows=[]
 for t in j['targets']:
  source=root/t['sourceFile'];assert sha(source)==t['sourcePartSha256'];words=transcribe(model,source);(root/(t['id']+'-words.json')).write_text(json.dumps(words,ensure_ascii=False,indent=2)+'\n');actual=[w['norm'] for w in words];expected=[norm(w) for w in t['partExpectedTokens']]
  try:
   a,b,proof=anchors(expected,actual,t['repairExpectedStart'],t['repairExpectedEnd']);samples=pcm(source)
   if t['insertionExpected']:
    if b!=a+1:raise ValueError('Supposed omitted heading has unexpected intervening audio')
    start,q1=quiet(samples,words[a],words[b]);end=start;q2=q1
   else:
    if b<=a+1:raise ValueError('Replacement segment is missing audio')
    start,q1=quiet(samples,words[a],words[a+1]);end,q2=quiet(samples,words[b-1],words[b]);
    if not 1<=end-start<=65:raise ValueError('Unexpected segment duration')
   clip=root/(t['id']+'-baseline-context.mp3');cs=max(0,start-6);ce=min(len(samples)/RATE,end+6)
   subprocess.run(['ffmpeg','-v','error','-y','-ss',str(cs),'-i',str(source),'-t',str(ce-cs),'-ac','1','-ar','24000','-codec:a','libmp3lame','-q:a','2',str(clip)],check=True)
   rows.append({**t,'preflightPassed':True,'cutStartSeconds':start,'cutEndSeconds':end,'quietStart':q1,'quietEnd':q2,'anchors':proof,'baselineContextFile':clip.name,'baselineContextSha256':sha(clip),'baselineRegionTranscript':' '.join(w['raw'].strip() for w in words[a+1:b])})
  except ValueError as e:rows.append({**t,'preflightPassed':False,'reason':str(e)})
 result={**j,'schema':'bareeq.audio-tranche33-preflight.v1','targets':rows,'passedTargets':sum(x['preflightPassed'] for x in rows),'providerCalls':0,'ttsCalls':0,'publicationPerformed':False};(root/'preflight-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps([{'id':t['id'],'passed':t['preflightPassed'],'reason':t.get('reason'),'cut':[t.get('cutStartSeconds'),t.get('cutEndSeconds')]} for t in rows],ensure_ascii=False))
if __name__=='__main__':main()
