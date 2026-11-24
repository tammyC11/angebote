// site.js — shared by index.html and offer.html.
// Texts in three languages, the language (from ?lang=…, then the last choice, then German),
// favourites, and how an offer is drawn. Needs catalog.js loaded first (window.CATALOG).

const byId = id => document.getElementById(id);
const offers = window.CATALOG ?? [];
const offersById = new Map(offers.map(offer => [offer.id, offer]));
const retailers = { lidl: 'Lidl', aldi: 'ALDI SÜD', edeka: 'EDEKA Braun' };
const categoryNames = new Map(offers.filter(offer => offer.categories).map(offer => [offer.category, offer.categories]));
const storageKey = 'weekly-offers.favorites.v1';
const languageKey = 'weekly-offers.language.v1';

const translations = {
  en: {
    title: 'Weekly offers', week: 'Flyer week', language: 'Language', search: 'Search for a product or brand',
    filters: 'Filter offers', all: 'All stores', categoryFilters: 'Filter by category', allCategories: 'All categories', offers: 'Offers', saved: 'Favorites',
    more: 'Show more offers', close: 'Close', preview: 'Upcoming',
    noImage: 'No product image', noPrice: 'See flyer for price', loyalty: 'With Lidl Plus',
    appOnly: 'EDEKA app only', app: 'With app', from: 'From', until: 'Until', valid: 'Valid',
    share: 'Copy product link', copied: 'Link copied', manualCopy: 'Copy this product link',
    back: 'All offers', notFound: 'This offer is no longer in the catalog.',
    source: 'Open offer source', details: (name, store) => `Details for ${name} at ${store}`,
    favorite: name => `Save ${name} to favorites`, unfavorite: name => `Remove ${name} from favorites`,
    count: n => `${n} ${n === 1 ? 'offer' : 'offers'}`, empty: 'No offers match these filters.',
    emptySaved: 'No saved offers match these filters.',
    storage: 'Browser storage is unavailable. Favorites will last until you reload.'
  },
  de: {
    title: 'Wochenangebote', week: 'Prospektwoche', language: 'Sprache', search: 'Produkt oder Marke suchen',
    filters: 'Angebote filtern', all: 'Alle Märkte', categoryFilters: 'Nach Kategorie filtern', allCategories: 'Alle Kategorien', offers: 'Angebote', saved: 'Merkliste',
    more: 'Weitere Angebote anzeigen', close: 'Schließen', preview: 'Vorschau',
    noImage: 'Kein Produktbild', noPrice: 'Preis siehe Prospekt', loyalty: 'Mit Lidl Plus',
    appOnly: 'Nur mit EDEKA App', app: 'Mit App', from: 'Ab', until: 'Bis', valid: 'Gültig',
    share: 'Produktlink kopieren', copied: 'Link kopiert', manualCopy: 'Diesen Produktlink kopieren',
    back: 'Alle Angebote', notFound: 'Dieses Angebot ist nicht mehr im Katalog.',
    source: 'Angebotsquelle öffnen', details: (name, store) => `Details zu ${name} bei ${store}`,
    favorite: name => `${name} merken`, unfavorite: name => `${name} aus Merkliste entfernen`,
    count: n => `${n} ${n === 1 ? 'Angebot' : 'Angebote'}`, empty: 'Keine Angebote für diese Auswahl.',
    emptySaved: 'Keine gemerkten Angebote für diese Auswahl.',
    storage: 'Der Browser erlaubt keine dauerhafte Speicherung. Die Merkliste gilt bis zum Neuladen.'
  },
  'zh-TW': {
    title: '每週特價', week: '優惠週期', language: '語言', search: '搜尋商品或品牌',
    filters: '篩選優惠', all: '所有超市', categoryFilters: '依類別篩選', allCategories: '所有類別', offers: '優惠商品', saved: '我的收藏',
    more: '顯示更多優惠', close: '關閉', preview: '即將開始',
    noImage: '沒有商品圖片', noPrice: '價格請見型錄', loyalty: '限 Lidl Plus 會員',
    appOnly: '限 EDEKA App', app: 'App 優惠價', from: '開始日期', until: '截止日期', valid: '優惠期間',
    share: '複製商品連結', copied: '已複製連結', manualCopy: '請複製此商品連結',
    back: '所有優惠', notFound: '此優惠已不在目錄中。',
    source: '查看優惠來源', details: (name, store) => `查看 ${store} 的 ${name} 詳情`,
    favorite: name => `將 ${name} 加入收藏`, unfavorite: name => `從收藏移除 ${name}`,
    count: n => `${n} 項優惠`, empty: '沒有符合篩選條件的優惠。',
    emptySaved: '沒有符合篩選條件的收藏。',
    storage: '瀏覽器無法儲存收藏。重新載入頁面後，本次變更將會消失。'
  }
};

// ── language: ?lang=de | en | zh in the address ─────────────────────────────

// the code in the address → the language the page uses (zh_tw is Traditional Chinese, Taiwan)
const languageCodes = { de: 'de', en: 'en', zh: 'zh-TW' };
const languageCode = (lang = language) => Object.keys(languageCodes).find(code => languageCodes[code] === lang) ?? 'de';

function languageFromUrl() {
  const value = new URLSearchParams(location.search).get('lang')?.toLowerCase().replace('_', '-');
  if (value === 'zh-tw') return 'zh-TW';
  return languageCodes[value] ?? null;
}

function storedLanguage() {
  try {
    const stored = localStorage.getItem(languageKey);
    return Object.hasOwn(translations, stored) ? stored : null;
  } catch {
    return null; // German remains the default when storage is unavailable.
  }
}

let language = languageFromUrl() ?? storedLanguage() ?? 'de';
let t;
let euro;
let dates;

/** Put the current language into the address (?lang=…), keeping everything else. */
function writeLanguageToUrl() {
  const url = new URL(location.href);
  url.searchParams.set('lang', languageCode());
  try {
    history.replaceState(history.state, '', url);
  } catch {
    // Some browsers disallow changing the URL of a local file.
  }
}

function setLanguage(lang) {
  language = Object.hasOwn(translations, lang) ? lang : 'de';
  try {
    localStorage.setItem(languageKey, language);
  } catch {
    // The selected language still applies to this view.
  }
  writeLanguageToUrl();
}

/** Texts, number and date formats for the current language. */
function applyTexts() {
  t = translations[language];
  euro = new Intl.NumberFormat(language, { style: 'currency', currency: 'EUR' });
  dates = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeZone: 'UTC' });
  document.documentElement.lang = language;
}

// ── helpers ──────────────────────────────────────────────────────────────────

const berlinDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
const date = value => dates.format(new Date(value + 'T00:00:00Z'));
const normalize = value => value.toLocaleLowerCase('de-DE').replaceAll('ß', 'ss')
  .normalize('NFD').replace(/\p{Diacritic}/gu, '');
const displayName = offer => offer.names?.[language] ?? offer.name;
const categoryName = key => categoryNames.get(key)?.[language] ?? key;

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content != null) node.textContent = content;
  return node;
}

// ── favourites ───────────────────────────────────────────────────────────────
// Each page defines favoritesChanged({ stored, activeButton }) to update itself.

let favorites = new Set();

function readFavorites(value) {
  const parsed = JSON.parse(value ?? '[]');
  return new Set(Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : []);
}

try {
  favorites = readFavorites(localStorage.getItem(storageKey));
} catch {
  // The catalog can still run if browser storage is unavailable.
}

function updateHeart(button) {
  const offer = button.dataset.name;
  const active = favorites.has(button.dataset.favorite);
  button.setAttribute('aria-pressed', String(active));
  button.setAttribute('aria-label', (active ? t.unfavorite : t.favorite)(offer));
  button.textContent = active ? '♥' : '♡';
}

function syncHearts() {
  document.querySelectorAll('[data-favorite]').forEach(updateHeart);
}

function toggleFavorite(id) {
  const activeButton = document.activeElement;
  if (favorites.has(id)) favorites.delete(id);
  else favorites.add(id);
  let stored = true;
  try {
    localStorage.setItem(storageKey, JSON.stringify([...favorites]));
  } catch {
    stored = false;
  }
  favoritesChanged({ stored, activeButton });
}

function heart(offer) {
  const button = element('button', 'heart');
  button.type = 'button';
  button.dataset.favorite = offer.id;
  button.dataset.name = displayName(offer);
  updateHeart(button);
  button.addEventListener('click', () => toggleFavorite(offer.id));
  return button;
}

/** Read the favourites from local storage again and let the page redraw its hearts. */
function reloadFavorites(value) {
  try {
    favorites = readFavorites(value === undefined ? localStorage.getItem(storageKey) : value);
    favoritesChanged({});
  } catch {
    // Ignore malformed values, or storage that is unavailable.
  }
}

// Another tab changed the favourites.
window.addEventListener('storage', event => {
  if (event.key === storageKey || event.key === null) reloadFavorites(event.newValue);
});

// Back/forward: the browser can show this page again from memory without loading it, so
// favourites changed on another page in the meantime (e.g. offer.html) would be missed.
window.addEventListener('pageshow', event => {
  if (event.persisted) reloadFavorites();
});

// ── drawing an offer ─────────────────────────────────────────────────────────

function media(offer, large) {
  const box = element('div', 'media');
  box.append(element('span', 'fallback', t.noImage));
  if (!offer.photo) {
    box.classList.add('missing');
    return box;
  }
  const image = element('img');
  image.alt = '';
  image.loading = large ? 'eager' : 'lazy';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  image.addEventListener('error', () => box.classList.add('missing'), { once: true });
  image.src = offer.photo;
  const [left, top, right, bottom] = offer.crop ?? [];
  const width = right - left;
  const height = bottom - top;
  if (width > 0 && height > 0) {
    const crop = element('div', 'crop');
    const ratio = offer.ratio * width / height;
    crop.style.setProperty('--ratio', ratio);
    crop.style.setProperty('--crop-width', (large ? 220 : 178) * ratio + 'px');
    image.style.width = 100 / width + '%';
    image.style.height = 100 / height + '%';
    image.style.left = -100 * left / width + '%';
    image.style.top = -100 * top / height + '%';
    crop.append(image);
    box.append(crop);
  } else {
    box.append(image);
  }
  return box;
}

/** The card's text: store and category labels, name, brand, prices, conditions. */
function summary(offer, full = false) {
  const copy = element('div', 'copy');
  const heading = element('h2', '', displayName(offer));
  heading.lang = displayName(offer) === offer.name ? 'de' : language;
  if (full) heading.id = 'detail-title';
  const tags = element('div', 'tags');
  tags.append(element('span', 'store ' + offer.retailer, offer.store ?? retailers[offer.retailer]));
  if (offer.category) tags.append(element('span', 'category', categoryName(offer.category)));
  copy.append(tags, heading);
  if (offer.brand && normalize(offer.brand) !== normalize(offer.name)) copy.append(element('span', 'brand', offer.brand));

  const prices = element('div', 'prices');
  prices.append(offer.price == null
    ? element('span', 'price unknown', t.noPrice)
    : element('strong', 'price', euro.format(offer.price)));
  if (offer.originalPrice != null) prices.append(element('del', '', euro.format(offer.originalPrice)));
  if (offer.discount) prices.append(element('span', 'discount', offer.discount));
  copy.append(prices);
  if (offer.unit) copy.append(element('span', 'unit', offer.unit));

  const conditions = [];
  if (offer.loyalty) conditions.push(t.loyalty);
  if (offer.appOnly) conditions.push(t.appOnly);
  else if (offer.appPrice != null) conditions.push(t.app + ' ' + euro.format(offer.appPrice));
  if (offer.start > offer.week) conditions.push(t.from + ' ' + date(offer.start));
  if (offer.end && offer.end < offer.weekEnd) conditions.push(t.until + ' ' + date(offer.end));
  if (conditions.length) {
    const row = element('div', 'conditions');
    row.append(...conditions.map(condition => element('span', 'condition', condition)));
    copy.append(row);
  }
  return copy;
}

/** The full text: the card's, plus validity, badges, description and a link to the source. */
function detailCopy(offer) {
  const copy = summary(offer, true);
  const datesLabel = [t.valid, date(offer.start), '–', date(offer.end)].join(' ');
  copy.append(element('p', 'validity', datesLabel));
  if (offer.badges?.length) copy.append(element('p', 'unit', offer.badges.join(' · ')));
  if (offer.detail) {
    const description = element('p', 'description', offer.detail);
    description.lang = 'de';
    copy.append(description);
  }
  if (offer.source && /^https?:\/\//i.test(offer.source)) {
    const link = element('a', 'source', t.source);
    link.href = offer.source;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    copy.append(link);
  }
  return copy;
}

/** The link to one offer's own page, in the current language. */
function offerPageUrl(offer) {
  const url = new URL('offer.html', location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('id', offer.id);
  url.searchParams.set('lang', languageCode());
  return url.href;
}
