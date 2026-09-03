import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export async function atomicWriteFile(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

export async function atomicWriteJson(file, value) {
  await atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function replaceDirAtomically(sourceDir, destDir) {
  const parent = path.dirname(destDir);
  await mkdir(parent, { recursive: true });
  const staging = `${destDir}.next-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  const { cp } = await import('node:fs/promises');
  await cp(sourceDir, staging, { recursive: true });
  const backup = `${destDir}.prev-${process.pid}`;
  let hadDest = true;
  try {
    await rename(destDir, backup);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    hadDest = false;
  }
  try {
    await rename(staging, destDir);
  } catch (error) {
    if (hadDest) await rename(backup, destDir).catch(() => {});
    throw error;
  }
  await rm(backup, { recursive: true, force: true });
}
