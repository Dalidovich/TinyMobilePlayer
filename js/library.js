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

function compareTracks(a, b) {
  return collator.compare(a.artist ?? '￿', b.artist ?? '￿')
    || collator.compare(a.album ?? '￿', b.album ?? '￿')
    || (a.trackNo ?? 1e9) - (b.trackNo ?? 1e9)
    || collator.compare(a.title, b.title);
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
    bitmap.close();
    return { full, thumb };
  } catch {
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

  setTracks(list) {
    list.sort(compareTracks);
    this.tracks = list;
    this.byId = new Map(list.map(track => [track.id, track]));
    this.dispatchEvent(new Event('change'));
  }

  getFile(track) {
    return this.files.get(track.id);
  }

  get needsFiles() {
    return this.tracks.some(track => !this.files.has(track.id));
  }

  restore({ tracks, covers }) {
    this.reset();
    for (const [key, blobs] of covers) this.covers.set(key, coverEntry(blobs));
    this.setTracks(tracks);
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
            tracks.push(cached ?? await this.describe(file, path, id, folderCovers));
            if (!cached && ++described % PUBLISH_EVERY === 0) {
              this.setTracks([...tracks, ...previous.filter(track => !listed.has(track.id))]);
            }
          }
        }
        onProgress?.(++done, audioFiles.length);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL_READS }, readNext));
    this.setTracks(tracks);
    if (replace) this.pruneCovers();
    return audioFiles.length;
  }

  pruneCovers() {
    const used = new Set(this.tracks.map(track => track.cover));
    for (const [key, entry] of this.covers) {
      if (used.has(key)) continue;
      revokeCover(entry);
      this.covers.delete(key);
    }
  }

  async describe(file, path, id, folderCovers) {
    const tags = await readTags(file);
    const folder = folderOf(path);
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
