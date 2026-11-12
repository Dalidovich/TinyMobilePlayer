const SETTINGS_KEY = 'tiny-player.settings';
const RESTART_THRESHOLD = 3;
const MAX_FAILURES = 5;
const REPEAT_MODES = ['off', 'all', 'one'];

function shuffled(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function move(list, from, to) {
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
}

export class Player extends EventTarget {
  base = [];
  order = [];
  pos = -1;
  upNext = [];
  current = null;
  fromQueue = false;
  shuffle = false;
  repeat = 'off';
  failures = 0;
  objectUrl = null;

  constructor(library) {
    super();
    this.library = library;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.bindAudio();
    this.bindMediaSession();
  }

  get track() {
    return this.library.byId.get(this.current) ?? null;
  }

  get playing() {
    return !this.audio.paused;
  }

  emit(type) {
    this.dispatchEvent(new Event(type));
  }

  bindAudio() {
    const audio = this.audio;
    audio.addEventListener('ended', () => this.next(true));
    audio.addEventListener('playing', () => {
      this.failures = 0;
    });
    for (const type of ['play', 'pause']) {
      audio.addEventListener(type, () => {
        if (navigator.mediaSession) navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
        this.emit('playstate');
      });
    }
    audio.addEventListener('timeupdate', () => this.emit('time'));
    for (const type of ['loadedmetadata', 'seeked', 'ratechange']) {
      audio.addEventListener(type, () => this.updatePositionState());
    }
    audio.addEventListener('error', () => this.handleFailure());
  }

  bindMediaSession() {
    const session = navigator.mediaSession;
    if (!session) return;
    const handlers = {
      play: () => this.play(),
      pause: () => this.audio.pause(),
      previoustrack: () => this.prev(),
      nexttrack: () => this.next(),
      seekto: details => this.seek(details.seekTime),
      seekbackward: details => this.seek(this.audio.currentTime - (details.seekOffset || 10)),
      seekforward: details => this.seek(this.audio.currentTime + (details.seekOffset || 10)),
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        session.setActionHandler(action, handler);
      } catch {
        continue;
      }
    }
  }

  async updateMediaSession(track) {
    if (!navigator.mediaSession) return;
    const cover = await this.library.coverUrl(track.cover, 'full');
    if (this.current !== track.id) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist ?? '',
      album: track.album ?? '',
      artwork: cover ? [{ src: cover, sizes: '512x512', type: 'image/webp' }] : [],
    });
  }

  updatePositionState() {
    const { duration, currentTime, playbackRate } = this.audio;
    if (!navigator.mediaSession?.setPositionState || !Number.isFinite(duration)) return;
    try {
      navigator.mediaSession.setPositionState({ duration, playbackRate, position: Math.min(currentTime, duration) });
    } catch {
      return;
    }
  }

  load(id) {
    const track = this.library.byId.get(id);
    if (!track) return;
    this.current = id;
    this.emit('track');
    this.emit('queue');
    this.updateMediaSession(track);
    this.releaseSource();
    const file = this.library.getFile(track);
    if (!file) {
      this.emit('missingfile');
      return;
    }
    this.objectUrl = URL.createObjectURL(file);
    this.audio.src = this.objectUrl;
    this.play();
  }

  stopIfMissing() {
    const track = this.track;
    if (!track || this.library.getFile(track)) return;
    this.stop();
    this.emit('track');
    this.emit('queue');
  }

  resumeAfterLink() {
    const track = this.track;
    if (track && !this.objectUrl && this.library.getFile(track)) this.load(track.id);
  }

  play() {
    if (!this.current && this.upNext.length) {
      this.next();
      return;
    }
    if (!this.current) {
      const ids = this.library.tracks.map(track => track.id);
      if (ids.length) this.playList(ids, this.shuffle ? ids[Math.floor(Math.random() * ids.length)] : ids[0]);
      return;
    }
    if (!this.objectUrl) {
      this.load(this.current);
      return;
    }
    this.audio.play().catch(() => {});
  }

  releaseSource() {
    if (!this.objectUrl) return;
    URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  toggle() {
    if (this.audio.paused) this.play();
    else this.audio.pause();
  }

  seek(seconds) {
    const duration = this.audio.duration;
    if (!Number.isFinite(duration)) return;
    this.audio.currentTime = Math.max(0, Math.min(seconds, duration));
  }

  handleFailure() {
    this.failures++;
    this.emit('error');
    if (this.failures < MAX_FAILURES && this.hasNext()) this.next(true, true);
    else this.audio.pause();
  }

  hasNext() {
    return this.upNext.length > 0 || this.pos + 1 < this.order.length || (this.repeat !== 'off' && this.order.length > 0);
  }

  playList(ids, startId) {
    this.base = ids.slice();
    this.order = this.shuffle ? [startId, ...shuffled(ids.filter(id => id !== startId))] : this.base.slice();
    this.pos = this.order.indexOf(startId);
    this.fromQueue = false;
    this.load(startId);
  }

  next(auto = false, skipRepeatOne = false) {
    if (auto && !skipRepeatOne && this.repeat === 'one' && this.current) {
      this.audio.currentTime = 0;
      this.play();
      return;
    }
    if (this.upNext.length) {
      this.fromQueue = true;
      this.load(this.upNext.shift());
    } else if (this.pos + 1 < this.order.length) {
      this.pos++;
      this.fromQueue = false;
      this.load(this.order[this.pos]);
    } else if (this.order.length && this.repeat !== 'off') {
      if (this.shuffle) this.order = shuffled(this.order);
      this.pos = 0;
      this.fromQueue = false;
      this.load(this.order[0]);
    } else if (auto) {
      this.audio.pause();
      this.audio.currentTime = 0;
    }
  }

  prev({ restartFirst = true } = {}) {
    if (restartFirst && this.audio.currentTime > RESTART_THRESHOLD) {
      this.audio.currentTime = 0;
      return;
    }
    if (this.fromQueue && this.pos >= 0) {
      this.upNext.unshift(this.current);
      this.fromQueue = false;
      this.load(this.order[this.pos]);
    } else if (!this.fromQueue && this.pos > 0) {
      this.pos--;
      this.load(this.order[this.pos]);
    } else if (!this.fromQueue && this.repeat === 'all' && this.order.length > 1) {
      this.pos = this.order.length - 1;
      this.load(this.order[this.pos]);
    } else {
      this.audio.currentTime = 0;
    }
  }

  playNext(id) {
    this.upNext.unshift(id);
    this.queueChanged();
  }

  addToQueue(id) {
    this.upNext.push(id);
    this.queueChanged();
  }

  upcoming() {
    return this.order.slice(this.pos + 1);
  }

  removeFromUpNext(index) {
    this.upNext.splice(index, 1);
    this.queueChanged();
  }

  moveToTop(fromUpNext, index) {
    const id = fromUpNext ? this.upNext.splice(index, 1)[0] : this.order.splice(this.pos + 1 + index, 1)[0];
    this.upNext.unshift(id);
    this.queueChanged();
  }

  removeFromUpcoming(index) {
    const [id] = this.order.splice(this.pos + 1 + index, 1);
    const baseIndex = this.base.indexOf(id);
    if (baseIndex >= 0) this.base.splice(baseIndex, 1);
    this.queueChanged();
  }

  moveInUpNext(from, to) {
    move(this.upNext, from, to);
    this.queueChanged();
  }

  moveInUpcoming(from, to) {
    move(this.order, this.pos + 1 + from, this.pos + 1 + to);
    this.queueChanged();
  }

  clearUpNext() {
    this.upNext = [];
    this.queueChanged();
  }

  jumpToUpNext(index) {
    const [id] = this.upNext.splice(index, 1);
    this.fromQueue = true;
    this.load(id);
  }

  jumpToUpcoming(index) {
    this.pos += 1 + index;
    this.fromQueue = false;
    this.load(this.order[this.pos]);
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    this.saveSettings();
    if (this.order.length) {
      const anchor = this.fromQueue ? this.order[this.pos] : this.current;
      if (this.shuffle) {
        const rest = shuffled(this.base.filter(id => id !== anchor));
        this.order = anchor ? [anchor, ...rest] : rest;
        this.pos = anchor ? 0 : -1;
      } else {
        this.order = this.base.slice();
        this.pos = anchor ? this.order.indexOf(anchor) : -1;
      }
    }
    this.queueChanged();
  }

  cycleRepeat() {
    this.repeat = REPEAT_MODES[(REPEAT_MODES.indexOf(this.repeat) + 1) % REPEAT_MODES.length];
    this.saveSettings();
    this.queueChanged();
  }

  queueChanged() {
    this.emit('queue');
  }

  syncWithLibrary() {
    const exists = id => this.library.byId.has(id);
    this.pos = this.order.slice(0, this.pos + 1).filter(exists).length - 1;
    this.order = this.order.filter(exists);
    this.base = this.base.filter(exists);
    this.upNext = this.upNext.filter(exists);
    if (this.current && !exists(this.current)) this.stop();
    this.emit('queue');
    this.emit('track');
  }

  stop() {
    this.audio.pause();
    this.releaseSource();
    this.current = null;
    this.fromQueue = false;
    if (navigator.mediaSession) navigator.mediaSession.metadata = null;
  }

  saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ shuffle: this.shuffle, repeat: this.repeat }));
  }

  restoreSettings() {
    try {
      const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {};
      this.shuffle = !!settings.shuffle;
      this.repeat = REPEAT_MODES.includes(settings.repeat) ? settings.repeat : 'off';
    } catch {
      return;
    }
  }
}
