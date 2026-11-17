const LOG_KEY = 'tiny-player.log';
const LOG_LIMIT = 400;

function readLog() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LOG_KEY));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let entries = readLog();

export function logEvent(type, detail = '') {
  entries.push(`${new Date().toISOString()} [${document.visibilityState}] ${type} ${detail}`.trimEnd());
  if (entries.length > LOG_LIMIT) entries = entries.slice(-LOG_LIMIT);
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(entries));
  } catch {
    return;
  }
}

export function logText() {
  return [navigator.userAgent, ...entries].join('\n');
}
