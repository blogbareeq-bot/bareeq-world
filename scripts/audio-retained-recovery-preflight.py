#!/usr/bin/env python3
"""Inspect retained audio only. Never call a speech provider or publish assets."""
import argparse, hashlib, json, shutil
from pathlib import Path

RUN = "37581607040"
PASSPORTS = "why-some-passports-are-stronger"
FP = "2a506ff4683cf450ecc63525868c1688a4c9a5dc8a231254d766bd7c79d58a5b"

def digest(p):
    with p.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()

def read(p):
    return json.loads(p.read_text(encoding="utf-8"))

def unique(root, suffix):
    matches = [p for p in root.rglob(Path(suffix).name) if p.as_posix().endswith(suffix)]
    if len(matches) != 1:
        raise RuntimeError(f"expected one {suffix}, found {len(matches)}")
    return matches[0]

def copy_metadata(source, target):
    target.mkdir(parents=True, exist_ok=True)
    for p in sorted(source.rglob("*.json")):
        if p.stat().st_size > 2_000_000:
            continue
        dest = target / p.relative_to(source)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(p, dest)

def inspect(root, repo, out):
    status = read(repo / "docs/audio/PROGRESSIVE-STATUS.json")
    pending = [r for r in status["rows"] if not r["publishedExact"]]
    exact = [r for r in status["rows"] if r["publishedExact"]]
    if len(status["rows"]) != 15 or len(exact) != 9 or len(pending) != 6:
        raise RuntimeError("canonical baseline changed: expected 9 exact and 6 pending")
    if out.exists() and any(out.iterdir()):
        raise RuntimeError("refuse existing output")
    out.mkdir(parents=True, exist_ok=True)
    rows = []
    for r in pending:
        suffix = f"audio-candidates/{r['articleId']}/{r['fingerprint']}/full.mp3"
        full = unique(root, suffix)
        if digest(full) != r["fullSha256"]:
            raise RuntimeError(f"baseline full SHA mismatch: {r['articleId']}")
        candidate = full.parent
        copy_metadata(candidate, out / "candidate-metadata" / r["audioKey"])
        variants = []
        for p in root.rglob("*.mp3"):
            if r["articleId"] in p.parts and r["fingerprint"] in p.parts:
                variants.append({"path":p.relative_to(root).as_posix(),
                                 "sha256":digest(p),"bytes":p.stat().st_size})
        rows.append({"articleId":r["articleId"],"title":r["title"],
                     "fingerprint":r["fingerprint"],"audioKey":r["audioKey"],
                     "baselineFullSha256":r["fullSha256"],
                     "retainedMp3Count":len(variants),"variants":variants,
                     "rawStatusCounts":{k:r[k] for k in ("substitutions","deletions","insertions","unresolved")},
                     "countsAreNotHumanDefectCounts":True})
    diag = unique(root, f"audio-candidates/_diagnostics/{RUN}/{PASSPORTS}/{FP}/metadata.json").parent
    parts = {}
    for kind in ("baseline", "trial"):
        checkpoint = read(diag / kind / "checkpoint.json")
        part = checkpoint["completedParts"]["3"]
        src = diag / kind / "parts" / Path(part["file"]).name
        actual = digest(src)
        if actual != part["sha256"]:
            raise RuntimeError(f"{kind} fourth-part SHA mismatch")
        if kind == "baseline" and actual != "09b0253960eb4d5c2da1c8af50ed0e87f373b7ca030d14c09d99533ad8e68ae4":
            raise RuntimeError("unexpected original baseline fourth part")
        dest = out / f"passports-{kind}-part4.mp3"
        shutil.copyfile(src, dest)
        parts[kind] = {"file":dest.name,"sha256":actual,"originalFile":part["file"]}
        copy_metadata(diag / kind / "reports", out / "passports-reports" / kind)
        shutil.copyfile(diag / kind / "checkpoint.json",out / f"passports-{kind}-checkpoint.json")
    shutil.copyfile(diag / "metadata.json", out / "passports-diagnostic-metadata.json")
    freeze = read(repo / "docs/audio/TTS-FREEZE.json")
    strategy = read(repo / "docs/audio/ENGINE-STRATEGY-STATE.json")
    result={"schema":"bareeq.audio-retained-recovery-preflight.v1","sourceRunId":RUN,
            "targetExact":15,"currentExact":9,"pending":rows,
            "protectedExactArticles":[{"articleId":r["articleId"],"fingerprint":r["fingerprint"],
                                       "fullSha256":r["fullSha256"]} for r in exact],
            "passportParts":parts,"ttsCalls":0,"providerAsrCalls":0,"publication":False,
            "ttsFreezeActive":freeze["active"],"strategyCounter":strategy["successfulTtsSinceLastNewExact"],
            "newSuccessfulTtsRequestsAuthorized":0}
    (out / "inventory.json").write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print("RETAINED_PREFLIGHT=PASS exact=9 pending=6 protected=9 tts=0 providerAsr=0 publication=false")
    for r in rows:
        print(f"RETAINED_AUDIO {r['articleId']} variants={r['retainedMp3Count']}")

def main():
    a=argparse.ArgumentParser();a.add_argument("--root",type=Path,required=True)
    a.add_argument("--repo",type=Path,default=Path.cwd());a.add_argument("--out",type=Path,required=True)
    args=a.parse_args();inspect(args.root.resolve(),args.repo.resolve(),args.out.resolve())

if __name__ == "__main__":
    main()
