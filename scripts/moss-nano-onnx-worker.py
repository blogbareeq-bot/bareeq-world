#!/usr/bin/env python3
import base64, json, os, pathlib, subprocess, sys, tempfile

request=json.loads(sys.stdin.read())
if request.get("engine")!="moss-nano":
    raise SystemExit("unexpected engine")
expected_model=os.environ.get("BAREEQ_TTS_MODEL_REVISION","")
expected_worker=os.environ.get("BAREEQ_TTS_WORKER_REVISION","")
audit=request.get("audit") or {}
if audit.get("modelRevision")!=expected_model or audit.get("workerRevision")!=expected_worker:
    raise SystemExit("revision mismatch")
home=pathlib.Path(os.environ["MOSS_NANO_HOME"]).resolve()
out=pathlib.Path(tempfile.mkstemp(suffix=".wav")[1])
cmd=[
    sys.executable, str(home/"infer_onnx.py"),
    "--text", str(request.get("text") or ""),
    "--voice", os.environ.get("MOSS_NANO_VOICE","Junhao"),
    "--output-audio-path", str(out),
    "--execution-provider", "cpu",
    "--cpu-threads", os.environ.get("MOSS_NANO_CPU_THREADS","4"),
    "--disable-wetext-processing",
    "--seed", "42",
]
run=subprocess.run(cmd,cwd=home,capture_output=True,text=True,timeout=840)
if run.returncode!=0:
    sys.stderr.write(run.stderr[-4000:])
    raise SystemExit(run.returncode)
audio=out.read_bytes()
out.unlink(missing_ok=True)
payload={
    "engine": request["engine"],
    "model": request["model"],
    "voiceId": request["voice"]["id"],
    "modelRevision": expected_model,
    "workerRevision": expected_worker,
    "mimeType": "audio/wav",
    "audioBase64": base64.b64encode(audio).decode("ascii"),
    "metadata": {"backend":"official-moss-nano-onnx-cpu","seed":42},
}
sys.stdout.write(json.dumps(payload,separators=(",",":")))
