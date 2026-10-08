#!/usr/bin/env python3
"""Build a review-only candidate from retained audio; never calls a provider."""
import argparse, hashlib, json, pathlib, re, subprocess, unicodedata, wave
import numpy as np

RATE = 48000
BASE = '09b0253960eb4d5c2da1c8af50ed0e87f373b7ca030d14c09d99533ad8e68ae4'
TRIAL = '5e8d5e7302e819f140376eb5e6347dc4146c5c66c6b1e37565978e1d61e308fd'

def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def save(p, value): p.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')
def norm(s):
    s = ''.join(c for c in unicodedata.normalize('NFKD', s) if not unicodedata.combining(c))
    return re.sub(r'[^\u0621-\u064a0-9]', '', s.replace('ى','ي').replace('ـ',''))
def unique(words, phrase):
    tokens = list(map(norm, phrase.split())); actual = [w['norm'] for w in words]
    hits = [i for i in range(len(words)-len(tokens)+1) if actual[i:i+len(tokens)] == tokens]
    if len(hits) != 1: raise ValueError(f'anchor is not unique: {phrase}: {hits}')
    return hits[0]
def pcm(p):
    return np.frombuffer(subprocess.check_output(['ffmpeg','-v','error','-i',str(p),'-f','s16le','-ac','1','-ar',str(RATE),'-']), dtype='<i2').copy()
def wav(p, samples):
    with wave.open(str(p), 'wb') as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(RATE); f.writeframes(samples.astype('<i2').tobytes())
def encode(p, dest):
    subprocess.run(['ffmpeg','-v','error','-y','-i',str(p),'-codec:a','libmp3lame','-b:a','96k',str(dest)],check=True)
def transcribe(model, p):
    segments, info = model.transcribe(str(p), language='ar', beam_size=5, word_timestamps=True, vad_filter=False, condition_on_previous_text=False)
    words=[]
    for seg in segments:
        for w in seg.words or []: words.append({'start':w.start,'end':w.end,'raw':w.word,'norm':norm(w.word),'probability':w.probability})
    return words
def quiet_boundary(samples, words, i):
    if i <= 0: raise ValueError('no preceding word at boundary')
    before, after = words[i-1], words[i]
    # Word timestamps are approximate. Search only a narrow interword guard,
    # and require 40 ms of quiet surrounding the actual cut sample.
    lo = max(0, int((before['end']-.12)*RATE))
    hi = min(len(samples), int((after['start']+.04)*RATE))
    target = int((before['end']+after['start'])/2*RATE)
    half = int(.02*RATE); choices=[]
    for n in range(lo+half, hi-half, int(.005*RATE)):
        window = samples[n-half:n+half].astype(np.float64)/32768
        rms=float(np.sqrt(np.mean(window**2))); peak=float(np.max(np.abs(window)))
        if rms <= 10**(-42/20) and peak <= 10**(-30/20): choices.append((abs(n-target),n,rms,peak))
    if not choices: raise ValueError(f'no safe silence before {after["raw"]}: {before["end"]}..{after["start"]}')
    _, n, rms, peak=min(choices)
    return n, {'sample':n,'seconds':n/RATE,'rmsDb':20*np.log10(max(rms,1e-12)), 'peakDb':20*np.log10(max(peak,1e-12)), 'before':before,'after':after}

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--root',type=pathlib.Path,required=True); ap.add_argument('--out',type=pathlib.Path,required=True); args=ap.parse_args()
    args.out.mkdir(parents=True,exist_ok=False)
    base=args.root/'passports-baseline-part4.mp3'; trial=args.root/'passports-trial-part4.mp3'
    if sha(base)!=BASE or sha(trial)!=TRIAL: raise ValueError('retained source identity mismatch')
    from faster_whisper import WhisperModel
    model=WhisperModel('small',device='cpu',compute_type='int8',cpu_threads=4)
    words={}; samples={}; bounds={}
    for name, source in [('baseline',base),('trial',trial)]:
        words[name]=transcribe(model,source); save(args.out/f'{name}-words.json',words[name]); samples[name]=pcm(source)
        start=unique(words[name],'هل المسألة كلها سياسة'); end=unique(words[name],'أوضح مثال على')
        if end <= start or end-start > 70: raise ValueError('invalid replacement paragraph')
        text=' '.join(w['norm'] for w in words[name][start:end])
        if name=='trial' and 'لا السياسة حاضرة بقوة' not in text: raise ValueError('donor does not contain confirmed لا anchor')
        if name=='baseline' and 'لا السياسة حاضرة بقوة' in text: raise ValueError('baseline premise changed')
        a,qa=quiet_boundary(samples[name],words[name],start); b,qb=quiet_boundary(samples[name],words[name],end)
        if not 10 <= (b-a)/RATE <= 35: raise ValueError('unexpected paragraph duration')
        bounds[name]={'start':a,'end':b,'startQuiet':qa,'endQuiet':qb,'text':text}
    ba,bb=bounds['baseline']['start'],bounds['baseline']['end']; ta,tb=bounds['trial']['start'],bounds['trial']['end']
    donor=samples['trial'][ta:tb].copy()
    # Only 5 ms already inside the verified silence is faded; no spoken sample.
    k=int(.005*RATE); donor[:k]=(donor[:k]*np.linspace(0,1,k)).astype('<i2'); donor[-k:]=(donor[-k:]*np.linspace(1,0,k)).astype('<i2')
    candidate=np.concatenate([samples['baseline'][:ba],donor,samples['baseline'][bb:]])
    if not np.array_equal(candidate[:ba],samples['baseline'][:ba]) or not np.array_equal(candidate[ba+len(donor):],samples['baseline'][bb:]): raise ValueError('unchanged PCM proof failed')
    fullwav=args.out/'candidate-part4.wav'; wav(fullwav,candidate); encode(fullwav,args.out/'candidate-part4.mp3')
    left=max(0,ba-6*RATE); right=min(len(candidate),ba+len(donor)+15*RATE)
    review=args.out/'review-context.wav'; wav(review,candidate[left:right]); encode(review,args.out/'review-context.mp3')
    reviewed=transcribe(model,args.out/'review-context.mp3'); save(args.out/'review-words.json',reviewed)
    text=' '.join(w['norm'] for w in reviewed)
    if 'لا السياسة حاضرة بقوة' not in text: raise ValueError('re-encoded context lost the target phrase')
    # Subsequent EU sentence remains original PCM; its transcript is supporting
    # evidence, not an automatic substitute for production validation.
    manifest={'schema':'bareeq.audio-passports-retained-splice.v1','status':'review-candidate','providerCalls':0,'successfulTtsCalls':0,'publicationPerformed':False,'baselinePartSha256':BASE,'donorPartSha256':TRIAL,'bounds':bounds,'sampleRate':RATE,'changedOriginalRegionSeconds':[ba/RATE,bb/RATE],'insertedRegionSeconds':[ba/RATE,(ba+len(donor))/RATE],'prefixPcmIdentical':True,'suffixPcmIdentical':True,'reviewContextStartSeconds':left/RATE,'reviewTranscript':text,'outputs':{p.name:{'sha256':sha(p),'bytes':p.stat().st_size} for p in args.out.iterdir() if p.is_file()},'requires':['fresh full-file validation','technical QA','updated sync bound to new full SHA','publication approval gate']}
    save(args.out/'manifest.json',manifest)
    print(json.dumps({'status':manifest['status'],'providerCalls':0,'reviewTranscript':text},ensure_ascii=False))
if __name__=='__main__': main()
