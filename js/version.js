const CACHE_PREFIX = 'tiny-player-v';

export const APP_VERSION = 20;

async function cacheVersions() {
  try {
    return (await caches.keys())
      .filter(key => key.startsWith(CACHE_PREFIX))
      .map(key => Number(key.slice(CACHE_PREFIX.length)))
      .filter(Number.isFinite);
  } catch {
    return [];
  }
}

export async function cacheVersionLabel() {
  const versions = (await cacheVersions()).sort((a, b) => a - b);
  return versions.length ? versions.map(version => `v${version}`).join(',') : '-';
}

export async function hasPendingUpdate() {
  const versions = await cacheVersions();
  return versions.length > 0 && Math.max(...versions) > APP_VERSION;
}
