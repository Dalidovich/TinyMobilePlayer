import { describeError, logDebug, logEvent } from './diagnostics.js';

const SETTINGS_KEY = 'tiny-player.settings';
const RESTART_THRESHOLD = 3;
const MAX_FAILURES = 5;
const EXTERNAL_PAUSE_WINDOW = 3;
const MAX_EXTERNAL_RESUMES = 4;
const EXTERNAL_RESUME_DELAY = 250;
const STALL_RETRY_DELAY = 15000;
const STALL_RETRY_LIMIT = 20;
const RETRY_AUDIBLE_AFTER = 0.5;
const REBUILD_ATTEMPTS = new Set([3, 10]);
const FALLBACK_ARTWORK = 'icon-512.png';
const REPEAT_MODES = ['off', 'all', 'one'];
const LOGGED_EVENTS = ['play', 'playing', 'pause', 'ended', 'waiting', 'stalled', 'abort', 'emptied'];
const DEBUG_EVENTS = ['loadstart', 'suspend', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'durationchange', 'seeking', 'seeked', 'ratechange', 'volumechange'];
const THROTTLED_EVENTS = { timeupdate: 5000, progress: 1000 };

function describeRanges(ranges) {
  const parts = [];
  for (let i = 0; i < ranges.length; i++) parts.push(`${ranges.start(i).toFixed(1)}-${ranges.end(i).toFixed(1)}`);
  return parts.join(',') || '-';
}

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

function artworkScheme(src) {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(src ?? '');
  return match ? match[1] : '-';
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
  retried = null;
  wantPlay = false;
  externalResumes = 0;
  artwork = null;
  resumeTimer = 0;
  metadataAt = 0;
  hiddenAt = 0;
  stalled = false;
  stallRetries = 0;
  retryMuted = false;

  constructor(library) {
    super();
    this.library = library;
    this.createAudio();
    this.bindMediaSession();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.hiddenAt = 0;
        this.unmuteRetry();
        if (this.track) this.updateMediaSession(this.track);
        if (this.stalled) {
          this.stalled = false;
          this.stallRetries = 0;
          logEvent('pause-resume-visible', this.describeState());
          this.play();
        }
        return;
      }
      this.hiddenAt = performance.now();
    });
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

  describeState() {
    const { currentTime, duration, readyState, networkState } = this.audio;
    return `${this.current ?? '-'} t=${currentTime.toFixed(1)} d=${duration.toFixed(1)} rs=${readyState} ns=${networkState}`;
  }

  describeAudio() {
    const { paused, playbackRate, volume, muted, buffered, seekable } = this.audio;
    return `${this.describeState()} paused=${paused} rate=${playbackRate} vol=${volume}${muted ? ' muted' : ''} buf=${describeRanges(buffered)} seekable=${describeRanges(seekable)}`;
  }

  describeQueue() {
    return `pos=${this.pos}/${this.order.length} upNext=${this.upNext.length} fromQueue=${this.fromQueue} shuffle=${this.shuffle} repeat=${this.repeat}`;
  }

  hiddenSeconds() {
    return this.hiddenAt ? Math.round((performance.now() - this.hiddenAt) / 1000) : 0;
  }

  createAudio() {
    const audio = new Audio();
    audio.preload = 'auto';
    audio.muted = this.retryMuted;
    this.audio = audio;
    this.bindAudio();
    return audio;
  }

  rebuildAudio() {
    const previous = this.audio;
    const position = previous.currentTime;
    logEvent('audio-rebuild', `${this.current ?? '-'} at ${position.toFixed(1)} hidden=${this.hiddenSeconds()}s`);
    const audio = this.createAudio();
    if (this.objectUrl) {
      audio.src = this.objectUrl;
      if (Number.isFinite(position) && position > 0) audio.currentTime = position;
    }
    previous.pause();
    previous.removeAttribute('src');
    previous.load();
    this.emit('playstate');
  }

  trace(action, detail = '') {
    logDebug(`player.${action}`, () => `${typeof detail === 'function' ? detail() : detail} | ${this.describeQueue()}`.trimStart());
  }

  bindAudio() {
    const audio = this.audio;
    const active = () => audio === this.audio;
    for (const type of LOGGED_EVENTS) {
      audio.addEventListener(type, () => {
        if (active()) logEvent(type, this.describeState());
      });
    }
    for (const type of DEBUG_EVENTS) {
      audio.addEventListener(type, () => {
        if (active()) logDebug(type, () => this.describeAudio());
      });
    }
    for (const [type, interval] of Object.entries(THROTTLED_EVENTS)) {
      let last = 0;
      audio.addEventListener(type, () => {
        if (!active()) return;
        const now = performance.now();
        if (now - last < interval) return;
        last = now;
        logDebug(type, () => this.describeAudio());
      });
    }
    audio.addEventListener('ended', () => {
      if (active()) this.next(true);
    });
    audio.addEventListener('playing', () => {
      if (active()) this.failures = 0;
    });
    for (const type of ['play', 'pause']) {
      audio.addEventListener(type, () => {
        if (!active()) return;
        if (navigator.mediaSession) navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
        logDebug('session.playbackState', audio.paused ? 'paused' : 'playing');
        this.emit('playstate');
      });
    }
    audio.addEventListener('pause', () => {
      if (active()) this.handlePause();
    });
    audio.addEventListener('timeupdate', () => {
      if (!active()) return;
      if (this.stalled && audio.currentTime > EXTERNAL_PAUSE_WINDOW) this.stalled = false;
      if (this.retryMuted && audio.currentTime > RETRY_AUDIBLE_AFTER) this.unmuteRetry();
      this.emit('time');
    });
    for (const type of ['loadedmetadata', 'seeked', 'ratechange']) {
      audio.addEventListener(type, () => {
        if (active()) this.updatePositionState();
      });
    }
    audio.addEventListener('error', () => {
      if (active()) this.handleFailure();
    });
  }

  bindMediaSession() {
    const session = navigator.mediaSession;
    if (!session) return;
    const handlers = {
      play: () => this.play(),
      pause: () => this.pause(),
      previoustrack: () => this.prev(),
      nexttrack: () => this.next(),
      seekto: details => this.seek(details.seekTime),
      seekbackward: details => this.seek(this.audio.currentTime - (details.seekOffset || 10)),
      seekforward: details => this.seek(this.audio.currentTime + (details.seekOffset || 10)),
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        session.setActionHandler(action, details => {
          logEvent(`session:${action}`, `${this.describeState()} ${JSON.stringify(details ?? {})}`);
          handler(details);
        });
      } catch (error) {
        logDebug('session.unsupported', `${action}: ${error.message}`);
      }
    }
  }

  async updateMediaSession(track) {
    if (!navigator.mediaSession) return;
    await this.refreshArtwork(track);
    if (this.current !== track.id || !this.artwork) return;
    this.metadataAt = performance.now();
    logDebug('session.metadata', `${track.id} artwork=${artworkScheme(this.artwork[0].src)}`);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist ?? '',
      album: track.album ?? '',
      artwork: this.artwork,
    });
  }

  async refreshArtwork(track) {
    const cover = await this.library.coverUrl(track.cover, 'full');
    if (this.current !== track.id) return;
    this.artwork = cover
      ? [{ src: cover, sizes: '512x512', type: 'image/webp' }]
      : [{ src: new URL(FALLBACK_ARTWORK, document.baseURI).href, sizes: '512x512', type: 'image/png' }];
  }

  updatePositionState() {
    const { duration, currentTime, playbackRate } = this.audio;
    if (!navigator.mediaSession?.setPositionState || !Number.isFinite(duration)) return;
    try {
      navigator.mediaSession.setPositionState({ duration, playbackRate, position: Math.min(currentTime, duration) });
      logDebug('session.position', `${currentTime.toFixed(1)}/${duration.toFixed(1)} rate=${playbackRate}`);
    } catch (error) {
      logDebug('session.position-failed', error.message);
    }
  }

  load(id) {
    const track = this.library.byId.get(id);
    if (!track) {
      logDebug('player.load-unknown', id);
      return;
    }
    this.current = id;
    this.emit('track');
    this.emit('queue');
    this.updateMediaSession(track);
    this.retried = null;
    this.externalResumes = 0;
    this.stalled = false;
    this.stallRetries = 0;
    this.unmuteRetry();
    this.cancelResume();
    logEvent('load', id);
    this.trace('load', () => `${track.path} | ${track.artist ?? '-'} / ${track.album ?? '-'} / ${track.title}`);
    const file = this.library.getFile(track);
    if (!file) {
      logEvent('missingfile', id);
      this.releaseSource();
      this.emit('missingfile');
      return;
    }
    this.setSource(file);
    this.play();
  }

  setSource(file, position = 0) {
    const previous = this.objectUrl;
    logDebug('player.setSource', `${file.name} size=${file.size} type=${file.type || '-'} modified=${file.lastModified} position=${position.toFixed(1)}`);
    this.objectUrl = URL.createObjectURL(file);
    this.audio.src = this.objectUrl;
    if (position) this.audio.currentTime = position;
    if (previous) URL.revokeObjectURL(previous);
  }

  stopIfMissing() {
    const track = this.track;
    if (!track || this.library.getFile(track)) return;
    this.trace('stopIfMissing', track.id);
    this.stop();
    this.emit('track');
    this.emit('queue');
  }

  resumeAfterLink() {
    const track = this.track;
    if (track && !this.objectUrl && this.library.getFile(track)) {
      this.trace('resumeAfterLink', track.id);
      this.load(track.id);
    }
  }

  play() {
    this.trace('play', () => this.describeAudio());
    this.wantPlay = true;
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
    this.audio.play().then(() => logDebug('play-resolved', () => this.describeState())).catch(error => {
      this.wantPlay = false;
      logEvent('play-rejected', `${error.name}: ${error.message} ${this.describeState()}`);
      this.emit('playstate');
    });
  }

  releaseSource() {
    if (!this.objectUrl) return;
    logDebug('player.releaseSource', this.current ?? '-');
    URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.audio.removeAttribute('src');
    this.audio.load();
  }

  pause() {
    this.wantPlay = false;
    this.stalled = false;
    this.stallRetries = 0;
    this.unmuteRetry();
    this.cancelResume();
    this.trace('pause', () => this.describeAudio());
    this.audio.pause();
  }

  cancelResume() {
    clearTimeout(this.resumeTimer);
    this.resumeTimer = 0;
  }

  handlePause() {
    const { currentTime, duration, ended } = this.audio;
    if (!this.wantPlay || ended) return;
    if (Number.isFinite(duration) && currentTime >= duration - 1) return;
    const sinceMetadata = Math.round(performance.now() - this.metadataAt);
    const artwork = artworkScheme(this.artwork?.[0]?.src ?? '');
    const atStart = currentTime < EXTERNAL_PAUSE_WINDOW;
    const recoverable = atStart && this.externalResumes < MAX_EXTERNAL_RESUMES;
    logEvent('pause-external', () => `${this.describeState()} visible=${document.visibilityState} hidden=${this.hiddenSeconds()}s artwork=${artwork} sinceMetadata=${sinceMetadata}ms recover=${recoverable}`);
    if (!recoverable) {
      this.wantPlay = false;
      if (!atStart) return;
      this.stalled = true;
      logEvent('pause-stalled', `${this.current ?? '-'} externalResumes=${this.externalResumes} stallRetries=${this.stallRetries}`);
      this.scheduleStallRetry();
      return;
    }
    this.externalResumes++;
    const delay = EXTERNAL_RESUME_DELAY * this.externalResumes;
    logEvent('pause-recover', `${this.current ?? '-'} attempt=${this.externalResumes} delay=${delay}ms t=${currentTime.toFixed(1)}`);
    this.cancelResume();
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = 0;
      this.play();
    }, delay);
  }

  scheduleStallRetry() {
    if (this.stallRetries >= STALL_RETRY_LIMIT) {
      logEvent('pause-stall-giveup', `${this.current ?? '-'} hidden=${this.hiddenSeconds()}s`);
      return;
    }
    this.stallRetries++;
    logEvent('pause-stall-retry', `${this.current ?? '-'} in=${STALL_RETRY_DELAY / 1000}s attempt=${this.stallRetries}`);
    this.cancelResume();
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = 0;
      if (!this.stalled) return;
      this.muteRetry();
      if (REBUILD_ATTEMPTS.has(this.stallRetries)) this.rebuildAudio();
      this.play();
    }, STALL_RETRY_DELAY);
  }

  muteRetry() {
    if (this.retryMuted) return;
    this.retryMuted = true;
    this.audio.muted = true;
  }

  unmuteRetry() {
    if (!this.retryMuted) return;
    this.retryMuted = false;
    this.audio.muted = false;
  }

  toggle() {
    this.trace('toggle', this.audio.paused ? 'play' : 'pause');
    if (this.audio.paused) this.play();
    else this.pause();
  }

  seek(seconds) {
    const duration = this.audio.duration;
    this.trace('seek', `${Number(seconds).toFixed(1)} of ${duration}`);
    if (!Number.isFinite(duration)) return;
    this.audio.currentTime = Math.max(0, Math.min(seconds, duration));
  }

  async handleFailure() {
    const error = this.audio.error;
    logEvent('error', `code=${error?.code} ${error?.message ?? ''} ${this.describeState()}`);
    const id = this.current;
    const track = this.track;
    if (track && this.retried !== id) {
      this.retried = id;
      const position = this.audio.currentTime;
      const file = await this.library.reloadFile(track);
      if (this.current !== id) {
        logDebug('player.retry-abandoned', `${id} -> ${this.current}`);
        return;
      }
      if (file) {
        logEvent('retry', `${id} at ${position.toFixed(1)}`);
        this.setSource(file, position);
        this.play();
        return;
      }
    }
    this.failures++;
    logEvent('skip-failed', `${id} failures=${this.failures}`);
    this.emit('error');
    if (this.failures < MAX_FAILURES && this.hasNext()) this.next(true, true);
    else this.pause();
  }

  hasNext() {
    return this.upNext.length > 0 || this.pos + 1 < this.order.length || (this.repeat !== 'off' && this.order.length > 0);
  }

  playList(ids, startId) {
    this.base = ids.slice();
    this.order = this.shuffle ? [startId, ...shuffled(ids.filter(id => id !== startId))] : this.base.slice();
    this.pos = this.order.indexOf(startId);
    this.fromQueue = false;
    this.trace('playList', `ids=${ids.length} start=${startId}`);
    this.load(startId);
  }

  next(auto = false, skipRepeatOne = false) {
    this.trace('next', `auto=${auto} skipRepeatOne=${skipRepeatOne}`);
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
      logEvent('queue-end');
      this.pause();
      this.audio.currentTime = 0;
    }
  }

  prev({ restartFirst = true } = {}) {
    this.trace('prev', () => `restartFirst=${restartFirst} t=${this.audio.currentTime.toFixed(1)}`);
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
    this.trace('playNext', id);
    this.upNext.unshift(id);
    this.queueChanged();
  }

  addToQueue(id) {
    this.trace('addToQueue', id);
    this.upNext.push(id);
    this.queueChanged();
  }

  upcoming() {
    return this.order.slice(this.pos + 1);
  }

  removeFromUpNext(index) {
    this.trace('removeFromUpNext', () => `${index} ${this.upNext[index]}`);
    this.upNext.splice(index, 1);
    this.queueChanged();
  }

  moveToTop(fromUpNext, index) {
    this.trace('moveToTop', `upNext=${fromUpNext} index=${index}`);
    const id = fromUpNext ? this.upNext.splice(index, 1)[0] : this.order.splice(this.pos + 1 + index, 1)[0];
    this.upNext.unshift(id);
    this.queueChanged();
  }

  removeFromUpcoming(index) {
    this.trace('removeFromUpcoming', () => `${index} ${this.order[this.pos + 1 + index]}`);
    const [id] = this.order.splice(this.pos + 1 + index, 1);
    const baseIndex = this.base.indexOf(id);
    if (baseIndex >= 0) this.base.splice(baseIndex, 1);
    this.queueChanged();
  }

  moveInUpNext(from, to) {
    this.trace('moveInUpNext', `${from} -> ${to}`);
    move(this.upNext, from, to);
    this.queueChanged();
  }

  moveInUpcoming(from, to) {
    this.trace('moveInUpcoming', `${from} -> ${to}`);
    move(this.order, this.pos + 1 + from, this.pos + 1 + to);
    this.queueChanged();
  }

  clearUpNext() {
    this.trace('clearUpNext', () => `${this.upNext.length} removed`);
    this.upNext = [];
    this.queueChanged();
  }

  jumpToUpNext(index) {
    this.trace('jumpToUpNext', index);
    const [id] = this.upNext.splice(index, 1);
    this.fromQueue = true;
    this.load(id);
  }

  jumpToUpcoming(index) {
    this.trace('jumpToUpcoming', index);
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
    this.trace('toggleShuffle');
    this.queueChanged();
  }

  cycleRepeat() {
    this.repeat = REPEAT_MODES[(REPEAT_MODES.indexOf(this.repeat) + 1) % REPEAT_MODES.length];
    this.saveSettings();
    this.trace('cycleRepeat');
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
    this.trace('syncWithLibrary', `tracks=${this.library.tracks.length}`);
    this.emit('queue');
    this.emit('track');
  }

  stop() {
    logEvent('stop', this.describeState());
    this.pause();
    this.releaseSource();
    this.current = null;
    this.fromQueue = false;
    this.artwork = null;
    this.cancelResume();
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
      this.trace('restoreSettings');
    } catch (error) {
      logDebug('player.restoreSettings-failed', describeError(error));
    }
  }
}
