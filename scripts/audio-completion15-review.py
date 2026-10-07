import json,pathlib,hashlib,subprocess,re,unicodedata,html
from difflib import SequenceMatcher
from faster_whisper import WhisperModel
root=pathlib.Path('remaining15-review');j=json.loads((root/'review-input.json').read_text());model=WhisperModel('small',device='cpu',compute_type='int8',cpu_threads=4);rows=[];donors=[]
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def norm(s):return re.sub(r'[^0-9\u0621-\u064a]','', ''.join(c for c in unicodedata.normalize('NFKD',s) if not unicodedata.combining(c)).replace('ى','ي').replace('ـ',''))
for a in j['articles']:
 for p in a['parts']:
  source=root/'working'/p['sourceFile'];assert sha(source)==p['sourcePartSha256'];segs,_=model.transcribe(str(source),language='ar',beam_size=5,word_timestamps=True,vad_filter=False,condition_on_previous_text=False);words=[{'raw':w.word,'norm':norm(w.word),'start':w.start,'end':w.end} for s in segs for w in s.words or [] if norm(w.word)];actual=[w['norm'] for w in words];expected=list(map(norm,p['expectedTokens']));blocks=SequenceMatcher(None,expected,actual,autojunk=False).get_matching_blocks();wordFile=p['sourceFile'].replace('.mp3','-words.json');(root/wordFile).write_text(json.dumps({'sourcePartSha256':p['sourcePartSha256'],'partIndex':p['partIndex'],'words':words},ensure_ascii=False,indent=2)+'\n')
  if a['articleId']=='how-touchscreens-work':
   for token in ['الشاشة','إنه','به']:
    n=norm(token)
    for block in blocks:
     for k in range(block.size):
      ei=block.a+k;ai=block.b+k
      if expected[ei]==n and all(not c['localStart']<=ei<=c['localEnd'] for c in p['cases']):donors.append({'token':token,'partIndex':p['partIndex'],'sourcePartSha256':p['sourcePartSha256'],'expectedIndexInPart':ei,'actualWordIndex':ai,'word':words[ai]})
  for c in p['cases']:
   row={**c,'articleId':a['articleId'],'fingerprint':a['fingerprint'],'baselineFullSha256':a['baselineFullSha256'],'sourcePartSha256':p['sourcePartSha256'],'partIndex':p['partIndex'],'wordFile':wordFile,'humanReviewPerformed':False}
   try:
    l=[(min(b.a+b.size,c['localStart']),b.b+min(b.size,c['localStart']-b.a)-1) for b in blocks if b.a<c['localStart'] and b.size>=2];r=[(max(b.a,c['localEnd']+1),b.b+max(0,c['localEnd']+1-b.a)) for b in blocks if b.a+b.size>c['localEnd']+1 and b.size>=2]
    left=max(l);right=min(r)
    if c['localStart']-left[0]>35 or right[0]-c['localEnd']>35:raise ValueError('No nearby source-bound flanks')
    wi=max(0,left[1]);wj=min(len(words)-1,right[1]);start=max(0,words[wi]['start']-5);end=words[wj]['end']+5
    if not 5<end-start<45:raise ValueError('Review context is not localized')
    clip=root/(c['caseId']+'-review.mp3');subprocess.run(['ffmpeg','-v','error','-y','-ss',str(start),'-i',str(source),'-t',str(end-start),'-ar','24000','-ac','1','-codec:a','libmp3lame','-q:a','2',str(clip)],check=True)
    row.update(status='READY_FOR_LISTENING',clipFile=clip.name,clipSha256=sha(clip),clipStartInPart=start,clipDuration=end-start,localContextTranscript=' '.join(w['raw'].strip() for w in words[max(0,wi-3):min(len(words),wj+4)]),targetRegionSeconds=[max(0,words[wi]['end']-start),words[wj]['start']-start])
   except Exception as e:row.update(status='NEEDS_BROADER_LOCALIZATION',reason=str(e))
   rows.append(row)
  print(a['articleId'],p['partIndex']+1,'words',len(words),flush=True)
manifest={**j,'schema':'bareeq.audio-completion15-review.v1','cases':rows,'touchscreenDonorCandidates':donors,'ttsCalls':0,'providerCalls':0,'publicationPerformed':False};(root/'review-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n');cards=[]
for c in rows:
 expected=' '.join(str(x.get('expected','')) for x in c['issues']);audio=f'<audio controls preload="none" src="{c["clipFile"]}"></audio>' if c.get('clipFile') else '<p>يتطلب سياقًا أوسع.</p>'
 cards.append(f'<article><h2>{c["caseId"]} · {html.escape(expected)}</h2><p>{html.escape(c["approvedSegment"]["text"])}</p>{audio}<p>الفصل {c["partIndex"]+1} — {"خلل سبق تأكيده" if c["humanConfirmed"] else "ملاحظة آلية تحتاج الاستماع"}</p></article>')
(root/'review.html').write_text('<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>مراجعة المقالين المتبقيين</title><style>body{max-width:900px;margin:40px auto;font:20px/1.8 system-ui;background:#fbf8f1;color:#18312f}article{padding:24px;margin:24px 0;background:white;border:1px solid #dedbd2;border-radius:16px}audio{width:100%}h2{font-size:23px}</style><h1>مراجعة المقالين المتبقيين</h1><p>هذه مقاطع من التسجيل الأصلي. لم تُولد أصوات جديدة، ولم تُعتمد نتائج الاستماع بعد. النص الظاهر هو النص المعتمد للمقارنة.</p>'+''.join(cards)+'</html>');print('REMAINING15_REVIEW=COMPLETE cases='+str(len(rows))+' donorCandidates='+str(len(donors)),flush=True)
