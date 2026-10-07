import pathlib,json,hashlib,subprocess,re,unicodedata
import numpy as np
from difflib import SequenceMatcher
RATE=48000;root=pathlib.Path('remaining-review');out=pathlib.Path('donor15-result');j=json.loads((root/'review-manifest.json').read_text());touch=next(a for a in j['articles'] if a['articleId']=='how-touchscreens-work');cache={};rows=[]
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def norm(s):return re.sub(r'[^0-9\u0621-\u064a]','', ''.join(c for c in unicodedata.normalize('NFKD',s) if not unicodedata.combining(c)).replace('ى','ي').replace('ـ',''))
def literal(s):return re.sub(r'[^\u0621-\u064a]','', ''.join(c for c in unicodedata.normalize('NFC',s) if not unicodedata.combining(c)))
def load(p):
 if p['partIndex'] not in cache:
  source=pathlib.Path('donor15-working')/p['sourceFile'];assert sha(source)==p['sourcePartSha256'];w=json.loads((root/p['sourceFile'].replace('.mp3','-words.json')).read_text());assert w['sourcePartSha256']==p['sourcePartSha256'];x=np.frombuffer(subprocess.check_output(['ffmpeg','-v','error','-i',str(source),'-f','s16le','-ac','1','-ar',str(RATE),'-']),dtype='<i2').copy();cache[p['partIndex']]=(x,w['words'])
 return cache[p['partIndex']]
def quiet(x,before,after):
 lo=max(0,round((before['end']-.12)*RATE));hi=min(len(x),round((after['start']+.04)*RATE));mid=round((before['end']+after['start'])/2*RATE);h=round(.02*RATE);choices=[]
 for n in range(lo+h,hi-h,240):
  a=x[n-h:n+h].astype(float)/32768;rms=np.sqrt(np.mean(a*a));peak=np.max(abs(a))
  if rms<10**(-42/20) and peak<10**(-30/20):choices.append((abs(n-mid),n))
 if not choices:raise ValueError('No quiet boundary preserving complete adjacent words')
 return min(choices)[1]
for p in touch['parts']:
 x,w=load(p);e=list(map(norm,p['expectedTokens']));a=[z['norm'] for z in w];blocks=SequenceMatcher(None,e,a,autojunk=False).get_matching_blocks()
 for c in p['cases']:
  row={'caseId':c['caseId'],'articleId':touch['articleId'],'fingerprint':touch['fingerprint'],'baselineFullSha256':touch['baselineFullSha256'],'targetExpected':c['issues'][0]['expected'],'partIndex':p['partIndex'],'sourcePartSha256':p['sourcePartSha256']}
  try:
   start,end=c['localStart'],c['localEnd'];left=[(min(b.a+b.size,start),b.b+min(b.size,start-b.a)-1) for b in blocks if b.a<=start-3 and min(b.a+b.size,start)>=start-25];right=[(max(b.a,end+1),b.b+max(0,end+1-b.a)) for b in blocks if b.a+b.size>=end+4 and max(b.a,end+1)<=end+25];l=max(left);r=min(right)
   if l[0]!=start or r[0]!=end+1 or r[1]!=l[1]+2:raise ValueError('Uncertain single-word target localization')
   wi=l[1]+1;ta=quiet(x,w[wi-1],w[wi]);tb=quiet(x,w[wi],w[wi+1]);safe=[];rejected=[]
   for donor in j['touchscreenDonorCandidates']:
    if donor['token']!=row['targetExpected'] or literal(donor['word']['raw'])!=row['targetExpected']:continue
    dp=next(t for t in touch['parts'] if t['partIndex']==donor['partIndex']);dx,dw=load(dp);di=donor['actualWordIndex']
    try:
     da=quiet(dx,dw[di-1],dw[di]);db=quiet(dx,dw[di],dw[di+1]);ratio=(db-da)/(tb-ta)
     if not .5<=ratio<=2:raise ValueError('Donor timing incompatible')
     safe.append({**donor,'donorCutSamples':[da,db],'targetCutSamples':[ta,tb],'durationRatio':ratio,'status':'WORD_BOUNDARIES_VERIFIED_REQUIRES_REVIEW_AND_QA'})
    except Exception as ex:rejected.append({'partIndex':donor['partIndex'],'actualWordIndex':di,'reason':str(ex)})
   row.update(status='SAFE_DONOR_AVAILABLE' if safe else 'NO_SAFE_RETAINED_DONOR',targetCutSamples=[ta,tb],safeDonors=safe,rejectedDonors=rejected)
  except Exception as ex:row.update(status='NO_SAFE_TARGET_CUT',reason=str(ex))
  rows.append(row)
# Complete the missing end-of-part morning review context using its actual final word.
c=next(c for c in j['cases'] if c['caseId']=='M12');a=next(a for a in j['articles'] if a['articleId']==c['articleId']);p=next(p for p in a['parts'] if p['partIndex']==c['partIndex']);w=json.loads((root/c['wordFile']).read_text());assert w['sourcePartSha256']==p['sourcePartSha256'];source=pathlib.Path('donor15-working')/p['sourceFile'];assert sha(source)==p['sourcePartSha256'];assert c['localEnd']==len(p['expectedTokens'])-1 and w['words'][-1]['norm']=='فيه';start=max(0,w['words'][-1]['start']-5);end=w['words'][-1]['end']+1;clip=out/'M12-review.mp3';subprocess.run(['ffmpeg','-v','error','-y','-ss',str(start),'-i',str(source),'-t',str(end-start),'-ac','1','-ar','24000','-codec:a','libmp3lame','-q:a','2',str(clip)],check=True)
result={'schema':'bareeq.audio-completion15-retained-donor-preflight.v1','ttsCalls':0,'providerCalls':0,'publicationPerformed':False,'targets':rows,'M12':{**c,'status':'READY_FOR_LISTENING','clipFile':clip.name,'clipSha256':sha(clip),'clipStartInPart':start,'clipDuration':end-start,'humanReviewPerformed':False,'reason':None}};(out/'preflight-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps([{k:r[k] for k in ['caseId','status']} for r in rows],ensure_ascii=False));print('M12_END_OF_PART_CLIP=VERIFIED tts=0')
