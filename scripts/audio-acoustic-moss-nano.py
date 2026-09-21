#!/usr/bin/env python3
import argparse, json, shutil, subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--moss-repo', required=True)
parser.add_argument('--samples', required=True)
parser.add_argument('--out', required=True)
args = parser.parse_args()

moss = Path(args.moss_repo).resolve()
out = Path(args.out).resolve()
out.mkdir(parents=True, exist_ok=True)
samples = json.loads(Path(args.samples).read_text(encoding='utf-8'))
source = moss / 'generated_audio' / 'moss_tts_nano_output.wav'
reference = moss / 'assets' / 'audio' / 'zh_1.wav'

records = []
for sample in samples:
    cmd = [
        'moss-tts-nano', 'generate',
        '--backend', 'onnx',
        '--execution-provider', 'cpu',
        '--prompt-speech', str(reference),
        '--text', sample['text'],
    ]
    run = subprocess.run(cmd, cwd=moss, text=True, capture_output=True)
    if run.returncode != 0:
        records.append({
            'id': sample['id'],
            'status': 'error',
            'stderr': run.stderr[-2000:],
            'stdout': run.stdout[-2000:],
        })
        continue
    if not source.exists():
        records.append({'id': sample['id'], 'status': 'error', 'error': f'missing output {source}'})
        continue

    wav = out / f"{sample['id']}.wav"
    mp3 = out / f"{sample['id']}.mp3"
    shutil.copy2(source, wav)
    ffmpeg = subprocess.run([
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
        '-i', str(wav), '-ac', '1', '-ar', '48000',
        '-c:a', 'libmp3lame', '-b:a', '96k', str(mp3),
    ], text=True, capture_output=True)
    if ffmpeg.returncode != 0:
        records.append({'id': sample['id'], 'status': 'error', 'error': ffmpeg.stderr[-2000:]})
        continue
    records.append({'id': sample['id'], 'status': 'generated', 'wav': wav.name, 'mp3': mp3.name})

Path(out / 'generation-summary.json').write_text(json.dumps({
    'schema': 'bareeq.moss-nano-acoustic-generation.v1',
    'engine': 'moss-nano',
    'reference': 'OpenMOSS bundled zh_1.wav (cross-lingual intelligibility trial only)',
    'records': records,
}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

if any(item['status'] != 'generated' for item in records) or len(records) != len(samples):
    raise SystemExit(1)
