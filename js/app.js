import { AUTO, SUPPORTED, initI18n, languageName, languageSetting, setLanguage, t } from './i18n.js';
import { Library, folderNameOf } from './library.js';
import { loadLibrary, saveLibrary } from './library-cache.js';
import { clearStoredFiles, freeSpace, loadStoredFiles, offlineSupported, removeStoredFiles, storeFiles } from './offline-store.js';
import { Player } from './player.js';
import { VirtualList } from './virtual-list.js';
import { sortable } from './sortable.js';
import { swipeable } from './swipe.js';

const ROW_HEIGHT = 64;
const UPCOMING_LIMIT = 100;
const TOAST_MS = 2500;
const FOLDER_KEY = 'tiny-player.folder';
const OFFLINE_KEY = 'tiny-player.offline';
const GIGABYTE = 1024 ** 3;
const MEGABYTE = 1024 ** 2;

const $ = id => document.getElementById(id);

const library = new Library();
const player = new Player(library);
const sheetStack = [];
let visible = [];
let actionTrack = null;
let seeking = false;
let toastTimer = 0;
let stored = new Map();
let storingTask = null;
let stopStoring = false;
let storeAgain = false;

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function subtitle(track) {
  return [track.artist ?? t('unknownArtist'), track.album].filter(Boolean).join(' · ');
}

function setCover(el, track, kind) {
  const key = track?.cover ?? '';
  el.dataset.cover = key;
  el.style.backgroundImage = '';
  if (!key) return;
  const cached = library.cachedCoverUrl(key, kind);
  if (cached !== undefined) {
    if (cached) el.style.backgroundImage = `url("${cached}")`;
    return;
  }
  library.coverUrl(key, kind).then(url => {
    if (url && el.dataset.cover === key) el.style.backgroundImage = `url("${url}")`;
  });
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, TOAST_MS);
}

let trackList;

function createTrackList() {
  return new VirtualList($('library'), {
    rowHeight: ROW_HEIGHT,
    createRow() {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = '<div class="cover"></div><div class="meta"><div class="title"></div><div class="sub"></div></div>'
        + '<button class="icon more"><svg><use href="#i-more"/></svg></button>';
      row.lastChild.setAttribute('aria-label', t('label.more'));
      return row;
    },
    renderRow(row, track) {
      const [cover, meta] = row.children;
      setCover(cover, track, 'thumb');
      meta.firstChild.textContent = track.title;
      meta.lastChild.textContent = subtitle(track);
      row.classList.toggle('active', track.id === player.current);
      row.classList.toggle('missing', !library.getFile(track));
    },
  });
}

function applyFilter() {
  const terms = $('search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  visible = terms.length
    ? library.tracks.filter(track => terms.every(term => track.search.includes(term)))
    : library.tracks;
  trackList.setItems(visible);
  const hasTracks = library.tracks.length > 0;
  $('empty').hidden = hasTracks;
  $('library').hidden = !hasTracks;
  $('list-bar').hidden = !hasTracks;
  $('no-results').hidden = !hasTracks || visible.length > 0;
  $('count').textContent = t('tracks', { count: visible.length });
}

function renderTrack() {
  const track = player.track;
  $('mini').hidden = !track;
  document.body.classList.toggle('has-mini', !!track);
  if (track) {
    $('mini-title').textContent = track.title;
    $('mini-artist').textContent = subtitle(track);
    $('now-title').textContent = track.title;
    $('now-artist').textContent = subtitle(track);
    setCover($('mini-cover'), track, 'thumb');
    setCover($('now-cover'), track, 'full');
    document.title = `${track.title} — Tiny Player`;
  } else {
    document.title = 'Tiny Player';
  }
  trackList.refresh();
  renderTime();
}

function renderPlayState() {
  const icon = player.playing ? '#i-pause' : '#i-play';
  for (const id of ['mini-play', 'play']) $(id).querySelector('use').setAttribute('href', icon);
}

function renderTime() {
  const { currentTime, duration } = player.audio;
  const ratio = duration > 0 ? currentTime / duration : 0;
  $('mini-bar').style.transform = `scaleX(${ratio})`;
  if (seeking) return;
  $('seek').value = Math.round(ratio * 1000);
  $('time-current').textContent = formatTime(currentTime);
  $('time-total').textContent = formatTime(duration);
}

function renderModes() {
  $('shuffle').classList.toggle('on', player.shuffle);
  $('repeat').classList.toggle('on', player.repeat !== 'off');
  $('repeat').querySelector('use').setAttribute('href', player.repeat === 'one' ? '#i-repeat-one' : '#i-repeat');
}

function queueItem(track, sortableItem) {
  const li = document.createElement('li');
  li.className = 'qitem';
  li.innerHTML = '<div class="cover"></div><div class="meta"><div class="title"></div><div class="sub"></div></div>'
    + (sortableItem
      ? '<button class="icon remove"><svg><use href="#i-close"/></svg></button>'
        + '<button class="icon to-top"><svg><use href="#i-to-top"/></svg></button><span class="icon handle"><svg><use href="#i-handle"/></svg></span>'
      : '');
  setCover(li.firstChild, track, 'thumb');
  li.querySelector('.title').textContent = track.title;
  li.querySelector('.sub').textContent = subtitle(track);
  if (sortableItem) {
    li.querySelector('.remove').setAttribute('aria-label', t('label.remove'));
    li.querySelector('.to-top').setAttribute('aria-label', t('label.toTop'));
    li.querySelector('.handle').setAttribute('aria-label', t('label.reorder'));
  }
  return li;
}

function renderQueue() {
  if (!$('queue').classList.contains('open')) return;
  const track = player.track;
  $('queue-current').replaceChildren(...(track ? queueItem(track, false).childNodes : []));
  const next = player.upNext.map(id => library.byId.get(id)).filter(Boolean);
  $('queue-next').replaceChildren(...next.map(item => queueItem(item, true)));
  $('queue-next-section').hidden = next.length === 0;
  const upcoming = player.upcoming();
  const shown = upcoming.slice(0, UPCOMING_LIMIT).map(id => library.byId.get(id)).filter(Boolean);
  $('queue-later').replaceChildren(...shown.map(item => queueItem(item, true)));
  $('queue-later-section').hidden = upcoming.length === 0;
  $('queue-more').hidden = upcoming.length <= UPCOMING_LIMIT;
  $('queue-more').textContent = t('queue.more', { count: upcoming.length - UPCOMING_LIMIT });
  $('queue-empty').hidden = next.length > 0 || upcoming.length > 0;
}

function openSheet(id) {
  const sheet = $(id);
  if (sheetStack.includes(sheet)) return;
  sheet.classList.add('open');
  sheetStack.push(sheet);
  history.pushState({ sheet: id }, '');
  if (id === 'queue') {
    renderQueue();
    $('queue-body').scrollTop = 0;
  }
}

function closeSheet() {
  if (sheetStack.length) history.back();
}

addEventListener('popstate', () => {
  sheetStack.pop()?.classList.remove('open');
});

function openActions(track) {
  actionTrack = track;
  $('action-name').textContent = track.title;
  $('action-artist').textContent = subtitle(track);
  setCover($('action-cover'), track, 'thumb');
  $('track-actions').showModal();
}

function renderFolderHint() {
  const folder = localStorage.getItem(FOLDER_KEY);
  $('pick-folder-label').textContent = folder ? t('openFolder', { name: folder }) : t('pickFolder');
  $('empty-hint').textContent = folder ? t('empty.reopenHint') : t('empty.hint');
  $('relink-label').textContent = folder ? t('relink.folder', { name: folder }) : t('relink.generic');
  $('relink').hidden = !library.needsFiles;
}

async function saveCache() {
  try {
    await saveLibrary(await library.snapshot());
    await navigator.storage?.persist?.();
  } catch {
    return;
  }
}

async function restoreCache() {
  try {
    const cached = await loadLibrary();
    if (cached) library.restore(cached);
  } catch {
    return;
  }
}

const offlineEnabled = () => offlineSupported && localStorage.getItem(OFFLINE_KEY) === '1';

function formatSize(bytes) {
  const [value, unit] = bytes >= GIGABYTE ? [bytes / GIGABYTE, 'gigabyte'] : [bytes / MEGABYTE, 'megabyte'];
  const format = new Intl.NumberFormat(document.documentElement.lang, { style: 'unit', unit, maximumFractionDigits: 1 });
  return format.format(value);
}

function renderOfflineSetting() {
  $('offline-section').hidden = !offlineSupported;
  const enabled = offlineEnabled();
  $('offline-toggle').setAttribute('aria-checked', String(enabled));
  let bytes = 0;
  for (const file of stored.values()) bytes += file.size;
  $('offline-status').textContent = enabled
    ? t('offline.status', { tracks: t('tracks', { count: stored.size }), size: formatSize(bytes) })
    : t('offline.hint');
}

async function restoreStoredFiles() {
  if (!offlineEnabled()) return;
  try {
    stored = await loadStoredFiles();
    library.attachFiles(stored);
  } catch {
    stored = new Map();
  }
}

function storeLibrary() {
  if (!offlineEnabled()) return;
  if (storingTask) {
    storeAgain = true;
    return;
  }
  stopStoring = false;
  storingTask = copyToStorage().finally(() => {
    storingTask = null;
    $('store-progress').hidden = true;
    renderOfflineSetting();
    if (storeAgain && !stopStoring) {
      storeAgain = false;
      storeLibrary();
    }
  });
}

async function copyToStorage() {
  try {
    const orphans = [...stored.keys()].filter(id => !library.byId.has(id));
    await removeStoredFiles(orphans);
    for (const id of orphans) stored.delete(id);
    const pending = library.tracks
      .filter(track => !stored.has(track.id) && library.getFile(track))
      .map(track => [track.id, library.getFile(track)]);
    if (!pending.length) return;
    const bytes = pending.reduce((sum, [, file]) => sum + file.size, 0);
    if (bytes > await freeSpace()) {
      toast(t('offline.noSpace', { size: formatSize(bytes) }));
      return;
    }
    await navigator.storage.persist?.();
    const progress = (done, total) => {
      $('store-text').textContent = t('offline.progress', { done, total });
      $('store-bar').style.transform = `scaleX(${total ? done / total : 0})`;
    };
    $('store-progress').hidden = false;
    progress(0, pending.length);
    const wakeLock = await navigator.wakeLock?.request('screen').catch(() => null);
    try {
      await storeFiles(pending, {
        shouldStop: () => stopStoring,
        onProgress: (done, total) => {
          const [id, file] = pending[done - 1];
          stored.set(id, file);
          progress(done, total);
        },
      });
    } finally {
      wakeLock?.release().catch(() => {});
    }
    if (!stopStoring) toast(t('offline.done', { tracks: t('tracks', { count: stored.size }) }));
  } catch (error) {
    toast(t('offline.error', { message: error.message }));
  }
}

async function disableOffline() {
  if (!confirm(t('offline.confirmDisable'))) return;
  localStorage.removeItem(OFFLINE_KEY);
  stopStoring = true;
  storeAgain = false;
  await storingTask;
  library.detachFiles(stored);
  stored = new Map();
  await clearStoredFiles();
  player.stopIfMissing();
  toast(t('offline.cleared'));
}

function enableOffline() {
  localStorage.setItem(OFFLINE_KEY, '1');
  if (library.tracks.length && library.needsFiles) {
    toast(t('offline.pickFolder'));
    closeDialogs();
    $('folder-input').click();
  } else {
    storeLibrary();
  }
}

async function toggleOffline() {
  if (offlineEnabled()) await disableOffline();
  else enableOffline();
  renderOfflineSetting();
  renderFolderHint();
  trackList.refresh();
}

function renderLanguageOptions() {
  const current = languageSetting();
  $('language-options').replaceChildren(...[AUTO, ...SUPPORTED].map(lang => {
    const button = document.createElement('button');
    button.className = 'option';
    button.dataset.lang = lang;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(lang === current));
    button.innerHTML = '<svg><use href="#i-check"/></svg><span></span>';
    button.lastChild.textContent = lang === AUTO ? t('settings.languageAuto') : languageName(lang);
    if (lang !== AUTO) button.lastChild.lang = lang;
    return button;
  }));
}

function renderTexts() {
  for (const button of document.querySelectorAll('#library .more')) button.setAttribute('aria-label', t('label.more'));
  if (actionTrack) $('action-artist').textContent = subtitle(actionTrack);
  renderFolderHint();
  renderLanguageOptions();
  renderOfflineSetting();
  applyFilter();
  renderTrack();
  renderQueue();
}

function closeDialogs() {
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
}

async function importFiles(input, replace) {
  const files = [...input.files];
  input.value = '';
  if (!files.length) return;
  let wakeLock = null;
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    wakeLock = null;
  }
  const progress = (done, total) => {
    $('import-text').textContent = t('import.progress', { done, total });
    $('import-bar').style.transform = `scaleX(${total ? done / total : 0})`;
  };
  $('import-progress').hidden = false;
  progress(0, 0);
  try {
    const count = await library.link(files, { replace, onProgress: progress });
    toast(count ? t('import.done', { tracks: t('tracks', { count: library.tracks.length }) }) : t('import.noAudio'));
    const folder = replace && count ? folderNameOf(files) : null;
    if (folder) localStorage.setItem(FOLDER_KEY, folder);
  } catch (error) {
    toast(t('import.error', { message: error.message }));
  } finally {
    $('import-progress').hidden = true;
    wakeLock?.release().catch(() => {});
    player.syncWithLibrary();
    player.resumeAfterLink();
    renderFolderHint();
    trackList.refresh();
    saveCache();
    storeLibrary();
  }
}

const actions = {
  'pick-folder': () => {
    closeDialogs();
    $('folder-input').click();
  },
  'add-files': () => {
    closeDialogs();
    $('files-input').click();
  },
  'open-settings': () => {
    closeDialogs();
    renderLanguageOptions();
    renderOfflineSetting();
    $('settings').showModal();
  },
  'close-dialog': button => button.closest('dialog').close(),
  'close-sheet': closeSheet,
  'open-queue': () => openSheet('queue'),
  'play-next': () => {
    player.playNext(actionTrack.id);
    $('track-actions').close();
    toast(t('toast.playNext'));
  },
  'add-to-queue': () => {
    player.addToQueue(actionTrack.id);
    $('track-actions').close();
    toast(t('toast.queued'));
  },
};

document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (button) actions[button.dataset.action]?.(button);
});

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', event => {
    const rect = dialog.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) dialog.close();
  });
}

$('library').addEventListener('click', event => {
  const row = event.target.closest('.row');
  if (!row?.item) return;
  if (event.target.closest('.more')) openActions(row.item);
  else player.playList(visible.map(track => track.id), row.item.id);
});

$('library').addEventListener('contextmenu', event => {
  const row = event.target.closest('.row');
  if (!row?.item) return;
  event.preventDefault();
  openActions(row.item);
});

let searchFrame = 0;
$('search').addEventListener('input', () => {
  cancelAnimationFrame(searchFrame);
  searchFrame = requestAnimationFrame(() => {
    applyFilter();
    $('library').scrollTop = 0;
  });
});

$('menu-btn').addEventListener('click', () => $('menu').showModal());
$('folder-input').addEventListener('change', event => importFiles(event.target, true));
$('files-input').addEventListener('change', event => importFiles(event.target, false));

$('shuffle-all').addEventListener('click', () => {
  if (!visible.length) return;
  if (!player.shuffle) player.toggleShuffle();
  const ids = visible.map(track => track.id);
  player.playList(ids, ids[Math.floor(Math.random() * ids.length)]);
});

$('play-all').addEventListener('click', () => {
  if (!visible.length) return;
  if (player.shuffle) player.toggleShuffle();
  const ids = visible.map(track => track.id);
  player.playList(ids, ids[0]);
});

$('mini').addEventListener('click', event => {
  if (!event.target.closest('button')) openSheet('now');
});
$('mini-play').addEventListener('click', () => player.toggle());
$('mini-next').addEventListener('click', () => player.next());
$('play').addEventListener('click', () => player.toggle());
$('next').addEventListener('click', () => player.next());
$('prev').addEventListener('click', () => player.prev());
$('shuffle').addEventListener('click', () => player.toggleShuffle());
$('repeat').addEventListener('click', () => player.cycleRepeat());

$('seek').addEventListener('input', () => {
  seeking = true;
  $('time-current').textContent = formatTime(($('seek').value / 1000) * player.audio.duration);
});
$('seek').addEventListener('change', () => {
  player.seek(($('seek').value / 1000) * player.audio.duration);
  seeking = false;
});

$('language-options').addEventListener('click', async event => {
  const option = event.target.closest('[data-lang]');
  if (!option || option.getAttribute('aria-checked') === 'true') return;
  await setLanguage(option.dataset.lang);
  renderTexts();
});

$('queue-clear').addEventListener('click', () => player.clearUpNext());
$('offline-toggle').addEventListener('click', toggleOffline);

$('queue-body').addEventListener('click', event => {
  const item = event.target.closest('.qlist > li');
  if (!item || event.target.closest('.handle')) return;
  const list = item.parentElement;
  const index = [...list.children].indexOf(item);
  const upNext = list.id === 'queue-next';
  if (event.target.closest('.to-top')) {
    player.moveToTop(upNext, index);
  } else if (event.target.closest('.remove')) {
    if (upNext) player.removeFromUpNext(index);
    else player.removeFromUpcoming(index);
  } else if (upNext) {
    player.jumpToUpNext(index);
  } else {
    player.jumpToUpcoming(index);
  }
});

swipeable($('now-swipe'), {
  onNext: () => player.next(),
  onPrev: () => player.prev({ restartFirst: false }),
  canNext: () => player.hasNext(),
});

sortable($('queue-next'), $('queue-body'), (from, to) => player.moveInUpNext(from, to));
sortable($('queue-later'), $('queue-body'), (from, to) => player.moveInUpcoming(from, to));

library.addEventListener('change', applyFilter);
player.addEventListener('track', renderTrack);
player.addEventListener('playstate', renderPlayState);
player.addEventListener('time', renderTime);
player.addEventListener('queue', () => {
  renderModes();
  renderQueue();
});
player.addEventListener('error', () => toast(t('playError')));
player.addEventListener('missingfile', () => {
  toast(t('relink.toast'));
  $('folder-input').click();
});

async function init() {
  await initI18n();
  trackList = createTrackList();
  await restoreCache();
  await restoreStoredFiles();
  renderOfflineSetting();
  renderFolderHint();
  player.restoreSettings();
  applyFilter();
  renderTrack();
  renderPlayState();
  renderModes();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
