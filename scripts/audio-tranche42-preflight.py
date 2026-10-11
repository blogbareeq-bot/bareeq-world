import pathlib,json,hashlib,subprocess
import numpy as np
root=pathlib.Path('tranche42-execution');p=json.loads((root/'preflight.json').read_text());rows=[]
for t in p['targets']:
 src=pathlib.Path('audio-candidates')/t['articleId']/t['fingerprint']/'parts'/t['sourceCheckpointRecord']['file']
 assert hashlib.sha256(src.read_bytes()).hexdigest()==t['sourcePartSha256']
 pcm=np.frombuffer(subprocess.check_output(['ffmpeg','-v','error','-i',str(src),'-f','s16le','-ar','48000','-ac','1','-']),dtype='<i2').astype(float)/32768
 assert 0<=t['quietStart']['sample']<t['quietEnd']['sample']<len(pcm)
 for q in [t['quietStart'],t['quietEnd']]:
  half=q['windowSamples']//2;x=pcm[q['sample']-half:q['sample']+half];rms=20*np.log10(max(float(np.sqrt(np.mean(x*x))),1e-12));peak=20*np.log10(max(float(np.max(np.abs(x))),1e-12))
  assert rms<=-42 and peak<=-30 and abs(rms-q['rmsDb'])<.5 and abs(peak-q['peakDb'])<.5
 assert abs(t['cutStartSeconds']*48000-t['quietStart']['sample'])<.1 and abs(t['cutEndSeconds']*48000-t['quietEnd']['sample'])<.1
 rows.append(t)
p['passed']=True;p['targets']=rows;(root/'preflight.json').write_text(json.dumps(p,ensure_ascii=False,indent=2)+'\n');print('TRANCHE42_QUIET_SOURCE_CUTS=PASS targets=2 providerCalls=0')
