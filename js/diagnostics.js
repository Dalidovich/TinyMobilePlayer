const DB_NAME = 'tiny-player-log';
const DB_VERSION = 1;
const STORE = 'entries';
const LEGACY_KEY = 'tiny-player.log';
const DEBUG_KEY = 'tiny-player.debug';
const LOG_LIMIT = 20000;
const FLUSH_MS = 1000;
const FLUSH_SIZE = 200;
const DETAIL_LIMIT = 4000;

let debug = localStorage.getItem(DEBUG_KEY) === '1';
let pending = takeLegacyEntries();
let flushTimer = 0;
let flushing = Promise.resolve();
let dbPromise = null;

function takeLegacyEntries() {
  try {
    const lines = JSON.parse(localStorage.getItem(LEGACY_KEY));
    localStorage.removeItem(LEGACY_KEY);
    if (!Array.isArray(lines)) return [];
    return lines.map(line => ({ time: Date.parse(line.slice(0, 24)) || 0, level: 'I', state: '', type: 'legacy', detail: String(line).slice(25) }));
  } catch {
    return [];
  }
}

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { autoIncrement: true });
    request.onsuccess = () => {
      const db = request.result;
      db.onclose = () => {
        dbPromise = null;
      };
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  }).catch(error => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

function completion(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function result(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function trimOldest(store) {
  const countRequest = store.count();
  countRequest.onsuccess = () => {
    const excess = countRequest.result - LOG_LIMIT;
    if (excess <= 0) return;
    const cursorRequest = store.openKeyCursor();
    cursorRequest.onsuccess = () => {
      const first = cursorRequest.result?.key;
      if (first !== undefined) store.delete(IDBKeyRange.upperBound(first + excess, true));
    };
  };
}

async function writeBatch(batch) {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const entry of batch) store.add(entry);
  trimOldest(store);
  await completion(tx);
}

export function flushLog() {
  clearTimeout(flushTimer);
  flushTimer = 0;
  if (!pending.length) return flushing;
  const batch = pending;
  pending = [];
  flushing = flushing.then(() => writeBatch(batch)).catch(() => {
    pending = [...batch, ...pending].slice(-LOG_LIMIT);
  });
  return flushing;
}

function resolveDetail(detail) {
  try {
    const value = typeof detail === 'function' ? detail() : detail;
    const text = value === undefined || value === null ? '' : String(value);
    return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
  } catch (error) {
    return `<detail failed: ${error?.message}>`;
  }
}

function record(level, type, detail) {
  pending.push({ time: Date.now(), level, state: document.visibilityState, type, detail: resolveDetail(detail) });
  if (pending.length >= FLUSH_SIZE) flushLog();
  else flushTimer ||= setTimeout(flushLog, FLUSH_MS);
}

export function logEvent(type, detail = '') {
  record('I', type, detail);
}

export function logError(type, detail = '') {
  record('E', type, detail);
}

export function logDebug(type, detail = '') {
  if (debug) record('D', type, detail);
}

export function debugEnabled() {
  return debug;
}

export function setDebug(enabled) {
  debug = enabled;
  if (enabled) localStorage.setItem(DEBUG_KEY, '1');
  else localStorage.removeItem(DEBUG_KEY);
  logEvent('debug-mode', enabled ? 'on' : 'off');
}

export function describeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`;
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

export async function readLog() {
  await flushLog();
  try {
    const db = await openDb();
    const stored = await result(db.transaction(STORE, 'readonly').objectStore(STORE).getAll());
    return [...stored, ...pending];
  } catch {
    return pending.slice();
  }
}

async function clearStore() {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).clear();
  await completion(tx);
}

export async function clearLog() {
  pending = [];
  clearTimeout(flushTimer);
  flushTimer = 0;
  await flushing;
  await clearStore().catch(() => {});
  logEvent('log-cleared');
}

export function formatEntry(entry) {
  const time = entry.time ? new Date(entry.time).toISOString() : '-';
  const state = entry.state ? ` [${entry.state}]` : '';
  return `${time} ${entry.level}${state} ${entry.type} ${entry.detail}`.trimEnd();
}

for (const type of ['visibilitychange', 'freeze', 'resume']) {
  document.addEventListener(type, () => {
    logEvent(type);
    if (document.visibilityState === 'hidden') flushLog();
  });
}
for (const type of ['pagehide', 'pageshow']) {
  addEventListener(type, event => {
    logEvent(type, event.persisted ? 'persisted' : '');
    if (type === 'pagehide') flushLog();
  });
}
