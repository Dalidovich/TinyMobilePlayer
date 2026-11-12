const DIR_NAME = 'music';

export const offlineSupported = !!navigator.storage?.getDirectory
  && typeof FileSystemFileHandle !== 'undefined'
  && 'createWritable' in FileSystemFileHandle.prototype;

async function musicDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR_NAME, { create: true });
}

export async function loadStoredFiles() {
  const dir = await musicDir();
  const files = new Map();
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file') files.set(name, await handle.getFile());
  }
  return files;
}

export async function storeFiles(entries, { onProgress, shouldStop } = {}) {
  const dir = await musicDir();
  let done = 0;
  for (const [id, file] of entries) {
    if (shouldStop?.()) break;
    const handle = await dir.getFileHandle(id, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(file);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      await dir.removeEntry(id).catch(() => {});
      throw error;
    }
    onProgress?.(++done, entries.length);
  }
  return done;
}

export async function removeStoredFiles(ids) {
  const dir = await musicDir();
  for (const id of ids) await dir.removeEntry(id).catch(() => {});
}

export async function clearStoredFiles() {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(DIR_NAME, { recursive: true }).catch(() => {});
}

export async function freeSpace() {
  const { quota = Infinity, usage = 0 } = await navigator.storage.estimate?.() ?? {};
  return quota - usage;
}
