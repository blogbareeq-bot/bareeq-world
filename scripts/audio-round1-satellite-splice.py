import json,pathlib,hashlib,subprocess,wave
import numpy as np
RATE=48000
root=pathlib.Path('round1-output')
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def pcm(p):return np.frombuffer(subprocess.check_output(['ffmpeg','-v','error','-i',str(p),'-f','s16le','-ac','1','-ar',str(RATE),'-']),dtype='<i2').copy()
def wav(p,x):
 with wave.open(str(p),'wb') as f:f.setparams((1,2,RATE,0,'NONE','not compressed'));f.writeframes(x.astype('<i2').tobytes())
def encode(p,o):subprocess.run(['ffmpeg','-v','error','-y','-i',str(p),'-map_metadata','-1','-ac','1','-ar',str(RATE),'-codec:a','libmp3lame','-b:a','96k',str(o)],check=True)
def quiet(z):
 z=z.astype(float)/32768
 return len(z)>=1920 and np.sqrt(np.mean(z*z))<10**(-42/20) and np.max(abs(z))<10**(-30/20)
p=json.loads(pathlib.Path('docs/audio/TRANCHE33-PREFLIGHT.json').read_text());r=next(x for x in p['targets'] if x['id']=='R3')
review=json.loads(pathlib.Path('docs/audio/BOUND-REVIEW-ROUND1.json').read_text());d=next(x for x in review['decisions'] if x['caseId']=='R3')
assert d['decision']=='EXPECTED_PRONUNCIATION_CONFIRMED' and d['bindingVerified'] and d['humanReviewPerformed'] and d['fullSha256'] is None
basefile=root/'baseline-part.mp3';genfile=root/'approved-micro.mp3'
assert sha(basefile)==r['sourcePartSha256'];assert sha(genfile)==d['generatedMicroSha256']==d['clipSha256']
base=pcm(basefile);g=pcm(genfile);a=r['quietStart']['sample'];b=r['quietEnd']['sample'];assert 0<a<b<len(base)
assert quiet(base[a-960:a+960]) and quiet(base[b-960:b+960]),'Baseline clause cuts no longer quiet'
loud=[i for i in range(0,len(g)-480,480) if np.sqrt(np.mean((g[i:i+480].astype(float)/32768)**2))>10**(-45/20)];assert loud
ds=max(0,loud[0]-5760);de=min(len(g),loud[-1]+8160);donor=g[ds:de].copy()
assert quiet(donor[:1920]) and quiet(donor[-1920:]),'Approved micro has unsafe outer edges'
n=240;donor[:n]=np.round(donor[:n].astype(float)*np.linspace(0,1,n));donor[-n:]=np.round(donor[-n:].astype(float)*np.linspace(1,0,n))
joined=np.concatenate([base[:a],donor,base[b:]]);assert np.array_equal(joined[:a],base[:a]) and np.array_equal(joined[a+len(donor):],base[b:])
seam=max(abs(int(joined[a])-int(joined[a-1])),abs(int(joined[a+len(donor)])-int(joined[a+len(donor)-1])));assert seam<=1000
candidate=root/'candidate-part.mp3';wf=root/'candidate-part.wav';wav(wf,joined);encode(wf,candidate);dec=pcm(candidate);margin=2400
pc=float(np.corrcoef(base[:a-margin],dec[:a-margin])[0,1]);sc=float(np.corrcoef(base[b+margin:],dec[a+len(donor)+margin:a+len(donor)+len(base)-b])[0,1]);assert min(pc,sc)>.98
start=max(0,a-6*RATE);end=min(len(joined),a+len(donor)+6*RATE);ctx=root/'repaired-context.wav';wav(ctx,joined[start:end]);encode(ctx,root/'repaired-context.mp3')
row={'schema':'bareeq.audio-reviewed-micro-splice.v1','articleId':r['articleId'],'fingerprint':r['fingerprint'],'partIndex':r['partIndex'],'partFile':r['sourceCheckpointRecord']['file'],'baselinePartSha256':sha(basefile),'generatedMicroSha256':sha(genfile),'candidatePartSha256':sha(candidate),'sourceSubmissionSha256':review['sourceSubmissionSha256'],'reviewer':d['reviewer'],'reviewedAt':d['decisionDate'],'method':'owner-confirmed-whole-clause-from-counted-saved-audio','baselineCutSamples':[a,b],'donorTrimSamples':[ds,de],'insertedPcmSha256':hashlib.sha256(donor.astype('<i2').tobytes()).hexdigest(),'outsidePcmIdentical':True,'prefixCorrelation':pc,'suffixCorrelation':sc,'seamStep':seam,'reviewClipStartInPart':start/RATE,'reviewClipEndInPart':end/RATE,'ttsCalls':0,'publicationPerformed':False,'requiresFreshFullQa':True}
(root/'splice-result.json').write_text(json.dumps(row,ensure_ascii=False,indent=2)+'\n');print(json.dumps(row,ensure_ascii=False))
