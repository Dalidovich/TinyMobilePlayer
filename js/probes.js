import { debugEnabled, describeError, logDebug, logError, logEvent } from './diagnostics.js';

const HEARTBEAT_MS = 30000;
const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
const MEGABYTE = 1024 ** 2;

const megabytes = bytes => `${(bytes / MEGABYTE).toFixed(1)}MB`;

function describeTarget(target) {
  if (!(target instanceof Element)) return String(target);
  const id = target.id ? `#${target.id}` : '';
  const src = target.currentSrc || target.src || target.href || '';
  return `<${target.tagName.toLowerCase()}${id}> ${src}`.trimEnd();
}

function watchErrors() {
  addEventListener('error', event => {
    if (event instanceof ErrorEvent) {
      logError('js-error', `${event.message} at ${event.filename}:${event.lineno}:${event.colno}${event.error?.stack ? `\n${event.error.stack}` : ''}`);
    } else {
      logError('resource-error', describeTarget(event.target));
    }
  }, true);
  addEventListener('unhandledrejection', event => logError('unhandled-rejection', describeError(event.reason)));
}

function watchConsole() {
  for (const level of CONSOLE_LEVELS) {
    const original = console[level]?.bind(console);
    if (!original) continue;
    console[level] = (...args) => {
      if (level === 'error') logError('console.error', () => args.map(describeError).join(' '));
      else logDebug(`console.${level}`, () => args.map(describeError).join(' '));
      original(...args);
    };
  }
}

function describeConnection(connection) {
  return `type=${connection.type ?? '-'} effective=${connection.effectiveType ?? '-'} downlink=${connection.downlink ?? '-'} rtt=${connection.rtt ?? '-'} saveData=${connection.saveData ?? '-'}`;
}

function watchNetwork() {
  for (const type of ['online', 'offline']) addEventListener(type, () => logDebug(type));
  const connection = navigator.connection;
  connection?.addEventListener?.('change', () => logDebug('connection', describeConnection(connection)));
}

async function watchBattery() {
  const battery = await navigator.getBattery?.().catch(() => null);
  if (!battery) return;
  const describe = () => `level=${Math.round(battery.level * 100)}% charging=${battery.charging}`;
  logDebug('battery', describe);
  for (const type of ['levelchange', 'chargingchange']) battery.addEventListener(type, () => logDebug('battery', describe));
}

function watchDevices() {
  navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    const outputs = devices.filter(device => device.kind === 'audiooutput').length;
    logEvent('devicechange', `devices=${devices.length} audiooutput=${outputs}`);
  });
}

function watchLongTasks() {
  if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) logDebug('longtask', `${Math.round(entry.duration)}ms ${entry.name}`);
  }).observe({ type: 'longtask', buffered: true });
}

function watchLayout() {
  screen.orientation?.addEventListener?.('change', () => logDebug('orientation', screen.orientation.type));
  let resizeTimer = 0;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => logDebug('resize', `${innerWidth}x${innerHeight}`), 300);
  });
}

function memoryUsage() {
  const memory = performance.memory;
  return memory ? `heap=${megabytes(memory.usedJSHeapSize)}/${megabytes(memory.jsHeapSizeLimit)}` : 'heap=-';
}

function startHeartbeat(snapshot) {
  setInterval(() => {
    if (debugEnabled()) logDebug('heartbeat', () => `${memoryUsage()} ${snapshot()}`);
  }, HEARTBEAT_MS);
}

export function watchServiceWorker(registration) {
  logDebug('sw-registered', `scope=${registration.scope} active=${registration.active?.state ?? '-'} waiting=${!!registration.waiting}`);
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    logEvent('sw-updatefound');
    worker?.addEventListener('statechange', () => logEvent('sw-state', worker.state));
  });
}

export async function environmentLines() {
  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => null);
  const standalone = matchMedia('(display-mode: standalone)').matches;
  return [
    `userAgent: ${navigator.userAgent}`,
    `platform: ${navigator.userAgentData?.platform ?? navigator.platform ?? '-'} mobile=${navigator.userAgentData?.mobile ?? '-'}`,
    `language: ${navigator.languages?.join(',') ?? navigator.language}`,
    `screen: ${screen.width}x${screen.height} dpr=${devicePixelRatio} viewport=${innerWidth}x${innerHeight} standalone=${standalone}`,
    `cpu: ${navigator.hardwareConcurrency ?? '-'} memory: ${navigator.deviceMemory ?? '-'}GB ${memoryUsage()}`,
    `storage: ${estimate ? `${megabytes(estimate.usage)} / ${megabytes(estimate.quota)}` : '-'} persisted=${persisted ?? '-'}`,
    `serviceWorker: ${navigator.serviceWorker?.controller ? 'controlled' : 'none'}`,
    `debug: ${debugEnabled()}`,
  ];
}

export function installProbes({ snapshot }) {
  watchErrors();
  watchConsole();
  watchNetwork();
  watchBattery();
  watchDevices();
  watchLongTasks();
  watchLayout();
  startHeartbeat(snapshot);
  navigator.serviceWorker?.addEventListener('controllerchange', () => logEvent('sw-controllerchange'));
  if (debugEnabled()) environmentLines().then(lines => logDebug('environment', lines.join(' | ')));
}
