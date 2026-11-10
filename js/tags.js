const MAX_TAG_BYTES = 24 * 1024 * 1024;
const OGG_SCAN_BYTES = 1024 * 1024;

const legacyEncoding = /^(ru|uk|be|bg|sr|mk)\b/i.test(navigator.language) ? 'windows-1251' : 'latin1';
const decoders = new Map();

function decode(bytes, encoding) {
  if (!decoders.has(encoding)) decoders.set(encoding, new TextDecoder(encoding));
  return decoders.get(encoding).decode(bytes);
}

function ascii(bytes, start, length) {
  let s = '';
  for (let i = start; i < start + length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function cleanText(text) {
  const value = text.split('\0').find(part => part.trim()) ?? '';
  return value.trim() || undefined;
}

function hasHighBytes(bytes) {
  return bytes.some(b => b > 0x7f);
}

async function readBytes(file, start, length) {
  return new Uint8Array(await file.slice(start, start + length).arrayBuffer());
}

export async function readTags(file) {
  try {
    const head = await readBytes(file, 0, 12);
    if (ascii(head, 0, 3) === 'ID3') return await readId3(file, head);
    if (ascii(head, 0, 4) === 'fLaC') return await readFlac(file);
    if (ascii(head, 4, 4) === 'ftyp') return await readMp4(file);
    if (ascii(head, 0, 4) === 'OggS') return await readOgg(file);
  } catch {
    return {};
  }
  return {};
}

function synchsafe(b, i) {
  return (b[i] & 0x7f) << 21 | (b[i + 1] & 0x7f) << 14 | (b[i + 2] & 0x7f) << 7 | (b[i + 3] & 0x7f);
}

function u32(b, i) {
  return (b[i] << 24 >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
}

function u32le(b, i) {
  return b[i] + (b[i + 1] << 8) + (b[i + 2] << 16) + (b[i + 3] << 24 >>> 0);
}

function removeUnsync(bytes) {
  const out = new Uint8Array(bytes.length);
  let j = 0;
  for (let i = 0; i < bytes.length; i++) {
    out[j++] = bytes[i];
    if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i++;
  }
  return out.subarray(0, j);
}

const ID3_FIELDS = {
  2: { TT2: 'title', TP1: 'artist', TP2: 'albumArtist', TAL: 'album', TRK: 'track', PIC: 'picture' },
  3: { TIT2: 'title', TPE1: 'artist', TPE2: 'albumArtist', TALB: 'album', TRCK: 'track', APIC: 'picture' },
};

async function readId3(file, head) {
  const major = head[3];
  if (major < 2 || major > 4) return {};
  const flags = head[5];
  const size = synchsafe(head, 6);
  if (size + 10 > MAX_TAG_BYTES) return {};
  let b = await readBytes(file, 0, size + 10);
  if (flags & 0x80 && major < 4) b = removeUnsync(b);
  const fields = ID3_FIELDS[major === 2 ? 2 : 3];
  const idLength = major === 2 ? 3 : 4;
  const headerLength = major === 2 ? 6 : 10;
  let offset = 10;
  if (flags & 0x40 && major > 2) offset += major === 4 ? synchsafe(b, 10) : u32(b, 10) + 4;
  const end = Math.min(size + 10, b.length);
  const tags = {};
  while (offset + headerLength <= end) {
    const id = ascii(b, offset, idLength);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const frameSize = major === 2
      ? (b[offset + 3] << 16) + (b[offset + 4] << 8) + b[offset + 5]
      : major === 4 ? synchsafe(b, offset + 4) : u32(b, offset + 4);
    const start = offset + headerLength;
    if (frameSize <= 0 || start + frameSize > end) break;
    const key = fields[id];
    if (key && !tags[key]) {
      let frame = b.subarray(start, start + frameSize);
      const formatFlags = major === 2 ? 0 : b[offset + 9];
      if (major === 4 && formatFlags & 0x02) frame = removeUnsync(frame);
      if (major === 4 && formatFlags & 0x01) frame = frame.subarray(4);
      if (!(formatFlags & (major === 4 ? 0x0c : 0xc0))) {
        tags[key] = key === 'picture' ? id3Picture(frame, major) : id3Text(frame);
      }
    }
    offset = start + frameSize;
  }
  return normalize(tags);
}

function id3Text(frame) {
  const encoding = frame[0];
  const body = frame.subarray(1);
  if (encoding === 0) return cleanText(decode(body, hasHighBytes(body) ? legacyEncoding : 'latin1'));
  if (encoding === 1) return cleanText(decode(body, body[0] === 0xfe ? 'utf-16be' : 'utf-16le'));
  if (encoding === 2) return cleanText(decode(body, 'utf-16be'));
  return cleanText(decode(body, 'utf-8'));
}

function skipTerminated(bytes, i, encoding) {
  if (encoding === 1 || encoding === 2) {
    while (i + 1 < bytes.length && (bytes[i] || bytes[i + 1])) i += 2;
    return i + 2;
  }
  const zero = bytes.indexOf(0, i);
  return zero < 0 ? bytes.length : zero + 1;
}

function id3Picture(frame, major) {
  const encoding = frame[0];
  let i = 1;
  let mime;
  if (major === 2) {
    mime = 'image/' + ascii(frame, 1, 3).toLowerCase().replace('jpg', 'jpeg');
    i = 4;
  } else {
    const zero = frame.indexOf(0, i);
    mime = ascii(frame, i, zero - i);
    i = zero + 1;
  }
  i = skipTerminated(frame, i + 1, encoding);
  if (i >= frame.length) return undefined;
  return new Blob([frame.subarray(i)], { type: imageMime(mime) });
}

function imageMime(mime) {
  if (!mime || mime === '-->') return 'image/jpeg';
  return mime.includes('/') ? mime : 'image/' + mime.toLowerCase();
}

async function readFlac(file) {
  const tags = {};
  let offset = 4;
  for (let guard = 0; guard < 128; guard++) {
    const header = await readBytes(file, offset, 4);
    if (header.length < 4) break;
    const isLast = header[0] & 0x80;
    const type = header[0] & 0x7f;
    const length = (header[1] << 16) + (header[2] << 8) + header[3];
    offset += 4;
    if ((type === 4 || type === 6) && length <= MAX_TAG_BYTES) {
      const block = await readBytes(file, offset, length);
      if (type === 4) fillMissing(tags, vorbisComments(block, 0));
      else tags.picture ??= flacPicture(block);
    }
    offset += length;
    if (isLast) break;
  }
  return normalize(tags);
}

function fillMissing(target, source) {
  for (const [key, value] of Object.entries(source)) target[key] ??= value;
}

const VORBIS_FIELDS = {
  TITLE: 'title',
  ARTIST: 'artist',
  ALBUMARTIST: 'albumArtist',
  'ALBUM ARTIST': 'albumArtist',
  ALBUM: 'album',
  TRACKNUMBER: 'track',
};

function vorbisComments(b, offset) {
  const tags = {};
  const utf8 = new TextDecoder();
  let i = offset;
  i += 4 + u32le(b, i);
  const count = u32le(b, i);
  i += 4;
  for (let n = 0; n < count && i + 4 <= b.length; n++) {
    const length = u32le(b, i);
    i += 4;
    if (i + length > b.length) break;
    const entry = b.subarray(i, i + length);
    i += length;
    const eq = entry.indexOf(0x3d);
    if (eq < 0) continue;
    const key = ascii(entry, 0, eq).toUpperCase();
    if (key === 'METADATA_BLOCK_PICTURE') {
      tags.picture ??= flacPicture(base64Bytes(utf8.decode(entry.subarray(eq + 1))));
      continue;
    }
    const field = VORBIS_FIELDS[key];
    if (field && !tags[field]) tags[field] = cleanText(utf8.decode(entry.subarray(eq + 1)));
  }
  return tags;
}

function base64Bytes(text) {
  try {
    return Uint8Array.from(atob(text.trim()), c => c.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}

function flacPicture(b) {
  if (b.length < 32) return undefined;
  let i = 4;
  const mimeLength = u32(b, i);
  i += 4;
  const mime = ascii(b, i, mimeLength);
  i += mimeLength;
  i += 4 + u32(b, i);
  i += 16;
  const dataLength = u32(b, i);
  i += 4;
  if (i + dataLength > b.length) return undefined;
  return new Blob([b.subarray(i, i + dataLength)], { type: imageMime(mime) });
}

async function readOgg(file) {
  const data = await readBytes(file, 0, OGG_SCAN_BYTES);
  const packets = [];
  let current = [];
  let offset = 0;
  while (packets.length < 2 && offset + 27 <= data.length && ascii(data, offset, 4) === 'OggS') {
    const segments = data[offset + 26];
    let bodyOffset = offset + 27 + segments;
    for (let s = 0; s < segments; s++) {
      const lacing = data[offset + 27 + s];
      current.push(data.subarray(bodyOffset, bodyOffset + lacing));
      bodyOffset += lacing;
      if (lacing < 255) {
        packets.push(concat(current));
        current = [];
        if (packets.length === 2) break;
      }
    }
    offset = bodyOffset;
  }
  const packet = packets[1];
  if (!packet) return {};
  if (ascii(packet, 1, 6) === 'vorbis') return normalize(vorbisComments(packet, 7));
  if (ascii(packet, 0, 8) === 'OpusTags') return normalize(vorbisComments(packet, 8));
  return {};
}

function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let i = 0;
  for (const c of chunks) {
    out.set(c, i);
    i += c.length;
  }
  return out;
}

async function readAtomHeader(file, offset) {
  const h = await readBytes(file, offset, 16);
  if (h.length < 8) return null;
  let size = u32(h, 0);
  let headerSize = 8;
  if (size === 1) {
    size = u32(h, 8) * 2 ** 32 + u32(h, 12);
    headerSize = 16;
  } else if (size === 0) {
    size = file.size - offset;
  }
  return { type: ascii(h, 4, 4), size, headerSize };
}

async function readMp4(file) {
  let offset = 0;
  while (offset < file.size) {
    const atom = await readAtomHeader(file, offset);
    if (!atom || atom.size < 8) break;
    if (atom.type === 'moov') {
      if (atom.size > MAX_TAG_BYTES) return {};
      const moov = await readBytes(file, offset + atom.headerSize, atom.size - atom.headerSize);
      return normalize(mp4Tags(moov));
    }
    offset += atom.size;
  }
  return {};
}

function findAtom(b, start, end, path) {
  let i = start;
  while (i + 8 <= end) {
    const size = u32(b, i);
    const type = ascii(b, i + 4, 4);
    if (size < 8 || i + size > end) return null;
    if (type === path[0]) {
      const bodyStart = i + 8 + (type === 'meta' ? 4 : 0);
      return path.length === 1 ? { start: bodyStart, end: i + size } : findAtom(b, bodyStart, i + size, path.slice(1));
    }
    i += size;
  }
  return null;
}

const MP4_FIELDS = {
  '©nam': 'title',
  '©ART': 'artist',
  aART: 'albumArtist',
  '©alb': 'album',
  trkn: 'track',
  covr: 'picture',
};

function mp4Tags(b) {
  const ilst = findAtom(b, 0, b.length, ['udta', 'meta', 'ilst']);
  if (!ilst) return {};
  const tags = {};
  const utf8 = new TextDecoder();
  let i = ilst.start;
  while (i + 8 <= ilst.end) {
    const size = u32(b, i);
    if (size < 8) break;
    const field = MP4_FIELDS[ascii(b, i + 4, 4)];
    const data = findAtom(b, i + 8, i + size, ['data']);
    if (field && data && !tags[field]) {
      const kind = u32(b, data.start);
      const payload = b.subarray(data.start + 8, data.end);
      if (field === 'track') tags.track = String((payload[2] << 8) + payload[3]);
      else if (field === 'picture') tags.picture = new Blob([payload], { type: kind === 14 ? 'image/png' : 'image/jpeg' });
      else tags[field] = cleanText(utf8.decode(payload));
    }
    i += size;
  }
  return tags;
}

function normalize(tags) {
  const track = parseInt(tags.track, 10);
  return {
    title: tags.title,
    artist: tags.artist || tags.albumArtist,
    album: tags.album,
    track: Number.isFinite(track) ? track : undefined,
    picture: tags.picture?.size ? tags.picture : undefined,
  };
}
