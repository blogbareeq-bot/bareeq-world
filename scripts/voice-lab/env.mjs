import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const exists = async (target) => { try { await access(target); return true; } catch { return false; } };

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed.replace(/\s+#.*$/, '').trim();
}

export function parseEnv(text) {
  const values = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error('Invalid line in .env.voice-lab. Use NAME=value syntax.');
    values[match[1]] = unquote(match[2]);
  }
  return values;
}

export async function loadVoiceLabEnv(root = process.cwd(), base = process.env) {
  const envFile = path.join(root, '.env.voice-lab');
  const local = await exists(envFile) ? parseEnv(await readFile(envFile, 'utf8')) : {};
  return { ...local, ...base };
}

export function resolveCandidate(candidate, env) {
  const voice = candidate.voice || (candidate.voiceEnv ? env[candidate.voiceEnv] : '') || candidate.voiceDefault || '';
  return { ...candidate, voice: String(voice).trim() };
}
