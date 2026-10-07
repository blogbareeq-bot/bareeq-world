import argparse,pathlib,json,hashlib,subprocess,re,unicodedata,wave
import numpy as np
RATE=48000
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def norm(s):return re.sub(r'[^0-9\u0621-\u064a]','', ''.join(c for c in unicodedata.normalize('NFKD',s) if not unicodedata.combining(c)).translate(str.maketrans('٠١٢٣٤٥٦٧٨٩','0123456789')).replace('ى','ي').replace('ـ',''))
def pcm(p):return np.frombuffer(subprocess.check_output(['ffmpeg','-v','error','-i',str(p),'-f','s16le','-ac','1','-ar',str(RATE),'-']),dtype='<i2').copy()
def wav(p,x):
 with wave.open(str(p),'wb') as f:f.setparams((1,2,RATE,0,'NONE','not compressed'));f.writeframes(x.astype('<i2').tobytes())
def encode(p,out):subprocess.run(['ffmpeg','-v','error','-y','-i',str(p),'-map_metadata','-1','-ac','1','-ar',str(RATE),'-codec:a','libmp3lame','-b:a','96k',str(out)],check=True)
def trim(x):
 window=int(.01*RATE);loud=[i for i in range(0,len(x)-window,window) if np.sqrt(np.mean((x[i:i+window].astype(float)/32768)**2))>10**(-45/20)]
 if not loud:raise ValueError('Generated audio has no speech')
 a=max(0,loud[0]-int(.12*RATE));b=min(len(x),loud[-1]+int(.17*RATE));x=x[a:b].copy();n=int(.005*RATE)
 if max(np.max(np.abs(x[:n].astype(float))),np.max(np.abs(x[-n:].astype(float))))>32768*10**(-30/20):raise ValueError('Generated clip lacks quiet edges')
 x[:n]=np.round(x[:n].astype(float)*np.linspace(0,1,n));x[-n:]=np.round(x[-n:].astype(float)*np.linspace(1,0,n));return x,a,b
root=pathlib.Path('tranche33-execution');p=json.loads(pathlib.Path('docs/audio/TRANCHE33-PREFLIGHT.json').read_text());result=json.loads((root/'execution-result.json').read_text())
from faster_whisper import WhisperModel
model=WhisperModel('small',device='cpu',compute_type='int8',cpu_threads=4);rows=[]
for r in p['targets']:
 row={'id':r['id'],'articleId':r['articleId'],'fingerprint':r['fingerprint'],'publicationPerformed':False}
 try:
  gen=root/(r['id']+'-generated.mp3');record=next(x for x in result['targets'] if x['id']==r['id']);assert sha(gen)==record['generatedSha256']
  segs,_=model.transcribe(str(gen),language='ar',beam_size=5,word_timestamps=True,vad_filter=False,condition_on_previous_text=False);words=[w.word for s in segs for w in s.words or []];actual=[norm(w) for w in words if norm(w)];expected=[norm(w) for w in re.findall(r'[0-9\u0621-\u064a\u064b-\u065f]+',r['repairText'])]
  expected=[u for t in expected for u in (['احد','عشر'] if t=='11' else [t])]
  actual=[u for t in actual for u in (['احد','عشر'] if t=='11' else [t])]
  (root/(r['id']+'-micro-asr.json')).write_text(json.dumps({'expected':expected,'actual':actual,'passed':expected==actual,'generatedSha256':sha(gen)},ensure_ascii=False,indent=2)+'\n')
  if actual!=expected:raise ValueError('Local micro ASR differs; retain generated audio for review, do not splice or retry')
  original=pathlib.Path('audio-candidates')/r['articleId']/r['fingerprint']/'parts'/r['sourceCheckpointRecord']['file'];assert sha(original)==r['sourcePartSha256'];base=pcm(original);donor,ds,de=trim(pcm(gen));a=round(r['cutStartSeconds']*RATE);b=round(r['cutEndSeconds']*RATE)
  if not 0<a<=b<len(base):raise ValueError('Cut outside retained part')
  joined=np.concatenate([base[:a],donor,base[b:]]);assert np.array_equal(joined[:a],base[:a]) and np.array_equal(joined[a+len(donor):],base[b:])
  seam=max(abs(int(joined[a])-int(joined[a-1])),abs(int(joined[a+len(donor)])-int(joined[a+len(donor)-1])))
  if seam>1000:raise ValueError('Unsafe seam step')
  wf=root/(r['id']+'-candidate-part.wav');mp=root/(r['id']+'-candidate-part.mp3');wav(wf,joined);encode(wf,mp)
  decoded=pcm(mp);margin=int(.05*RATE);prefix=np.corrcoef(base[:a-margin],decoded[:a-margin])[0,1];suffix=np.corrcoef(base[b+margin:],decoded[a+len(donor)+margin:a+len(donor)+len(base)-b])[0,1]
  if min(prefix,suffix)<.98:raise ValueError('Encoded retained audio correlation too low')
  cs=max(0,a-int(6*RATE));ce=min(len(joined),a+len(donor)+int(6*RATE));ctx=root/(r['id']+'-repaired-context.wav');wav(ctx,joined[cs:ce]);encode(ctx,root/(r['id']+'-repaired-context.mp3'))
  row.update(status='SPLICED_REQUIRES_FULL_QA',partFile=r['sourceCheckpointRecord']['file'],partIndex=r['partIndex'],baselinePartSha256=sha(original),candidatePartFile=mp.name,candidatePartSha256=sha(mp),outsidePcmIdentical=True,donorTrimSamples=[ds,de],prefixCorrelation=float(prefix),suffixCorrelation=float(suffix),seamStep=seam)
 except Exception as e:row.update(status='RETAINED_FOR_REVIEW',reason=str(e))
 rows.append(row)
(root/'splice-result.json').write_text(json.dumps({'schema':'bareeq.audio-tranche33-splice.v1','targets':rows,'publicationPerformed':False,'additionalTtsCalls':0},ensure_ascii=False,indent=2)+'\n');print(json.dumps(rows,ensure_ascii=False))
