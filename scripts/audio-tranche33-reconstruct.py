import json,pathlib,hashlib,subprocess,re,unicodedata,wave
import numpy as np
from faster_whisper import WhisperModel
RATE=48000;root=pathlib.Path('tranche33-execution');p=json.loads(pathlib.Path('docs/audio/TRANCHE33-PREFLIGHT.json').read_text());ind=json.loads(pathlib.Path('source-review/micro-independent-review.json').read_text());splice=json.loads((root/'splice-result.json').read_text());model=WhisperModel('small',device='cpu',compute_type='int8',cpu_threads=4)
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(pathlib.Path('preflight-evidence/preflight-result.json'))==p['originalArtifactResultSha256']
def norm(s):return re.sub(r'[^0-9\u0621-\u064a]','', ''.join(c for c in unicodedata.normalize('NFKD',s) if not unicodedata.combining(c)).replace('ى','ي').replace('ـ',''))
def pcm(p):return np.frombuffer(subprocess.check_output(['ffmpeg','-v','error','-i',str(p),'-f','s16le','-ac','1','-ar',str(RATE),'-']),dtype='<i2').copy()
def quiet(x,before,after):
 lo=max(0,round((before['end']-.12)*RATE));hi=min(len(x),round((after['start']+.04)*RATE));mid=round((before['end']+after['start'])/2*RATE);half=round(.02*RATE);options=[]
 for n in range(lo+half,hi-half,round(.005*RATE)):
  z=x[n-half:n+half].astype(float)/32768;rms=np.sqrt(np.mean(z*z));peak=max(abs(z))
  if rms<10**(-42/20) and peak<10**(-30/20):options.append((abs(n-mid),n))
 if not options:raise ValueError('No safe source-derived quiet word boundary')
 return min(options)[1]
def wav(p,x):
 with wave.open(str(p),'wb') as f:f.setparams((1,2,RATE,0,'NONE','not compressed'));f.writeframes(x.astype('<i2').tobytes())
def encode(p,o):subprocess.run(['ffmpeg','-v','error','-y','-i',str(p),'-map_metadata','-1','-ac','1','-ar',str(RATE),'-codec:a','libmp3lame','-b:a','96k',str(o)],check=True)
for r in p['targets']:
 if r['id'] not in ['R1','R3']:continue
 row={'id':r['id'],'articleId':r['articleId'],'fingerprint':r['fingerprint'],'partIndex':r['partIndex'],'partFile':r['sourceCheckpointRecord']['file'],'baselinePartSha256':r['sourcePartSha256'],'ttsCalls':0}
 try:
  gen=root/(r['id']+'-generated.mp3');e=next(x for x in ind['targets'] if x['id']==r['id']);assert sha(gen)==e['generatedSha256'];assert len(e['reports'])==2 and len({x['model'] for x in e['reports']})==2
  source=pathlib.Path('audio-candidates')/r['articleId']/r['fingerprint']/'parts'/r['sourceCheckpointRecord']['file'];assert sha(source)==r['sourcePartSha256'];base=pcm(source);g=pcm(gen)
  if r['id']=='R1':
   if not all(x['passed'] and not x['differences'] for x in e['reports']):raise ValueError('Heading does not have exact two-model micro evidence')
   loud=[i for i in range(0,len(g)-480,480) if np.sqrt(np.mean((g[i:i+480].astype(float)/32768)**2))>10**(-45/20)];ds=max(0,min(loud)-5760);de=min(len(g),max(loud)+8160);a=round(r['cutStartSeconds']*RATE);b=a;method='two-model-exact-heading-insertion'
  else:
   # Both independent transcriptions confirm the plural; discard the changed connective.
   for report in e['reports']:
    words=report['transcript'].split()
    if len(words)!=7 or norm(words[2])!='هناك' or norm(words[3])!='قوي' or [norm(x) for x in words[4:]]!=['تعيق','حركتها','مثل']:raise ValueError('Plural donor lacks two-model lexical corroboration')
   segments,_=model.transcribe(str(gen),language='ar',word_timestamps=True,beam_size=5,vad_filter=False,condition_on_previous_text=False);w=[{'raw':z.word,'norm':norm(z.word),'start':z.start,'end':z.end} for s in segments for z in s.words or [] if norm(z.word)]
   if len(w)!=7 or w[2]['norm']!='هناك' or w[3]['norm'] not in ['قوي','قوة'] or [x['norm'] for x in w[4:]]!=['تعيق','حركتها','مثل']:raise ValueError('Uncertain donor word timing')
   ds=quiet(g,w[2],w[3]);de=quiet(g,w[3],w[4]);bw=json.loads(pathlib.Path('preflight-evidence/R3-words.json').read_text());assert bw[124]['norm']=='هناك' and bw[125]['norm']=='قوة' and bw[126]['norm']=='تعيق';a=quiet(base,bw[124],bw[125]);b=quiet(base,bw[125],bw[126]);method='plural-word-only-original-connective-preserved'
  donor=g[ds:de].copy();n=240
  if min(len(donor),b-a if b>a else len(donor))<4800:raise ValueError('Unexpected short word region')
  if max(np.max(abs(donor[:n].astype(float))),np.max(abs(donor[-n:].astype(float))))>32768*10**(-30/20):raise ValueError('Donor edges are not quiet')
  donor[:n]=np.round(donor[:n].astype(float)*np.linspace(0,1,n));donor[-n:]=np.round(donor[-n:].astype(float)*np.linspace(1,0,n));joined=np.concatenate([base[:a],donor,base[b:]]);assert np.array_equal(joined[:a],base[:a]) and np.array_equal(joined[a+len(donor):],base[b:]);seam=max(abs(int(joined[a])-int(joined[a-1])),abs(int(joined[a+len(donor)])-int(joined[a+len(donor)-1])))
  if seam>1000:raise ValueError('Unsafe seam')
  wf=root/(r['id']+'-candidate-part.wav');mp=root/(r['id']+'-candidate-part.mp3');wav(wf,joined);encode(wf,mp);dec=pcm(mp);margin=2400;pc=np.corrcoef(base[:a-margin],dec[:a-margin])[0,1];sc=np.corrcoef(base[b+margin:],dec[a+len(donor)+margin:a+len(donor)+len(base)-b])[0,1]
  if min(pc,sc)<.98:raise ValueError('Encoded retained-audio correlation failed')
  ctx=root/(r['id']+'-repaired-context.wav');wav(ctx,joined[max(0,a-6*RATE):min(len(joined),a+len(donor)+6*RATE)]);encode(ctx,root/(r['id']+'-repaired-context.mp3'));row.update(status='SPLICED_REQUIRES_FULL_QA',candidatePartFile=mp.name,candidatePartSha256=sha(mp),outsidePcmIdentical=True,prefixCorrelation=float(pc),suffixCorrelation=float(sc),seamStep=seam,method=method,baselineCutSamples=[a,b],donorCutSamples=[ds,de],generatedDonorSha256=sha(gen),independentMicroModels=[x['model'] for x in e['reports']])
 except Exception as ex:row.update(status='RETAINED_FOR_REVIEW',reason=str(ex))
 splice['targets']=[x for x in splice['targets'] if x['id']!=r['id']]+[row];(root/'splice-result.json').write_text(json.dumps(splice,ensure_ascii=False,indent=2)+'\n');print(json.dumps(row,ensure_ascii=False),flush=True)
