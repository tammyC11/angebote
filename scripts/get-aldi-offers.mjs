#!/usr/bin/env node
/**
 * get-aldi-offers — read the week's ALDI SÜD flyer (Prospekt) as data.
 *
 *   node scripts/get-aldi-offers.mjs                                    # finds the coming week's flyer
 *   node scripts/get-aldi-offers.mjs "https://prospekt.aldi-sued.de/kw48-26-op-mp"   # or name it
 *   node scripts/get-aldi-offers.mjs --today 2026-11-22
 *
 * No AI needed. The flyer viewer at prospekt.aldi-sued.de (by Publitas) loads, per page,
 * the offers printed on it as JSON — name, brand, sale price, regular price, discount,
 * start date, unit price, product photo and where it sits on the page:
 *   1. www.aldi-sued.de/prospekte        → the flyer for the week (kw48-26-…)
 *   2. <flyer>/data.json                 → flyer id and page count
 *   3. <flyer>/spreads.json              → every page with its image
 *   4. <flyer>/page/<n>/hotspots_data.json → the offers on page n
 * These are not public APIs: no key needed, but they can change without notice.
 *
 * The week: run on a Sunday, it is the coming Monday–Saturday; on any other day,
 * the current Monday–Saturday.
 *
 * Output: data/aldi/Prospekt-<DD-MM-YYYY>-<DD-MM-YYYY>.json. One `pages` entry per flyer page, products with their page and
 * `image_bbox` on it. ALDI-only details (offer id, start date, unit price, badges, product
 * photo) are in the page's `aldi` list, in the same order as that page's products.
 *
 * Options
 *   --out <dir>          output folder (default: data/aldi)
 *   --today YYYY-MM-DD   pretend today is this date (default: today in Berlin; or TODAY env)
 *
 * Node 22+. No dependencies.
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { fetchWithRetry } from "./fetch-with-retry.mjs";

export const FLYER_HOST = "https://prospekt.aldi-sued.de";
export const PROSPEKTE_PAGE = "https://www.aldi-sued.de/prospekte";
export const IMAGE_KEY = "at1200"; // page images come at200 … at2400; 1200 px tall is plenty to read
const USAGE = 'usage: get-aldi-offers ["https://prospekt.aldi-sued.de/<flyer>"] [--today YYYY-MM-DD] [--out data/aldi]';

// ── dates ─────────────────────────────────────────────────────────────────────

function berlinToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const DAY = 86_400_000;
const toTime = (iso) => Date.parse(`${iso}T00:00:00Z`);
const addDays = (iso, n) => new Date(toTime(iso) + n * DAY).toISOString().slice(0, 10);
const dmy = (iso, sep) => iso.split("-").reverse().join(sep); // 2026-11-23 → 23.11.2026

/** Monday–Saturday to collect: the coming week on a Sunday, otherwise this week. */
export function offerWeek(today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today ?? "")) throw new Error(`today must be YYYY-MM-DD, got "${today}"`);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const start = addDays(today, weekday === 0 ? 1 : 1 - weekday);
  return { start, end: addDays(start, 5) };
}

/** ISO 8601 week number and its year: 2026-11-23 → { week: 48, year: 2026 }. */
export function isoWeek(iso) {
  const d = new Date(toTime(iso));
  const thursday = new Date(d.getTime() + (3 - ((d.getUTCDay() + 6) % 7)) * DAY); // the week's Thursday decides the year
  const year = thursday.getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / DAY / 7);
  return { week, year };
}

/** "23.11." → "2026-11-23", taking the year from the offer week (also across New Year). */
export function dayMonthToIso(text, week) {
  const m = /^(\d{1,2})\.(\d{1,2})\.?$/.exec(String(text ?? "").trim());
  if (!m) return null;
  const pad = (n) => String(n).padStart(2, "0");
  const year = Number(week.start.slice(0, 4));
  const candidates = [year - 1, year, year + 1].map((y) => `${y}-${pad(m[2])}-${pad(m[1])}`);
  return candidates.reduce((best, c) => (Math.abs(toTime(c) - toTime(week.start)) < Math.abs(toTime(best) - toTime(week.start)) ? c : best));
}

// ── which flyer ───────────────────────────────────────────────────────────────

/** A flyer URL (any page of it) or its bare name → "kw48-26-op-mp". */
export function checkFlyerInput(input) {
  const s = String(input ?? "").trim();
  if (/^[a-z0-9][a-z0-9-]*$/i.test(s)) return s;
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new Error(`not a flyer URL or name: "${s}"\n${USAGE}`);
  }
  const slug = url.pathname.split("/").filter(Boolean)[0];
  if (url.origin !== FLYER_HOST || !slug) throw new Error(`expected ${FLYER_HOST}/<flyer>, got ${url.origin}${url.pathname}\n${USAGE}`);
  return slug;
}

/** The week's flyer among the links on www.aldi-sued.de/prospekte ("kw48-26-…" for week 48 of 2026). */
export function findFlyerSlug(html, week) {
  const { week: kw, year } = isoWeek(week.start);
  const found = [...new Set([...html.matchAll(/https:\/\/prospekt\.aldi-sued\.de\/(kw\d{1,2}-\d{2}-[a-z0-9-]+)/g)].map((m) => m[1]))];
  const want = new RegExp(`^kw0?${kw}-${String(year % 100).padStart(2, "0")}-`);
  const slug = found.find((s) => want.test(s));
  if (!slug) {
    throw new Error(`no flyer for week ${kw}/${year} (${week.start}) on ${PROSPEKTE_PAGE}; found: ${found.join(", ") || "none"}`);
  }
  return slug;
}

// ── flyer data → our shape ────────────────────────────────────────────────────

/** spreads.json → [{ number, image_url }] in page order. */
export function listPages(spreads, imageKey = IMAGE_KEY) {
  if (!Array.isArray(spreads)) throw new Error("spreads.json: not a list — has the viewer changed?");
  const pages = spreads.flatMap((s) => s.pages ?? []).map((p) => {
    const img = p.images?.[imageKey];
    return { number: p.number, image_url: img ? new URL(img, FLYER_HOST).href : null };
  });
  if (pages.length === 0) throw new Error("spreads.json: no pages");
  return pages.sort((a, b) => a.number - b.number);
}

const num = (s) => (s === undefined || s === null || s === "" || Number.isNaN(Number(s)) ? null : Number(s));
const round4 = (x) => Math.round(Math.min(1, Math.max(0, x)) * 10_000) / 10_000;

/** Hotspot position on the page (0–1) → [x1, y1, x2, y2]. */
export function toBox(pos) {
  if (![pos?.left, pos?.top, pos?.width, pos?.height].every(Number.isFinite)) return null;
  return [round4(pos.left), round4(pos.top), round4(pos.left + pos.width), round4(pos.top + pos.height)];
}

/** Why a hotspot product is not an offer, or null if it is one. */
export function notAnOffer(p) {
  if (/^recipe-/.test(p.webshopIdentifier ?? "")) return "recipe";
  if (p.removedFromFeed) return "removed from feed";
  if (num(p.discountedPrice ?? p.price) === null) return "no price";
  return null;
}

/** One hotspot product → a catalog product. */
export function toProduct(p, { page, box, week }) {
  const sale = num(p.discountedPrice);
  const regular = num(p.price);
  const start = dayMonthToIso(p.customLabel1, week);
  return {
    product: p.title?.trim() || null,
    brand: p.brand?.trim() || null,
    price: sale ?? regular,
    original_price: sale !== null ? regular : null, // "price" is the crossed-out price when there is a discounted one
    discount: num(p.customLabel0) !== null ? `-${num(p.customLabel0)}%` : null,
    // description, unit price (+ deposit), and the start day when it isn't Monday
    detail:
      [p.description, p.customLabel9, start && start !== week.start ? `Verfügbar ab ${dmy(start, ".")}` : null]
        .map((s) => s?.trim())
        .filter(Boolean)
        .join("\n") || null,
    image_bbox: box,
    page,
  };
}

/** The ALDI-only details kept next to each product. */
export function aldiDetails(p, week) {
  return {
    id: p.webshopIdentifier ?? null, // "731631_kw48": article number _ week
    start_date: dayMonthToIso(p.customLabel1, week),
    unit_price: p.customLabel9 ?? null, // "kg-Preis 7.58", "l-Preis 0.70; zzgl. Pfand 0.25"
    badges: [p.customLabel12, p.customLabel5].filter(Boolean), // "Aktion", "XXL"
    product_type: p.productType ?? null, // ALDI's own category, e.g. "Geflügel frisch - Hühnchen frisch"
    photo_url: p.photoSharingUrl ?? null, // the product on its own, without the flyer around it
  };
}

/** One page's hotspots → { products, aldi, skipped }. */
export function readPage(hotspots, { page, week }) {
  if (!Array.isArray(hotspots)) throw new Error(`page ${page}: hotspots are not a list`);
  const products = [];
  const aldi = [];
  const skipped = [];
  for (const h of hotspots) {
    if (h.type !== "product") continue; // links, page references, images
    // positions are cut to this page: an offer on the facing page comes back with width or height 0
    if (!(h.position?.width > 0 && h.position?.height > 0)) continue;
    const box = toBox(h.position);
    for (const p of h.products ?? []) {
      const why = notAnOffer(p);
      if (why) {
        skipped.push({ title: p.title ?? null, reason: why });
        continue;
      }
      products.push(toProduct(p, { page, box, week }));
      aldi.push(aldiDetails(p, week));
    }
  }
  return { products, aldi, skipped };
}

/** Everything read → the result file, in the shared flyer format. */
export function buildResult({ slug, data, week, pages, now = new Date() }) {
  const { week: kw } = isoWeek(week.start);
  const outPages = [];
  const products = [];
  for (const pg of pages) {
    if (pg.error) {
      outPages.push({ page: pg.number, image_url: pg.image_url, status: "failed", error: pg.error });
      continue;
    }
    const r = readPage(pg.hotspots, { page: pg.number, week });
    products.push(...r.products);
    outPages.push({
      page: pg.number,
      image_url: pg.image_url,
      status: "ok",
      offers: r.products.length,
      ...(r.skipped.length ? { skipped: r.skipped } : {}),
      aldi: r.aldi,
    });
  }
  const failed = outPages.filter((p) => p.status === "failed").map((p) => p.page);
  return {
    source: {
      flyer_url: `${FLYER_HOST}/${slug}/`,
      flyer_id: data?.id != null ? String(data.id) : null,
      title: `ALDI SÜD Prospekt KW${kw}: ${dmy(week.start, ".")} – ${dmy(week.end, ".")}`,
      offer_start: week.start,
      offer_end: week.end,
      image_key: IMAGE_KEY,
    },
    model: null, // read from the flyer's own data, no AI
    prompt_sha256: null,
    extracted_at: now.toISOString(),
    complete: failed.length === 0,
    failed_pages: failed,
    usage: { input_tokens: 0, output_tokens: 0 },
    pages: outPages,
    products,
  };
}

/** "Prospekt-23-11-2026-28-11-2026" */
export function outputName(week) {
  return `Prospekt-${dmy(week.start, "-")}-${dmy(week.end, "-")}`;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

/** Run fn over items, at most `limit` at a time, results in item order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function getAldiOffers({
  flyer,
  today = berlinToday(),
  outDir = "data/aldi",
  fetchImpl = fetch,
  concurrency = 4,
  log = console.error,
  now = new Date(),
} = {}) {
  const week = offerWeek(today);
  const getText = async (url, accept) => (await fetchWithRetry(url, { fetchImpl, headers: { Accept: accept } })).text();
  const getJson = async (url) => JSON.parse(await getText(url, "application/json"));

  const slug = flyer ? checkFlyerInput(flyer) : findFlyerSlug(await getText(PROSPEKTE_PAGE, "text/html"), week);
  const base = `${FLYER_HOST}/${slug}`;
  const data = await getJson(`${base}/data.json`);
  const pages = listPages(await getJson(`${base}/spreads.json`));
  if (data?.numPages && data.numPages !== pages.length) log(`note: data.json says ${data.numPages} pages, spreads.json has ${pages.length}`);
  log(`${base}/ — ${pages.length} pages, week ${week.start} – ${week.end}`);

  const read = await mapLimit(pages, concurrency, async (pg) => {
    try {
      return { ...pg, hotspots: await getJson(`${base}/page/${pg.number}/hotspots_data.json`) };
    } catch (err) {
      return { ...pg, error: err.message };
    }
  });

  const result = buildResult({ slug, data, week, pages: read, now });
  // a flyer for another week would still "work" — make sure its offers start in this one
  const starts = result.pages.flatMap((p) => p.aldi ?? []).map((a) => a.start_date).filter(Boolean);
  if (starts.length && !starts.some((d) => d >= week.start && d <= week.end)) {
    throw new Error(`flyer ${slug} has no offers starting ${week.start} – ${week.end} (first: ${starts.sort()[0]}) — wrong flyer?`);
  }
  if (result.products.length === 0 && result.failed_pages.length === 0) throw new Error(`flyer ${slug}: no offers on any page — has the viewer changed?`);

  const outFile = path.join(outDir, `${outputName(week)}.json`);
  await mkdir(outDir, { recursive: true });
  await writeFile(`${outFile}.tmp`, JSON.stringify(result, null, 2) + "\n");
  await rename(`${outFile}.tmp`, outFile); // never leave a half-written file
  log(
    `${result.source.title}: ${result.products.length} offers on ${result.pages.length} pages → ${outFile}` +
      (result.failed_pages.length ? ` (could not read pages ${result.failed_pages.join(", ")})` : ""),
  );
  return { outFile, result };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string", default: "data/aldi" },
      today: { type: "string", default: process.env.TODAY || undefined },
    },
  });
  if (positionals.length > 1) throw new Error(`expected at most one flyer URL, got ${positionals.length}\n${USAGE}`);
  const { result } = await getAldiOffers({
    flyer: positionals[0],
    outDir: values.out,
    ...(values.today ? { today: values.today } : {}),
  });
  if (result.failed_pages.length) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(`get-aldi-offers: ${err.message}`);
    process.exit(1);
  });
}
