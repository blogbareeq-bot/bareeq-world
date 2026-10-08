import sys,pathlib,json,hashlib,subprocess,re,unicodedata,wave
import numpy as np
RATE=48000
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def pcm_sha(x):return hashlib.sha256(x.astype('<i2').tobytes()).hexdigest()
def norm(s):return re.sub(r'[^0-9\u0621-\u064a]','', ''.join(c for c in unicodedata.normalize('NFKD',s) if not unicodedata.combining(c)).translate(str.maketrans('٠١٢٣٤٥٦٧٨٩','0123456789')).replace('ى','ي').replace('ـ',''))
def pcm(p):return np.frombuffer(subprocess.check_output(['ffmpeg','-v','error','-i',str(p),'-f','s16le','-ac','1','-ar',str(RATE),'-']),dtype='<i2').copy()
def wav(p,x):
 with wave.open(str(p),'wb') as f:f.setparams((1,2,RATE,0,'NONE','not compressed'));f.writeframes(x.astype('<i2').tobytes())
def encode(p,out):subprocess.run(['ffmpeg','-v','error','-y','-i',str(p),'-map_metadata','-1','-ac','1','-ar',str(RATE),'-codec:a','libmp3lame','-b:a','96k',str(out)],check=True)
def trim(x):
 window=round(.01*RATE);loud=[i for i in range(0,len(x)-window,window) if np.sqrt(np.mean((x[i:i+window].astype(float)/32768)**2))>10**(-45/20)]
 if not loud:raise ValueError('Generated audio has no speech')
 a=max(0,loud[0]-round(.12*RATE));b=min(len(x),loud[-1]+round(.17*RATE));x=x[a:b].copy();n=round(.005*RATE)
 if max(np.max(np.abs(x[:n].astype(float))),np.max(np.abs(x[-n:].astype(float))))>32768*10**(-30/20):raise ValueError('Generated sentence lacks quiet edges')
 x[:n]=np.round(x[:n].astype(float)*np.linspace(0,1,n));x[-n:]=np.round(x[-n:].astype(float)*np.linspace(1,0,n));return x,a,b
def run(group):
 if group not in ['touchscreen','morning']:raise ValueError('invalid group')
 root=pathlib.Path('tranche40-execution');p=json.loads(pathlib.Path('docs/audio/TRANCHE40-PREFLIGHT.json').read_text());result=json.loads((root/'execution-result.json').read_text());rows=[]
 from faster_whisper import WhisperModel
 model=WhisperModel('small',device='cpu',compute_type='int8',cpu_threads=4)
 for r in p['targets']:
  if (r['requestNumber']<=3)!=(group=='touchscreen'):continue
  row={'id':r['id'],'articleId':r['articleId'],'fingerprint':r['fingerprint'],'publicationPerformed':False}
  try:
   record=next(x for x in result['targets'] if x['id']==r['id'])
   if record['status']!='GENERATED_REQUIRES_QA':raise ValueError('No complete generated sentence: '+record['status'])
   gen=root/record['generatedFile'];assert sha(gen)==record['generatedSha256'];original=pathlib.Path('audio-candidates')/r['articleId']/r['fingerprint']/'parts'/r['sourceCheckpointRecord']['file'];assert sha(original)==r['sourcePartSha256']
   segs,_=model.transcribe(str(gen),language='ar',beam_size=5,word_timestamps=True,vad_filter=False,condition_on_previous_text=False);words=[{'word':w.word,'start':w.start,'end':w.end} for s in segs for w in (s.words or [])]
   actual=[norm(w['word']) for w in words if norm(w['word'])];expected=[norm(w) for w in re.findall(r'[0-9\u0621-\u064a\u064b-\u065f]+',r['repairText']) if norm(w)]
   (root/(r['id']+'-local-micro-asr.json')).write_text(json.dumps({'expected':expected,'actual':actual,'words':words,'exactLocalTranscription':expected==actual,'generatedSha256':sha(gen),'role':'diagnostic only; strict fresh full-file independent dual-ASR gates publication'},ensure_ascii=False,indent=2)+'\n')
   base=pcm(original);donor,ds,de=trim(pcm(gen));a=r['quietStart']['sample'];b=r['quietEnd']['sample']
   if not 0<=a<b<len(base):raise ValueError('Cut outside verified source')
   joined=np.concatenate([base[:a],donor,base[b:]])
   if not np.array_equal(joined[:a],base[:a]) or not np.array_equal(joined[a+len(donor):],base[b:]):raise ValueError('PCM outside source cut changed')
   seam=max(abs(int(joined[a])-int(joined[a-1])) if a else 0,abs(int(joined[a+len(donor)])-int(joined[a+len(donor)-1])))
   if seam>1000:raise ValueError('Unsafe seam step')
   wf=root/(r['id']+'-candidate-part.wav');mp=root/(r['id']+'-candidate-part.mp3');wav(wf,joined);encode(wf,mp)
   decoded=pcm(mp);margin=round(.05*RATE);prefix=float(np.corrcoef(base[:a-margin],decoded[:a-margin])[0,1]);suffix=float(np.corrcoef(base[b+margin:],decoded[a+len(donor)+margin:a+len(donor)+len(base)-b])[0,1]) if len(base)-b>margin+200 else 1.0
   if not np.isfinite(prefix) or not np.isfinite(suffix) or min(prefix,suffix)<.98:raise ValueError('Encoded retained audio correlation too low')
   ctx=root/(r['id']+'-repaired-context.wav');cs=max(0,a-round(5*RATE));ce=min(len(joined),a+len(donor)+round(5*RATE));wav(ctx,joined[cs:ce]);context=root/(r['id']+'-repaired-context.mp3');encode(ctx,context)
   row.update(status='SPLICED_REQUIRES_FULL_QA',partFile=r['sourceCheckpointRecord']['file'],partIndex=r['partIndex'],baselinePartSha256=sha(original),candidatePartFile=mp.name,candidatePartSha256=sha(mp),outsidePcmIdentical=True,sourceCutSamples=[a,b],candidateInsertedSamples=[a,a+len(donor)],generatedSha256=sha(gen),donorTrimSamples=[ds,de],sourcePrefixPcmSha256=pcm_sha(base[:a]),candidatePrefixPcmSha256=pcm_sha(joined[:a]),sourceSuffixPcmSha256=pcm_sha(base[b:]),candidateSuffixPcmSha256=pcm_sha(joined[a+len(donor):]),prefixCorrelation=prefix,suffixCorrelation=suffix,seamStep=seam,repairedContextFile=context.name,repairedContextSha256=sha(context),localMicroAsrExact=expected==actual)
   wf.unlink();ctx.unlink()
  except Exception as e:row.update(status='RETAINED_FOR_REVIEW',reason=str(e))
  rows.append(row)
 (root/(group+'-splice-result.json')).write_text(json.dumps({'schema':'bareeq.audio-tranche40-splice.v1','group':group,'targets':rows,'publicationPerformed':False,'additionalTtsCalls':0},ensure_ascii=False,indent=2)+'\n');print(json.dumps(rows,ensure_ascii=False),flush=True)
if __name__=='__main__':run(sys.argv[1])
