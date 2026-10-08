"""Compare only an already reviewed region of an explicitly saved splice derivative."""
import hashlib,json,subprocess,sys
import numpy as np
source,current,start,end,shift=sys.argv[1:]
start,end,shift=map(float,(start,end,shift))
assert 0 <= start < end and start + shift >= 0
def pcm(p):
 return np.frombuffer(subprocess.check_output(['ffmpeg','-v','error','-i',p,'-f','s16le','-ac','1','-ar','48000','-']),dtype='<i2')
s=pcm(source)[round(start*48000):round(end*48000)]
c=pcm(current)[round((start+shift)*48000):round((end+shift)*48000)]
assert len(s)==len(c) and len(s)>48000
correlation=float(np.corrcoef(s,c)[0,1])
assert np.isfinite(correlation) and correlation>=.98, 'Previously listened encoded region diverged'
print(json.dumps({'independentReviewedRegionCorrelation':correlation,'sourceReviewedRegionPcmSha256':hashlib.sha256(s.tobytes()).hexdigest(),'candidateReviewedRegionPcmSha256':hashlib.sha256(c.tobytes()).hexdigest(),'reviewedRegionSamples':len(s)}))
