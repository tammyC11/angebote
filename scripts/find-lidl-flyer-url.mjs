#!/usr/bin/env node
/**
 * find-lidl-flyer-url — print the leaflet API URL of each of this week's Lidl "Aktionsprospekt"
 * flyers (one per line), ready to pass to extract-flyer-lidl.
 *
 *   node scripts/find-lidl-flyer-url.mjs                       # prints the URL(s)
 *   node scripts/find-lidl-flyer-url.mjs --today 2026-11-22    # pretend it's that day
 *   node scripts/find-lidl-flyer-url.mjs | while read -r url; do npm run extract-flyer-lidl -- "$url"; done
 *
 * How it works
 * 1. Fetch https://www.lidl.de/c/online-prospekte/s10005610.
 * 2. Take every <a data-track-name="Aktionsprospekt"> and its href, e.g.
 *    https://www.lidl.de/l/prospekte/aktionsprospekt-23-11-2026-28-11-2026-7af21b/ar/0?_ab=1&lf=HHZ
 * 3. The flyer id is the part after /l/prospekte/: "aktionsprospekt-23-11-2026-28-11-2026-7af21b".
 * 4. Keep the flyers of the earliest week that has not ended yet — so on a Sunday that is the coming
 *    Mon–Sat, like get-aldi-offers.
 * 5. URL: https://endpoints.leaflets.schwarz/v4/flyer?flyer_identifier=<id>&region_id=0&region_code=0
 *
 * Lidl sometimes lists two flyers for the same week (same dates, different hash); all of them are
 * printed, in page order. This is not a public API: the page can change without notice. Node 22+.
 */
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { fetchWithRetry } from "./fetch-with-retry.mjs";

export const FLYERS_PAGE = "https://www.lidl.de/c/online-prospekte/s10005610";
const FLYER_API = "https://endpoints.leaflets.schwarz/v4/flyer";
const USAGE = "usage: find-lidl-flyer-url [--today YYYY-MM-DD]";

const decodeEntities = (s) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x2F;/gi, "/").replace(/&#39;|&#x27;/gi, "'");

/** Every Aktionsprospekt on the page, in page order: [{ id, start, end }] (dates as YYYY-MM-DD). */
export function parseAktionsprospekte(html) {
  const found = [];
  for (const [tag] of html.matchAll(/<a\b[^>]*>/gis)) {
    if (!/\sdata-track-name\s*=\s*"Aktionsprospekt"/i.test(tag)) continue;
    const href = /\shref\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
    if (!href) continue;
    const id = /\/l\/prospekte\/(aktionsprospekt-(\d{2})-(\d{2})-(\d{4})-(\d{2})-(\d{2})-(\d{4})-[0-9a-f]+)(?:[/?#]|$)/i.exec(decodeEntities(href));
    if (!id) continue;
    const [, slug, d1, m1, y1, d2, m2, y2] = id;
    if (found.some((f) => f.id === slug)) continue;
    found.push({ id: slug, start: `${y1}-${m1}-${d1}`, end: `${y2}-${m2}-${d2}` });
  }
  return found;
}

/** The flyers to extract on `today` (YYYY-MM-DD): all those of the earliest week not yet over, in page order. */
export function pickFlyers(flyers, today) {
  const current = flyers.filter((f) => f.end >= today);
  if (!current.length) throw new Error(`no Aktionsprospekt on ${FLYERS_PAGE} ends on or after ${today}`);
  const start = current.reduce((min, f) => (f.start < min ? f.start : min), current[0].start);
  return current.filter((f) => f.start === start);
}

export function flyerApiUrl(id) {
  return `${FLYER_API}?flyer_identifier=${encodeURIComponent(id)}&region_id=0&region_code=0`;
}

const berlinToday = (now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

/** The leaflet API URLs of this week's flyers (usually one, sometimes two). */
export async function findLidlFlyerUrls({ today = berlinToday(), fetchImpl = fetch, log = console.error } = {}) {
  const res = await fetchWithRetry(FLYERS_PAGE, { fetchImpl });
  const flyers = parseAktionsprospekte(await res.text());
  if (!flyers.length) throw new Error(`no Aktionsprospekt link found on ${FLYERS_PAGE} (did the page change?)`);
  const picked = pickFlyers(flyers, today);
  log(`Lidl: ${flyers.length} Aktionsprospekte listed; using ${picked.map((f) => f.id).join(", ")} (${picked[0].start} – ${picked[0].end})`);
  return picked.map((f) => flyerApiUrl(f.id));
}

async function main() {
  const { values } = parseArgs({ options: { today: { type: "string" } } });
  if (values.today && !/^\d{4}-\d{2}-\d{2}$/.test(values.today)) throw new Error(`--today must be YYYY-MM-DD, got "${values.today}"\n${USAGE}`);
  for (const url of await findLidlFlyerUrls({ today: values.today })) console.log(url);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(`find-lidl-flyer-url: ${err.message}`);
    process.exit(1);
  });
}
