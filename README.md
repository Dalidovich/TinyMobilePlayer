# Tiny Player

A minimal offline music player for mobile browsers, built as a Progressive Web App. It plays audio files straight from a folder on your device: nothing is uploaded or copied.

Plain HTML, CSS and JavaScript modules. No frameworks, no build step, no dependencies.

## Features

- Pick a music folder or individual audio files
- Reads tags and embedded cover art from ID3 (MP3), FLAC, Ogg/Opus Vorbis comments and MP4/M4A; falls back to `cover.jpg` / `folder.jpg`-style images in the folder
- Fast search across the library, virtualized list for large collections
- Play all / shuffle all, shuffle and repeat (off / all / one) modes, remembered between launches
- Queue: "Play next", "Add to queue", drag-to-reorder, remove, move to top
- Full-screen "Now playing" sheet with seek bar and swipe between tracks
- Lock screen and headset controls via the Media Session API
- Works offline after the first visit (service worker cache)
- Installable to the home screen
- English and Russian UI, chosen from the browser language or set manually in Settings

Supported formats depend on the browser: typically MP3, M4A/M4B, AAC, FLAC, OGG/OGA, Opus, WAV, WebM.

## Running locally

Service workers and ES modules need an HTTP server, so opening `index.html` from disk will not work. Any static server will do:

```sh
npx serve .
```

or

```sh
python -m http.server 8080
```

To test on a phone, open the app over HTTPS (or `localhost`). Service workers and installation are not available over plain HTTP on other hosts.

## Deployment

Copy the repository contents to any static hosting (GitHub Pages, Netlify, Cloudflare Pages, nginx, etc.). The app uses relative paths, so it works from a subdirectory.

After changing any cached file, bump the `CACHE` version in [sw.js](sw.js) so clients pick up the update. When adding a new file, also add it to the `ASSETS` list there.

## Limitations

- Browsers do not keep access to a picked folder between launches, so the folder has to be chosen again after the app restarts. The last folder name is remembered and shown as a hint.
- The library index (track list, tags and cover thumbnails) is cached in IndexedDB, so it shows up instantly on the next launch. Playing still requires choosing the folder again; already known files are matched by path and size and are not re-read, so this takes seconds instead of a full rescan.

## Project structure

```
index.html              App markup and SVG icon sprite
manifest.webmanifest    PWA manifest
sw.js                   Service worker (offline cache)
css/app.css             Styles
js/app.js               UI wiring and app entry point
js/library.js           File import, track list, cover art
js/library-cache.js     IndexedDB cache of the library index and covers
js/player.js            Playback, queue, shuffle/repeat, Media Session
js/tags.js              Tag parsers: ID3, FLAC, Ogg, MP4
js/virtual-list.js      Virtualized scrolling list
js/sortable.js          Drag-to-reorder for the queue
js/swipe.js             Swipe gestures on the Now playing screen
js/i18n.js              Localization loader and plural rules
locales/*.json          UI strings (en, ru)
```

## Adding a language

1. Copy [locales/en.json](locales/en.json) to `locales/<code>.json` and translate the values.
2. Add the code to `SUPPORTED` in [js/i18n.js](js/i18n.js).
3. Add the file to `ASSETS` in [sw.js](sw.js) and bump `CACHE`.
