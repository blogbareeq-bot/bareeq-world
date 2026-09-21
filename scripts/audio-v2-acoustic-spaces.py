from __future__ import annotations

import argparse
import json
import shutil
import time
import traceback
from pathlib import Path
from typing import Any

from gradio_client import Client

VOX_SPACE = "openbmb/VoxCPM-Demo"
MOSS_SPACE = "OpenMOSS-Team/MOSS-TTS-v1.5"

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate read-only Bareeq acoustic trial samples from public model Spaces.")
    parser.add_argument("--dir", default="audio-acoustic-trials")
    parser.add_argument("--retries", type=int, default=3)
    return parser.parse_args()

def safe_api(client: Client) -> Any:
    try:
        return client.view_api(return_format="dict")
    except Exception as exc:
        return {"error": type(exc).__name__, "message": str(exc)[:500]}

def find_local_audio(value: Any) -> Path | None:
    if isinstance(value, (str, Path)):
        candidate = Path(str(value))
        if candidate.is_file():
            return candidate
        return None
    if isinstance(value, dict):
        for key in ("path", "name", "file", "audio", "value"):
            if key in value:
                found = find_local_audio(value[key])
                if found:
                    return found
        for nested in value.values():
            found = find_local_audio(nested)
            if found:
                return found
        return None
    if isinstance(value, (list, tuple)):
        for nested in value:
            found = find_local_audio(nested)
            if found:
                return found
    return None

def copy_result(result: Any, target_stem: Path) -> Path:
    source = find_local_audio(result)
    if source is None:
        raise RuntimeError(f"Gradio result did not contain a downloaded audio file: {type(result).__name__}")
    suffix = source.suffix.lower()
    if suffix not in {".wav", ".mp3", ".flac", ".ogg", ".m4a"}:
        suffix = ".bin"
    target = target_stem.with_suffix(suffix)
    shutil.copy2(source, target)
    return target

def call_with_retry(label: str, fn, retries: int) -> tuple[Any | None, dict[str, Any]]:
    errors: list[dict[str, Any]] = []
    started = time.monotonic()
    for attempt in range(1, max(1, retries) + 1):
        try:
            result = fn()
            return result, {
                "status": "generated",
                "attempts": attempt,
                "elapsedSeconds": round(time.monotonic() - started, 3),
                "errors": errors,
            }
        except Exception as exc:
            errors.append({
                "attempt": attempt,
                "type": type(exc).__name__,
                "message": str(exc)[:1200],
            })
            if attempt < retries:
                time.sleep(min(45, 12 * attempt))
    return None, {
        "status": "failed",
        "attempts": max(1, retries),
        "elapsedSeconds": round(time.monotonic() - started, 3),
        "errors": errors,
    }

def generate_vox(client: Client, text: str, retries: int):
    control = (
        "Mature warm professional Modern Standard Arabic narrator; calm medium pace; "
        "clear articulation; natural, non-theatrical, non-advertising delivery."
    )
    return call_with_retry(
        "voxcpm2",
        lambda: client.predict(
            text,
            control,
            None,
            False,
            "",
            2.0,
            False,
            False,
            api_name="/generate",
        ),
        retries,
    )

def generate_moss(client: Client, text: str, retries: int):
    # Current official Space function signature includes four State inputs after
    # the visible sampling controls. Keep all values explicit for reproducibility.
    return call_with_retry(
        "moss-v15",
        lambda: client.predict(
            text,
            None,
            "Clone",
            False,
            1,
            "Arabic",
            1.7,
            0.8,
            25,
            1.0,
            "OpenMOSS-Team/MOSS-TTS-v1.5",
            "cuda:0",
            "auto",
            1536,
            api_name="/run_inference",
        ),
        retries,
    )

def main() -> int:
    args = parse_args()
    root = Path(args.dir).resolve()
    trial_file = root / "trial-cases.json"
    trial = json.loads(trial_file.read_text(encoding="utf-8"))
    status: dict[str, Any] = {
        "schema": "bareeq.audio-acoustic-space-generation.v1",
        "generatedAtEpoch": int(time.time()),
        "spaces": {},
        "cases": [],
        "publicationAttempted": False,
    }

    clients: dict[str, Client | None] = {"voxcpm2": None, "moss-v15": None}
    for engine, space in (("voxcpm2", VOX_SPACE), ("moss-v15", MOSS_SPACE)):
        try:
            client = Client(space, verbose=False)
            clients[engine] = client
            status["spaces"][engine] = {"space": space, "api": safe_api(client), "status": "connected"}
        except Exception as exc:
            status["spaces"][engine] = {
                "space": space,
                "status": "connection-failed",
                "error": f"{type(exc).__name__}: {str(exc)[:1000]}",
            }

    for case in trial["cases"]:
        case_dir = root / case["caseId"]
        text = (case_dir / "expected.txt").read_text(encoding="utf-8").strip()
        row: dict[str, Any] = {"caseId": case["caseId"], "engines": {}}

        vox = clients["voxcpm2"]
        if vox is not None:
            result, meta = generate_vox(vox, text, args.retries)
            if result is not None:
                try:
                    saved = copy_result(result, case_dir / "raw-voxcpm2")
                    meta["file"] = str(saved.relative_to(root))
                except Exception as exc:
                    meta["status"] = "failed"
                    meta.setdefault("errors", []).append({"type": type(exc).__name__, "message": str(exc)[:1200]})
            row["engines"]["voxcpm2"] = meta
        else:
            row["engines"]["voxcpm2"] = {"status": "not-connected"}

        moss = clients["moss-v15"]
        if moss is not None:
            result, meta = generate_moss(moss, text, args.retries)
            if result is not None:
                try:
                    saved = copy_result(result, case_dir / "raw-moss-v15")
                    meta["file"] = str(saved.relative_to(root))
                except Exception as exc:
                    meta["status"] = "failed"
                    meta.setdefault("errors", []).append({"type": type(exc).__name__, "message": str(exc)[:1200]})
            row["engines"]["moss-v15"] = meta
        else:
            row["engines"]["moss-v15"] = {"status": "not-connected"}

        status["cases"].append(row)
        (root / "spaces-status.json").write_text(json.dumps(status, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    generated = sum(
        1
        for row in status["cases"]
        for meta in row["engines"].values()
        if meta.get("status") == "generated"
    )
    status["generatedCandidateSamples"] = generated
    status["expectedCandidateSamples"] = len(trial["cases"]) * 2
    status["complete"] = generated == status["expectedCandidateSamples"]
    (root / "spaces-status.json").write_text(json.dumps(status, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"generated": generated, "expected": status["expectedCandidateSamples"], "complete": status["complete"]}))
    return 0

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        raise
