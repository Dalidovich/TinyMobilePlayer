const DB_NAME = 'tiny-player';
const DB_VERSION = 1;
const META = 'meta';
const COVERS = 'covers';
const TRACKS_KEY = 'tracks';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      if (!db.objectStoreNames.contains(COVERS)) db.createObjectStore(COVERS);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function result(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function completion(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function withDb(action) {
  const db = await openDb();
  try {
    return await action(db);
  } finally {
    db.close();
  }
}

export function loadLibrary() {
  return withDb(async db => {
    const tx = db.transaction([META, COVERS], 'readonly');
    const [tracks, keys, blobs] = await Promise.all([
      result(tx.objectStore(META).get(TRACKS_KEY)),
      result(tx.objectStore(COVERS).getAllKeys()),
      result(tx.objectStore(COVERS).getAll()),
    ]);
    if (!tracks?.length) return null;
    return { tracks, covers: new Map(keys.map((key, i) => [key, blobs[i]])) };
  });
}

export function saveLibrary({ tracks, covers }) {
  return withDb(async db => {
    const stored = new Set(await result(db.transaction(COVERS, 'readonly').objectStore(COVERS).getAllKeys()));
    const tx = db.transaction([META, COVERS], 'readwrite');
    const coverStore = tx.objectStore(COVERS);
    tx.objectStore(META).put(tracks, TRACKS_KEY);
    for (const key of stored) {
      if (!covers.has(key)) coverStore.delete(key);
    }
    for (const [key, blobs] of covers) {
      if (!stored.has(key)) coverStore.put(blobs, key);
    }
    await completion(tx);
  });
}
