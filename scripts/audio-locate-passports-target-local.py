#!/usr/bin/env python3
import argparse, json, re, subprocess, unicodedata
from pathlib import Path
from difflib import SequenceMatcher
from faster_whisper import WhisperModel

RUN_ID="37581607040"
ARTICLE="why-some-passports-are-stronger"
FP="2a506ff4683cf450ecc63525868c1688a4c9a5dc8a231254d766bd7c79d58a5b"

TARGETS = {
    "H01": {
        "phrase": "لا السياسة حاضرة بقوة لكنها خيط واحد في نسيج أوسع يشمل الاقتصاد والأمن والهجرة والسياحة والتجارة",
        "anchors": ["السياسة","حاضرة","بقوة"],
        "question": "هل تسمع «لا. السياسة حاضرة بقوة…»؟"
    },
    "H02": {
        "phrase": "تتيح لمواطني الدول الأعضاء التنقل والإقامة والعمل داخل دول الاتحاد",
        "anchors": ["مواطني","الأعضاء","التنقل"],
        "question": "في عبارة «مواطني الدول الأعضاء»، هل تسمع «الدول» أم «دول»؟"
    },
}

DIACRITICS = re.compile(r"[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]")
NON_AR = re.compile(r"[^0-9A-Za-z\u0600-\u06FF]+")

def norm(s):
    s = unicodedata.normalize("NFKC", s or "")
    s = DIACRITICS.sub("", s)
    s = (s.replace("أ","ا").replace("إ","ا").replace("آ","ا")
           .replace("ى","ي").replace("ؤ","و").replace("ئ","ي"))
    s = NON_AR.sub(" ", s)
    return " ".join(s.split()).strip().lower()

def find_trial_full(root):
    suffix = "audio-candidates/_diagnostics/{}/{}/{}/trial/full.mp3".format(RUN_ID, ARTICLE, FP)
    for p in root.rglob("full.mp3"):
        if str(p).replace("\\","/").endswith(suffix):
            return p
    raise FileNotFoundError("retained trial/full.mp3 not found")

def transcribe(model, audio):
    segments, info = model.transcribe(
        str(audio), language="ar", beam_size=5, vad_filter=True,
        word_timestamps=True, condition_on_previous_text=True,
    )
    words=[]
    segment_rows=[]
    for seg in segments:
        segment_rows.append({"start":seg.start,"end":seg.end,"text":seg.text})
        for w in (seg.words or []):
            if w.start is None or w.end is None:
                continue
            t=norm(w.word)
            if t:
                words.append({"start":float(w.start),"end":float(w.end),"raw":w.word,"norm":t})
    return words, segment_rows, info

def best_window(words, phrase):
    target = norm(phrase).split()
    flat=[w["norm"] for w in words]
    best=None
    lo=max(4,len(target)-5); hi=len(target)+7
    for n in range(lo,hi+1):
        for i in range(0,max(0,len(flat)-n+1)):
            cand=flat[i:i+n]
            ratio=SequenceMatcher(None,target,cand).ratio()
            if best is None or ratio>best["ratio"]:
                best={"ratio":ratio,"i":i,"j":i+n,"tokens":cand}
    return best

def cut(ffmpeg, src, dst, start, end):
    duration=max(1.0,end-start)
    subprocess.run([
        ffmpeg,"-hide_banner","-loglevel","error","-y",
        "-ss","{:.3f}".format(start),"-i",str(src),"-t","{:.3f}".format(duration),
        "-vn","-ac","1","-ar","24000","-codec:a","libmp3lame","-q:a","2",str(dst)
    ],check=True)

def clip_transcript(model, clip):
    segs, _ = model.transcribe(str(clip), language="ar", beam_size=5, vad_filter=True)
    return " ".join(s.text.strip() for s in segs if s.text and s.text.strip()).strip()

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--root",default="gate5-artifact")
    ap.add_argument("--out",default="local-asr-target-review")
    ap.add_argument("--model",default="small")
    ap.add_argument("--ffmpeg",default="ffmpeg")
    args=ap.parse_args()
    root=Path(args.root).resolve()
    out=Path(args.out).resolve()
    out.mkdir(parents=True,exist_ok=True)
    src=find_trial_full(root)

    model=WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=4)
    words, segments, info=transcribe(model,src)
    if len(words)<100:
        raise RuntimeError("too few timestamped words: {}".format(len(words)))

    cases=[]
    for case_id,spec in TARGETS.items():
        best=best_window(words,spec["phrase"])
        if not best or best["ratio"]<0.48:
            raise RuntimeError("{}: local-ASR locator confidence too low: {}".format(case_id,best))
        w0=words[best["i"]]
        w1=words[best["j"]-1]
        start=max(0,w0["start"]-8.0)
        end=w1["end"]+12.0
        clip=out/("{}-VALIDATED.mp3".format(case_id))
        cut(args.ffmpeg,src,clip,start,end)
        transcript=clip_transcript(model,clip)
        nt=norm(transcript)
        anchor_hits=[a for a in spec["anchors"] if norm(a) in nt]
        if len(anchor_hits)<2:
            raise RuntimeError("{}: validation transcript missed target anchors; transcript={}".format(case_id,transcript))
        if all(norm(x) in nt for x in ["المصلحة","الاقتصادية","السياحية"]) and not any(norm(a) in nt for a in spec["anchors"]):
            raise RuntimeError("{}: extracted the known wrong location".format(case_id))
        cases.append({
            "caseId":case_id,
            "question":spec["question"],
            "targetPhrase":spec["phrase"],
            "locatorSimilarity":best["ratio"],
            "clipFile":clip.name,
            "clipStartSeconds":start,
            "clipEndSeconds":end,
            "locatorTokens":" ".join(best["tokens"]),
            "validationTranscript":transcript,
            "anchorHits":anchor_hits,
            "source":"retained trial/full.mp3",
        })

    payload={
        "schema":"bareeq.audio-passports-local-asr-locator.v1",
        "sourceRunId":RUN_ID,
        "sourceAudio":"retained trial/full.mp3",
        "localModel":args.model,
        "providerCalls":0,
        "ttsCalls":0,
        "newProviderAsrCalls":0,
        "timestampedWords":len(words),
        "cases":cases,
    }
    (out/"manifest.json").write_text(json.dumps(payload,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    (out/"local-asr-segments.json").write_text(json.dumps(segments,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")

    rows=[]
    for c in cases:
        rows.append(
            '<section class="case"><h2>{}</h2><p><strong>{}</strong></p>'
            '<audio controls src="{}"></audio>'
            '<div class="proof"><strong>النص الذي أعاد ASR المحلي سماعه من هذا المقطع:</strong><br>{}<br>'
            '<strong>Anchors:</strong> {}</div></section>'.format(
                c["caseId"], c["question"], c["clipFile"],
                c["validationTranscript"], "، ".join(c["anchorHits"])
            )
        )
    html='''<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>بريق — مراجعة موضع مؤكدة</title>
<style>body{font-family:system-ui,Tahoma,sans-serif;max-width:820px;margin:auto;padding:24px;background:#f6f7f8}.case{background:#fff;border:1px solid #ddd;border-radius:14px;padding:18px;margin:16px 0}.proof{background:#eef7ee;padding:12px;border-radius:8px;line-height:1.8}audio{width:100%}</style>
<h1>مراجعة جوازات السفر — موضع محدد بالصوت نفسه</h1>
<p>هذه المقاطع لم تعتمد على sync المحفوظ. تم تحديد موضعها بواسطة ASR محلي على trial/full.mp3 ثم إعادة فحص المقطع المستخرج محليًا قبل إدراجه هنا.</p>
{}</html>'''.format("".join(rows))
    (out/"review.html").write_text(html,encoding="utf-8")
    (out/"README.txt").write_text("افتح review.html. لا تعتمد هذه الحزمة على sync؛ الموضع محدد من الصوت نفسه بواسطة faster-whisper محلي، ثم أُعيد فحص المقطع المستخرج قبل التسليم.\n",encoding="utf-8")
    print("LOCAL_ASR_LOCATOR=PASS " + " ".join("{}={:.3f}".format(c["caseId"],c["locatorSimilarity"]) for c in cases))

if __name__=="__main__":
    main()
