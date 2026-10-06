#!/usr/bin/env python3
import argparse, json, math, os, subprocess
from pathlib import Path

import numpy as np
import whisperx

ALIGN_MODEL = "jonatasgrosman/wav2vec2-large-xlsr-53-arabic"
SAMPLE_RATE = 16000

def percentile(values, q):
    vals=sorted(float(v) for v in values if v is not None and math.isfinite(float(v)))
    if not vals: return None
    pos=(len(vals)-1)*q
    lo=int(math.floor(pos)); hi=int(math.ceil(pos))
    if lo==hi: return vals[lo]
    return vals[lo]*(hi-pos)+vals[hi]*(pos-lo)

def words_from_result(result):
    if isinstance(result, dict) and isinstance(result.get("word_segments"), list):
        return result["word_segments"]
    out=[]
    for seg in (result.get("segments",[]) if isinstance(result,dict) else []):
        out.extend(seg.get("words",[]) or [])
    return out

def load_audio_16k(path):
    ffmpeg = os.environ.get("BAREEQ_FFMPEG")
    if not ffmpeg:
        raise RuntimeError("BAREEQ_FFMPEG is not set")
    if not os.path.isfile(ffmpeg) or not os.access(ffmpeg, os.X_OK):
        raise RuntimeError(f"approved ffmpeg binary is unavailable: {ffmpeg}")
    cmd = [
        ffmpeg, "-nostdin", "-threads", "0", "-i", str(path),
        "-f", "s16le", "-ac", "1", "-acodec", "pcm_s16le",
        "-ar", str(SAMPLE_RATE), "-"
    ]
    completed = subprocess.run(cmd, capture_output=True, check=True)
    audio=np.frombuffer(completed.stdout, np.int16).astype(np.float32) / 32768.0
    if audio.size < SAMPLE_RATE:
        raise RuntimeError(f"decoded audio is unexpectedly short: {audio.size} samples")
    return audio

def crop_audio(audio, start_ratio, end_ratio, pad_seconds=4.0, max_seconds=45.0):
    duration=len(audio)/SAMPLE_RATE
    start=max(0.0, float(start_ratio)*duration-pad_seconds)
    end=min(duration, float(end_ratio)*duration+pad_seconds)
    if end-start > max_seconds:
        center=(start+end)/2
        start=max(0.0, center-max_seconds/2)
        end=min(duration, start+max_seconds)
        start=max(0.0, end-max_seconds)
    s=int(start*SAMPLE_RATE); e=int(end*SAMPLE_RATE)
    return audio[s:e], start, end

def align_text(model, metadata, audio, text):
    duration=len(audio)/SAMPLE_RATE
    segments=[{"start":0.0,"end":duration,"text":text}]
    result=whisperx.align(
        segments, model, metadata, audio, "cpu",
        interpolate_method="ignore",
        return_char_alignments=True,
        print_progress=False,
    )
    words=words_from_result(result)
    aligned=[w for w in words if w.get("start") is not None and w.get("end") is not None]
    scored=[float(w["score"]) for w in words if w.get("score") is not None]
    return {
        "words":words,
        "coverage":len(aligned)/max(1,len(text.split())),
        "scores":scored,
        "meanScore":float(np.mean(scored)) if scored else None,
    }

def word_at(result,index):
    words=result["words"]
    if index < 0 or index >= len(words): return None
    return words[index]

def load_model():
    return whisperx.load_align_model(
        language_code="ar",
        device="cpu",
        model_name=ALIGN_MODEL,
    )

def smoke(manifest, out_path):
    entries=manifest.get("entries") or []
    if len(entries) != 4:
        raise RuntimeError(f"expected 4 pilot entries, found {len(entries)}")
    import torch, torchvision, torchaudio
    model, metadata=load_model()
    audio=load_audio_16k(entries[0]["audioPath"])
    result={
        "schema":"bareeq.audio-gate4-smoke.v1",
        "ffmpeg":os.environ.get("BAREEQ_FFMPEG"),
        "torch":torch.__version__,
        "torchvision":torchvision.__version__,
        "torchaudio":torchaudio.__version__,
        "whisperx":"3.8.6",
        "alignmentModel":ALIGN_MODEL,
        "alignmentModelLoaded":model is not None and metadata is not None,
        "mp3Decoded":len(audio) >= SAMPLE_RATE,
        "decodedSeconds":round(len(audio)/SAMPLE_RATE,3),
        "entries":len(entries),
        "pass":True,
    }
    Path(out_path).write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(f"GATE4_SMOKE=PASS ffmpeg={result['ffmpeg']} modelLoaded=true decodedSeconds={result['decodedSeconds']}")
    return result

def scientific(manifest, out_path):
    model, metadata = load_model()

    results=[]
    positive_scores=[]
    for entry in manifest["entries"]:
        audio=load_audio_16k(entry["audioPath"])
        clip, clip_start, clip_end=crop_audio(audio,entry["startRatio"],entry["endRatio"])
        original=align_text(model,metadata,clip,entry["verificationText"])
        positive_scores.extend(original["scores"])
        row={
            "role":entry["role"],
            "articleId":entry["articleId"],
            "title":entry["title"],
            "fingerprint":entry["fingerprint"],
            "partIndex":entry["partIndex"],
            "clipStartSeconds":round(clip_start,3),
            "clipEndSeconds":round(clip_end,3),
            "coverage":round(original["coverage"],4),
            "meanScore":round(original["meanScore"],4) if original["meanScore"] is not None else None,
            "wordCount":len(original["words"]),
        }
        if entry["role"]=="exact-control":
            neg=align_text(model,metadata,clip,entry["negativeControl"]["text"])
            idx=int(entry["negativeControl"]["index"])
            pos_word=word_at(original,idx) or {}
            neg_word=word_at(neg,idx) or {}
            pos_score=pos_word.get("score")
            neg_score=neg_word.get("score")
            degradation=None
            if pos_score is not None and neg_score is not None:
                degradation=float(pos_score)-float(neg_score)
            detected=(neg_word.get("start") is None or neg_word.get("end") is None or (degradation is not None and degradation >= 0.15))
            row["negativeControl"]={
                "index":idx,
                "original":entry["negativeControl"]["original"],
                "replacement":entry["negativeControl"]["replacement"],
                "positiveScore":pos_score,
                "negativeScore":neg_score,
                "degradation":round(degradation,4) if degradation is not None else None,
                "detected":bool(detected),
            }
        else:
            idx=int(entry["targetWordIndex"])
            target=word_at(original,idx) or {}
            row["target"]={
                "index":idx,
                "expectedWord":entry.get("expectedWord"),
                "start":target.get("start"),
                "end":target.get("end"),
                "score":target.get("score"),
                "localized":target.get("start") is not None and target.get("end") is not None,
                "baselineError":entry.get("baselineError"),
            }
        results.append(row)

    exact=[r for r in results if r["role"]=="exact-control"]
    pending=[r for r in results if r["role"]=="one-error-pending"]
    low=percentile(positive_scores,0.05)
    for row in pending:
        score=row["target"].get("score")
        if not row["target"]["localized"]:
            row["diagnostic"]="UNLOCATED"
        elif score is not None and low is not None and float(score) < float(low):
            row["diagnostic"]="AUDIO_ERROR_CANDIDATE"
        else:
            row["diagnostic"]="VALIDATOR_AMBIGUITY"

    criteria={
        "exactCount":len(exact)==2,
        "pendingCount":len(pending)==2,
        "exactCoverage":all(r["coverage"]>=0.95 for r in exact),
        "negativeControls":all(r.get("negativeControl",{}).get("detected") is True for r in exact),
        "pendingLocalized":all(r.get("target",{}).get("localized") is True for r in pending),
    }
    passed=all(criteria.values())
    report={
        "schema":"bareeq.audio-gate4-whisperx-pilot.v1",
        "alignmentModel":ALIGN_MODEL,
        "whisperxVersion":"3.8.6",
        "positiveScoreP05":round(low,4) if low is not None else None,
        "criteria":criteria,
        "pilotPass":passed,
        "results":results,
        "ttsCalls":0,
        "paidApiCalls":0,
        "productionMutation":False,
    }
    Path(out_path).write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(f"GATE4_WHISPERX_PILOT pass={str(passed).lower()} exact={len(exact)} pending={len(pending)} p05={report['positiveScoreP05']} ttsCalls=0 paidApiCalls=0")
    if not passed:
        raise SystemExit(2)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--manifest",required=True)
    ap.add_argument("--out",required=True)
    ap.add_argument("--smoke-only",action="store_true")
    args=ap.parse_args()
    manifest=json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    Path(args.out).parent.mkdir(parents=True,exist_ok=True)
    if args.smoke_only:
        smoke(manifest,args.out)
    else:
        scientific(manifest,args.out)

if __name__=="__main__":
    main()
