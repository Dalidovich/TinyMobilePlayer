import { logDebug } from './diagnostics.js';

const DIR_NAME = 'music';

export const offlineSupported = !!navigator.storage?.getDirectory
  && typeof FileSystemFileHandle !== 'undefined'
  && 'createWritable' in FileSystemFileHandle.prototype;

async function musicDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR_NAME, { create: true });
}

export async function loadStoredFiles() {
  const started = performance.now();
  const dir = await musicDir();
  const files = new Map();
  let bytes = 0;
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file') continue;
    const file = await handle.getFile();
    files.set(name, file);
    bytes += file.size;
  }
  logDebug('opfs-load', `files=${files.size} bytes=${bytes} ms=${Math.round(performance.now() - started)}`);
  return files;
}

export async function readStoredFile(id) {
  const dir = await musicDir();
  const handle = await dir.getFileHandle(id);
  const file = await handle.getFile();
  logDebug('opfs-read', `${id} size=${file.size}`);
  return file;
}

export async function storeFiles(entries, { onProgress, shouldStop } = {}) {
  const dir = await musicDir();
  let done = 0;
  for (const [id, file] of entries) {
    if (shouldStop?.()) {
      logDebug('opfs-store-stopped', `done=${done} of ${entries.length}`);
      break;
    }
    const started = performance.now();
    const handle = await dir.getFileHandle(id, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(file);
      await writable.close();
    } catch (error) {
      logDebug('opfs-write-failed', `${id} ${file.name} size=${file.size}: ${error?.name}: ${error?.message}`);
      await writable.abort().catch(() => {});
      await dir.removeEntry(id).catch(() => {});
      throw error;
    }
    logDebug('opfs-write', `${id} ${file.name} size=${file.size} ms=${Math.round(performance.now() - started)}`);
    onProgress?.(++done, entries.length);
  }
  return done;
}

export async function removeStoredFiles(ids) {
  const dir = await musicDir();
  for (const id of ids) await dir.removeEntry(id).catch(error => logDebug('opfs-remove-failed', `${id}: ${error?.message}`));
  logDebug('opfs-remove', `count=${ids.length}`);
}

export async function clearStoredFiles() {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(DIR_NAME, { recursive: true }).catch(error => logDebug('opfs-clear-failed', error?.message));
  logDebug('opfs-clear');
}

export async function freeSpace() {
  const { quota = Infinity, usage = 0 } = await navigator.storage.estimate?.() ?? {};
  logDebug('storage-estimate', `usage=${usage} quota=${quota}`);
  return quota - usage;
}
