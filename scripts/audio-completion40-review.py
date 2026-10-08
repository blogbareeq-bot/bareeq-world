import json,pathlib,hashlib,subprocess,re,unicodedata,sys,shutil
from difflib import SequenceMatcher
from faster_whisper import WhisperModel
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def norm(s):return re.sub(r'[^0-9\u0621-\u064a]','', ''.join(c for c in unicodedata.normalize('NFKD',s) if not unicodedata.combining(c)).replace('ى','ي').replace('ـ',''))
root=pathlib.Path(sys.argv[1]);j=json.loads((root/'review-input.json').read_text());model=WhisperModel('small',device='cpu',compute_type='int8',cpu_threads=4);rows=[]
for a in j['articles']:
 for p in a['parts']:
  source=root/p['sourceFile'];assert sha(source)==p['sourcePartSha256'];segs,_=model.transcribe(str(source),language='ar',beam_size=5,word_timestamps=True,vad_filter=False,condition_on_previous_text=False);words=[{'raw':w.word,'norm':norm(w.word),'start':w.start,'end':w.end} for s in segs for w in s.words or [] if norm(w.word)];expected=list(map(norm,p['expectedTokens']));actual=[w['norm'] for w in words];blocks=SequenceMatcher(None,expected,actual,autojunk=False).get_matching_blocks();(root/(p['sourceFile'].replace('.mp3','-words.json'))).write_text(json.dumps({'sourcePartSha256':p['sourcePartSha256'],'words':words},ensure_ascii=False,indent=2)+'\n')
  duration=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',str(source)]))
  for c in p['cases']:
   row={**c,'articleId':a['articleId'],'fingerprint':a['fingerprint'],'fullSha256':a['fullSha256'],'sourcePartSha256':p['sourcePartSha256'],'partIndex':p['partIndex'],'humanReviewPerformed':False}
   try:
    l=[(min(b.a+b.size,c['localStart']),b.b+min(b.size,c['localStart']-b.a)-1) for b in blocks if b.a<c['localStart'] and b.size>=2];r=[(max(b.a,c['localEnd']+1),b.b+max(0,c['localEnd']+1-b.a)) for b in blocks if b.a+b.size>c['localEnd']+1 and b.size>=2]
    left=max(l) if l else (0,0)
    # The bound source start/end can replace a missing flank only at that edge.
    right=min(r) if r else (len(expected),len(words)-1)
    if c['localStart']-left[0]>25 or right[0]-c['localEnd']>25:raise ValueError('No nearby retained-source flanks')
    wi=max(0,left[1]);wj=min(len(words)-1,right[1]);start=max(0,words[wi]['start']-4) if l else 0;end=min(duration,words[wj]['end']+4) if r else duration
    if not 4<end-start<45:raise ValueError('Needs separate broader context')
    clip=root/(c['caseId']+'-review.mp3');subprocess.run(['ffmpeg','-v','error','-y','-ss',str(start),'-i',str(source),'-t',str(end-start),'-ar','24000','-ac','1','-codec:a','libmp3lame','-q:a','2',str(clip)],check=True);row.update(status='READY_FOR_REVIEW',clipFile=clip.name,clipSha256=sha(clip),clipStartInPart=start,clipEndInPart=end,targetRegionInClip=[max(0,words[wi]['end']-start),words[wj]['start']-start],localTranscript=' '.join(w['raw'].strip() for w in words[wi:wj+1]))
   except Exception as e:
    # A whole immutable source part always includes the target. Do not issue an
    # incomplete clip or claim localization when the flanks cannot be verified.
    clip=root/(c['caseId']+'-review.mp3');shutil.copyfile(source,clip)
    row.update(status='READY_FOR_REVIEW',contextScope='whole-source-part',localizationWarning=str(e),clipFile=clip.name,clipSha256=sha(clip),clipStartInPart=0,clipEndInPart=duration,targetRegionInClip=None,localTranscript=' '.join(w['raw'].strip() for w in words))
   rows.append(row)
  print(a['articleId'],p['partIndex']+1,'local timing complete',flush=True)
(root/'review-manifest.json').write_text(json.dumps({**j,'schema':'bareeq.audio-completion40-final-review.v1' if j['schema']=='bareeq.audio-completion40-final-review-input.v1' else 'bareeq.audio-completion40-other-review.v1','cases':rows,'ttsCalls':0,'newAsrProviderCalls':0},ensure_ascii=False,indent=2)+'\n');print('SAVED_REVIEW cases='+str(len(rows)),flush=True)
