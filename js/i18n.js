export const SUPPORTED = ['en', 'ru'];
export const AUTO = 'auto';
const FALLBACK = 'en';
const LANG_KEY = 'tiny-player.lang';

let strings = {};
let plurals = new Intl.PluralRules(FALLBACK);

function systemLanguage() {
  const preferred = navigator.languages?.length ? navigator.languages : [navigator.language];
  return preferred.map(tag => tag.slice(0, 2).toLowerCase()).find(lang => SUPPORTED.includes(lang)) ?? FALLBACK;
}

function format(template, params) {
  return template.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '');
}

export function t(key, params = {}) {
  const value = strings[key];
  if (value && typeof value === 'object') {
    return format(value[plurals.select(params.count)] ?? value.other, params);
  }
  return format(value ?? key, params);
}

export function languageSetting() {
  const stored = localStorage.getItem(LANG_KEY);
  return SUPPORTED.includes(stored) ? stored : AUTO;
}

export function languageName(lang) {
  const name = new Intl.DisplayNames([lang], { type: 'language' }).of(lang) ?? lang;
  return name.charAt(0).toLocaleUpperCase(lang) + name.slice(1);
}

async function applyLanguage(lang) {
  strings = await fetch(`locales/${lang}.json`).then(response => response.json());
  plurals = new Intl.PluralRules(lang);
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of document.querySelectorAll('[data-i18n-label]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nLabel));
    el.title = t(el.dataset.i18nLabel);
  }
}

export function initI18n() {
  const setting = languageSetting();
  return applyLanguage(setting === AUTO ? systemLanguage() : setting);
}

export function setLanguage(setting) {
  if (setting === AUTO) localStorage.removeItem(LANG_KEY);
  else localStorage.setItem(LANG_KEY, setting);
  return initI18n();
}
