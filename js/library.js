import { describeError, logDebug, logEvent } from './diagnostics.js';
import { readTags } from './tags.js';

const AUDIO_FILE = /\.(mp3|m4a|m4b|aac|mp4|flac|ogg|oga|opus|wav|weba|webm)$/i;
const FOLDER_COVER = /^(cover|folder|front|album|albumart[^.]*)\.(jpe?g|png|webp)$/i;
const COVER_SIZE = 512;
const THUMB_SIZE = 112;
const PARALLEL_READS = 4;
const PUBLISH_EVERY = 100;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function hash(text) {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b ^ c, 2246822519);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

const pathOf = file => file.webkitRelativePath || file.name;
const folderOf = path => path.slice(0, path.lastIndexOf('/') + 1);
const baseName = name => name.replace(/\.[^.]+$/, '');

export const SORT_MODES = ['name-asc', 'name-desc', 'date-desc', 'date-asc'];

function compareTracks(a, b) {
  return collator.compare(a.artist ?? '￿', b.artist ?? '￿')
    || collator.compare(a.album ?? '￿', b.album ?? '￿')
    || (a.trackNo ?? 1e9) - (b.trackNo ?? 1e9)
    || collator.compare(a.title, b.title);
}

function compareTitles(a, b) {
  return collator.compare(a.title, b.title) || collator.compare(a.artist ?? '', b.artist ?? '');
}

async function resizeImage(bitmap, maxSize) {
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  return canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
}

async function makeCover(source) {
  try {
    const bitmap = await createImageBitmap(source);
    const [full, thumb] = await Promise.all([resizeImage(bitmap, COVER_SIZE), resizeImage(bitmap, THUMB_SIZE)]);
    logDebug('cover', `${bitmap.width}x${bitmap.height} -> full=${full.size} thumb=${thumb.size}`);
    bitmap.close();
    return { full, thumb };
  } catch (error) {
    logDebug('cover-failed', `${source.type || '-'} size=${source.size}: ${describeError(error)}`);
    return null;
  }
}

function coverEntry(blobs) {
  const urls = blobs && { full: URL.createObjectURL(blobs.full), thumb: URL.createObjectURL(blobs.thumb) };
  return { blobs, urls, promise: Promise.resolve(urls) };
}

function pendingCoverEntry(source) {
  const entry = { blobs: null, urls: undefined };
  entry.promise = makeCover(source).then(blobs => {
    const ready = coverEntry(blobs);
    entry.blobs = ready.blobs;
    entry.urls = ready.urls;
    return ready.urls;
  });
  return entry;
}

function revokeCover(entry) {
  entry.promise.then(urls => {
    if (!urls) return;
    URL.revokeObjectURL(urls.full);
    URL.revokeObjectURL(urls.thumb);
  });
}

export function folderNameOf(files) {
  const path = [...files].find(file => file.webkitRelativePath)?.webkitRelativePath;
  return path ? path.slice(0, path.indexOf('/')) : null;
}

export class Library extends EventTarget {
  tracks = [];
  byId = new Map();
  files = new Map();
  covers = new Map();
  fileReloader = null;

  setTracks(list) {
    list.sort(compareTracks);
    this.tracks = list;
    this.byId = new Map(list.map(track => [track.id, track]));
    this.dispatchEvent(new Event('change'));
  }

  getFile(track) {
    return this.files.get(track.id);
  }

  sortedTracks(list, mode) {
    const sorted = [...list];
    const order = mode === 'date-desc' ? -1 : mode === 'date-asc' ? 1 : 0;
    if (order) {
      const dates = new Map(sorted.map(track => [track.id, this.dateOf(track)]));
      sorted.sort((a, b) => order * (dates.get(a.id) - dates.get(b.id)) || compareTitles(a, b));
    } else if (mode === 'name-desc') {
      sorted.sort((a, b) => compareTitles(b, a));
    } else {
      sorted.sort(compareTitles);
    }
    return sorted;
  }

  dateOf(track) {
    const file = this.files.get(track.id);
    if (file) track.date = file.lastModified;
    return track.date ?? 0;
  }

  async reloadFile(track) {
    const fresh = this.fileReloader
      ? await this.fileReloader(track.id).catch(error => {
        logEvent('reload-failed', `${track.id}: ${describeError(error)}`);
        return null;
      })
      : null;
    logDebug('library.reloadFile', `${track.id} fresh=${!!fresh} size=${fresh?.size ?? '-'}`);
    if (fresh) this.files.set(track.id, fresh);
    return fresh ?? this.getFile(track) ?? null;
  }

  get needsFiles() {
    return this.tracks.some(track => !this.files.has(track.id));
  }

  attachFiles(files) {
    let attached = 0;
    for (const [id, file] of files) {
      if (this.byId.has(id) && !this.files.has(id)) {
        this.files.set(id, file);
        attached++;
      }
    }
    logDebug('library.attachFiles', `${attached} of ${files.size}`);
  }

  detachFiles(files) {
    for (const [id, file] of files) {
      if (this.files.get(id) === file) this.files.delete(id);
    }
    logDebug('library.detachFiles', `${files.size} remaining=${this.files.size}`);
  }

  restore({ tracks, covers }) {
    this.reset();
    for (const [key, blobs] of covers) this.covers.set(key, coverEntry(blobs));
    this.setTracks(tracks);
    logDebug('library.restore', `tracks=${tracks.length} covers=${covers.size}`);
  }

  async snapshot() {
    const entries = [...this.covers];
    await Promise.all(entries.map(([, entry]) => entry.promise));
    const used = new Set(this.tracks.map(track => track.cover));
    const covers = entries.filter(([key, entry]) => entry.blobs && used.has(key));
    return { tracks: this.tracks, covers: new Map(covers.map(([key, entry]) => [key, entry.blobs])) };
  }

  async link(fileList, { replace = false, onProgress } = {}) {
    const files = [...fileList];
    const audioFiles = files.filter(file => AUDIO_FILE.test(file.name));
    const started = performance.now();
    logEvent('link-start', `files=${files.length} audio=${audioFiles.length} replace=${replace} known=${this.tracks.length}`);
    logDebug('link-skipped', () => files.filter(file => !AUDIO_FILE.test(file.name)).map(pathOf).join(' | '));
    if (!audioFiles.length) return 0;
    const previous = this.tracks;
    const known = this.byId;
    if (replace) this.files.clear();
    const folderCovers = new Map();
    for (const file of files) {
      const folder = folderOf(pathOf(file));
      if (FOLDER_COVER.test(file.name) && !folderCovers.has(folder)) folderCovers.set(folder, file);
    }
    const tracks = replace ? [] : [...previous];
    const listed = new Set(tracks.map(track => track.id));
    let next = 0;
    let done = 0;
    let described = 0;
    const readNext = async () => {
      while (next < audioFiles.length) {
        const file = audioFiles[next++];
        const path = pathOf(file);
        const id = hash(path + '\u0000' + file.size);
        if (!this.files.has(id)) {
          this.files.set(id, file);
          if (!listed.has(id)) {
            listed.add(id);
            const cached = known.get(id);
            if (cached) logDebug('link-cached', `${id} ${path}`);
            tracks.push(cached ?? await this.describe(file, path, id, folderCovers));
            if (!cached && ++described % PUBLISH_EVERY === 0) {
              this.setTracks([...tracks, ...previous.filter(track => !listed.has(track.id))]);
            }
          }
        } else {
          logDebug('link-duplicate', `${id} ${path}`);
        }
        onProgress?.(++done, audioFiles.length);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL_READS }, readNext));
    this.setTracks(tracks);
    if (replace) this.pruneCovers();
    logEvent('link-end', `tracks=${tracks.length} described=${described} covers=${this.covers.size} ms=${Math.round(performance.now() - started)}`);
    return audioFiles.length;
  }

  pruneCovers() {
    const used = new Set(this.tracks.map(track => track.cover));
    let pruned = 0;
    for (const [key, entry] of this.covers) {
      if (used.has(key)) continue;
      revokeCover(entry);
      this.covers.delete(key);
      pruned++;
    }
    logDebug('library.pruneCovers', `pruned=${pruned} kept=${this.covers.size}`);
  }

  async describe(file, path, id, folderCovers) {
    const started = performance.now();
    const tags = await readTags(file);
    const folder = folderOf(path);
    logDebug('tags', () => `${id} ${path} size=${file.size} type=${file.type || '-'} title=${tags.title ?? '-'} artist=${tags.artist ?? '-'} album=${tags.album ?? '-'} track=${tags.track ?? '-'} picture=${tags.picture ? tags.picture.size : (folderCovers.has(folder) ? 'folder' : 'none')} ms=${Math.round(performance.now() - started)}`);
    const cover = hash((tags.artist ?? '') + '\u0000' + (tags.album ?? folder));
    const source = tags.picture ?? folderCovers.get(folder);
    if (source && !this.covers.has(cover)) this.covers.set(cover, pendingCoverEntry(source));
    return {
      id,
      path,
      title: tags.title ?? baseName(file.name),
      artist: tags.artist,
      album: tags.album,
      trackNo: tags.track,
      date: file.lastModified,
      cover,
      search: [tags.title ?? file.name, tags.artist, tags.album].filter(Boolean).join(' ').toLowerCase(),
    };
  }

  reset() {
    this.files.clear();
    for (const entry of this.covers.values()) revokeCover(entry);
    this.covers.clear();
    this.tracks = [];
    this.byId = new Map();
  }

  coverUrl(key, kind) {
    const entry = this.covers.get(key);
    return entry ? entry.promise.then(urls => urls?.[kind] ?? null) : Promise.resolve(null);
  }

  cachedCoverUrl(key, kind) {
    const entry = this.covers.get(key);
    if (!entry) return null;
    return entry.urls === undefined ? undefined : entry.urls?.[kind] ?? null;
  }
}
