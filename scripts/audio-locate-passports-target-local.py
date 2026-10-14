#!/usr/bin/env python3
import argparse, hashlib, html, json, re, shutil, subprocess, unicodedata
from pathlib import Path
from difflib import SequenceMatcher

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
    matches = [p for p in root.rglob("full.mp3") if p.as_posix().endswith(suffix)]
    if len(matches) != 1:
        raise RuntimeError("expected exactly one retained trial/full.mp3, found {}".format(len(matches)))
    return matches[0]

def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

def duration_seconds(ffmpeg, path):
    ffprobe = str(Path(ffmpeg).with_name("ffprobe"))
    result = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration",
                             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
                            check=True, capture_output=True, text=True)
    return float(result.stdout.strip())

def validate_location(transcript, spec):
    tokens = norm(transcript).split()
    positions=[]
    hits=[]
    for anchor in spec["anchors"]:
        forms={prefix+norm(anchor) for prefix in ("", "ل", "ب", "و", "ف")}
        matches=[i for i,t in enumerate(tokens) if t in forms]
        if matches:
            hits.append(anchor)
            positions.append(matches[0])
    rows = [{"norm": t} for t in tokens]
    match = best_window(rows, spec["phrase"])
    if len(hits) < 2 or not match or match["ratio"] < 0.65:
        raise RuntimeError("extracted clip did not verify the target location: {}".format(transcript))
    if positions != sorted(positions) or max(positions) - min(positions) > 10:
        raise RuntimeError("target anchors are not adjacent and ordered")
    return hits, match["ratio"]

def render_review(cases):
    rows=[]
    for c in cases:
        rows.append(
            '<section class="case"><h2>{}</h2><p><strong>{}</strong></p>'
            '<audio controls src="{}"></audio>'
            '<div class="proof"><strong>تفريغ آلي للتحقق من موضع العبارة، وليس حكمًا نهائيًا على النطق:</strong><br>{}</div></section>'.format(
                html.escape(c["caseId"]), html.escape(c["question"]),
                html.escape(c["clipFile"], quote=True), html.escape(c["validationTranscript"])
            )
        )
    template='''<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>بريق — مراجعة موضع مؤكدة</title>
<style>body{font-family:system-ui,Tahoma,sans-serif;max-width:820px;margin:auto;padding:24px;background:#f6f7f8}.case{background:#fff;border:1px solid #ddd;border-radius:14px;padding:18px;margin:16px 0}.proof{background:#eef7ee;padding:12px;border-radius:8px;line-height:1.8}audio{width:100%}</style>
<h1>مراجعة جوازات السفر</h1>
<p>حُدد موضع كل عبارة من التسجيل التجريبي نفسه وأعيد تفريغ المقطع محليًا. لم تُستخدم توقيتات sync. التفريغ يثبت موضع المراجعة؛ الحكم على «لا» و«الدول/دول» ما زال يحتاج الاستماع.</p>
<!-- CASES --></html>'''
    return template.replace("<!-- CASES -->", "".join(rows))

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

def run_self_tests():
    case={"caseId":"H01","question":"<test>","clipFile":"H01.mp3",
          "validationTranscript":"السياسة & حاضرة"}
    page=render_review([case])
    assert "body{font-family:" in page and "&lt;test&gt;" in page and "&amp;" in page
    for spec in TARGETS.values():
        hits,score=validate_location(spec["phrase"],spec)
        assert len(hits)==3 and score==1.0
    # The disputed words must not be forced by the locator.
    validate_location(TARGETS["H01"]["phrase"].removeprefix("لا "),TARGETS["H01"])
    validate_location(TARGETS["H02"]["phrase"].replace("الدول","دول"),TARGETS["H02"])
    for transcript in ("المصلحة الاقتصادية والسياحية", "السياسة حاضرة بقوة", "لا"):
        try:
            validate_location(transcript,TARGETS["H01"])
        except RuntimeError:
            pass
        else:
            raise RuntimeError("self-test: wrong/incomplete target was accepted")
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        root=Path(td)
        suffix=Path("audio-candidates/_diagnostics")/RUN_ID/ARTICLE/FP/"trial/full.mp3"
        for prefix in ("one","two"):
            p=root/prefix/suffix;p.parent.mkdir(parents=True);p.write_bytes(b"test")
        try:
            find_trial_full(root)
        except RuntimeError:
            pass
        else:
            raise RuntimeError("self-test: ambiguous source was accepted")
    print("LOCATOR_SELF_TESTS=PASS html-rendering wrong-location disputed-words source-ambiguity")

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--root",default="gate5-artifact")
    ap.add_argument("--out",default="local-asr-target-review")
    ap.add_argument("--model",default="small")
    ap.add_argument("--ffmpeg",default="ffmpeg")
    ap.add_argument("--self-test",action="store_true")
    args=ap.parse_args()
    run_self_tests()
    if args.self_test:
        return
    from faster_whisper import WhisperModel
    root=Path(args.root).resolve()
    out=Path(args.out).resolve()
    out.mkdir(parents=True,exist_ok=True)
    if any(out.iterdir()):
        raise RuntimeError("output directory must be empty; refuse stale review files")
    src=find_trial_full(root)
    source_sha=sha256(src)
    source_duration=duration_seconds(args.ffmpeg,src)

    model=WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=4)
    words, segments, info=transcribe(model,src)
    if len(words)<100:
        raise RuntimeError("too few timestamped words: {}".format(len(words)))

    cases=[]
    for case_id,spec in TARGETS.items():
        best=best_window(words,spec["phrase"])
        if not best or best["ratio"]<0.65:
            raise RuntimeError("{}: local-ASR locator confidence too low: {}".format(case_id,best))
        w0=words[best["i"]]
        w1=words[best["j"]-1]
        start=max(0,w0["start"]-8.0)
        end=min(source_duration,w1["end"]+12.0)
        if not 0 <= start < end <= source_duration:
            raise RuntimeError("invalid detected audio bounds")
        clip=out/("{}-VALIDATED.mp3".format(case_id))
        cut(args.ffmpeg,src,clip,start,end)
        transcript=clip_transcript(model,clip)
        anchor_hits,validation_similarity=validate_location(transcript,spec)
        actual_duration=duration_seconds(args.ffmpeg,clip)
        if abs(actual_duration-(end-start))>0.25:
            raise RuntimeError("extracted clip duration does not match requested bounds")
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
            "validationSimilarity":validation_similarity,
            "sourceAudioSha256":source_sha,
            "clipSha256":sha256(clip),
            "clipDurationSeconds":actual_duration,
            "articleId":ARTICLE,
            "fingerprint":FP,
            "pronunciationAdjudication":"PENDING_HUMAN_REVIEW",
            "source":"retained trial/full.mp3",
        })

    payload={
        "schema":"bareeq.audio-passports-local-asr-locator.v1",
        "sourceRunId":RUN_ID,
        "sourceAudio":"retained trial/full.mp3",
        "sourceAudioSha256":source_sha,
        "sourceDurationSeconds":source_duration,
        "articleId":ARTICLE,
        "fingerprint":FP,
        "locatorUsesSync":False,
        "localModel":args.model,
        "providerCalls":0,
        "ttsCalls":0,
        "newProviderAsrCalls":0,
        "timestampedWords":len(words),
        "cases":cases,
    }
    (out/"local-asr-segments.json").write_text(json.dumps(segments,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    (out/"local-asr-words.json").write_text(json.dumps(words,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    (out/"review.html").write_text(render_review(cases),encoding="utf-8")
    shutil.copyfile(src,out/"retained-trial-full.mp3")
    if sha256(src)!=source_sha or sha256(out/"retained-trial-full.mp3")!=source_sha:
        raise RuntimeError("retained source audio changed")
    (out/"README.txt").write_text("افتح review.html. لا تعتمد هذه الحزمة على sync؛ الموضع محدد من الصوت نفسه بواسطة faster-whisper محلي، ثم أُعيد فحص المقطع المستخرج قبل التسليم.\n",encoding="utf-8")
    # Publish the success marker only after both clips and the review page exist.
    (out/"manifest.json").write_text(json.dumps(payload,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print("LOCAL_ASR_LOCATOR=PASS " + " ".join("{}={:.3f}".format(c["caseId"],c["locatorSimilarity"]) for c in cases))

if __name__=="__main__":
    main()
