#!/usr/bin/env node
/**
 * get-edeka-offers — read one EDEKA store's weekly offers from edeka.de.
 *
 *   node scripts/get-edeka-offers.mjs "https://www.edeka.de/maerkte/034462/angebote/"
 *
 * No AI needed: the store's offers page already contains every offer as HTML.
 * Each offer has a detail dialog (<dialog id="dialog-angebot-…">) with its name,
 * prices, description, unit price and product photo. "Mehr laden" on the page only
 * un-hides offers that are already there, so one download gets them all.
 *
 * Output: data/edeka/Angebote-<store id>-<DD-MM-YYYY>-<DD-MM-YYYY>.json.
 * Each offer gets its own entry in `pages` (its photo),
 * so `image_bbox` is the whole picture: [0, 0, 1, 1]. EDEKA-only details (category,
 * offer id, EAN, app price, end date) are in that `pages` entry under `edeka`.
 *
 * Options
 *   --out <dir>   output folder (default: data/edeka)
 *
 * Node 22+. No dependencies.
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { fetchWithRetry } from "./fetch-with-retry.mjs";

const USAGE = 'usage: get-edeka-offers "https://www.edeka.de/maerkte/<store id>/angebote/"';

// ── input ─────────────────────────────────────────────────────────────────────

/**
 * The store's offers page URL. Also accepts the store's flyer page
 * (…/maerkte/<id>/prospekte/…) and turns it into the offers page.
 */
export function checkOffersUrl(input) {
  if (!input) throw new Error(`missing URL\n${USAGE}`);
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`not a URL: "${input}"\n${USAGE}`);
  }
  const m = /^\/maerkte\/(\d+)\/(angebote|prospekte)(\/|$)/.exec(url.pathname);
  if (url.protocol !== "https:" || url.hostname !== "www.edeka.de" || !m) {
    throw new Error(`expected https://www.edeka.de/maerkte/<store id>/angebote/, got ${url.origin}${url.pathname}\n${USAGE}`);
  }
  const storeId = m[1];
  return { url: `https://www.edeka.de/maerkte/${storeId}/angebote/`, storeId };
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

const ENTITIES = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", nbsp: " " };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

/**
 * Visible text of an HTML fragment, like a browser shows it: line breaks in the
 * HTML source are just spaces, only <br> starts a new line.
 */
export function textOf(html) {
  const BR = "\u0000";
  return decodeEntities(html.replace(/<br\s*\/?>/gi, BR).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .split(BR)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

const toNumber = (s) => Number(String(s).replace(",", "."));
const dmyToIso = (dmy) => dmy.split(".").reverse().join("-"); // 23.11.2026 → 2026-11-23

// ── page parsing ──────────────────────────────────────────────────────────────

/** "Gültig vom <strong>23.11.2026</strong> bis zum <strong>28.11.2026</strong>" */
export function parseValidity(html) {
  const m = /Gültig vom\s*<strong>(\d{2}\.\d{2}\.\d{4})<\/strong>\s*bis zum\s*<strong>(\d{2}\.\d{2}\.\d{4})<\/strong>/.exec(html);
  if (!m) throw new Error('no "Gültig vom … bis zum …" on the page — has the page changed?');
  return { start: dmyToIso(m[1]), end: dmyToIso(m[2]), startText: m[1], endText: m[2] };
}

/** One offer from its <dialog> block. Throws if name or price is missing. */
export function parseOfferDialog(block) {
  const uuid = /id="dialog-angebot-([0-9a-f-]{36})"/.exec(block)?.[1] ?? null;

  let tracking = {};
  const ev = /data-tracking-event="([^"]*)"/.exec(block)?.[1];
  if (ev) {
    try {
      tracking = JSON.parse(decodeEntities(ev))[1] ?? {};
    } catch {
      tracking = {};
    }
  }

  const name = textOf(/<h3[^>]*>([\s\S]*?)<\/h3>/.exec(block)?.[1] ?? "").replace(/^Angebot:\s*/, "");
  // screen-reader price labels, e.g. "Festpreis von 1.79€", "App Preis von 1.54€",
  // "Rabattierter Preis von 1.88€ (Insgesamt -53% Rabatt)"
  const prices = {};
  let labelDiscount = null;
  for (const m of block.matchAll(/<span class="sr-only">\s*([^<]*?)\s+von\s+([\d.,]+)\s*€\s*([^<]*?)\s*<\/span>/g)) {
    prices[m[1]] = toNumber(m[2]);
    const pct = /(-\d+)\s*%/.exec(m[3])?.[1];
    if (pct && !labelDiscount) labelDiscount = `${pct}%`;
  }
  const description = textOf(/<p class="line-clmap-2">([\s\S]*?)<\/p>/.exec(block)?.[1] ?? "") || null;
  const unitPrice = textOf(/<span class="text-grey">([\s\S]*?)<\/span>/.exec(block)?.[1] ?? "") || null;
  // legally required reference for reductions: "Niedrigster Gesamtpreis der letzten 30 Tage: 2,22 €"
  const lowestText = textOf(/<p class="text-grey">([\s\S]*?)<\/p>/.exec(block)?.[1] ?? "") || null;
  const lowest30 = /letzten 30 Tage:\s*([\d.,]+)\s*€/.exec(lowestText ?? "")?.[1];
  // the large product photo (374 px); small brand logos come before it in some dialogs
  const image =
    /<img src="(https:\/\/offer-images\.api\.edeka\/[^"]+)"[^>]*width="374"/.exec(block)?.[1] ??
    [...block.matchAll(/<img src="(https:\/\/offer-images\.api\.edeka\/[^"]+)"/g)].at(-1)?.[1] ??
    null;

  const fixedPrice = prices["Festpreis"] ?? null;
  const discountedPrice = prices["Rabattierter Preis"] ?? null;
  const appPrice = prices["App Preis"] ?? null;
  if (!name) throw new Error(`offer ${uuid ?? "?"}: no name`);
  if (fixedPrice === null && discountedPrice === null && appPrice === null) {
    throw new Error(`offer "${name}": no price (labels: ${Object.keys(prices).join(", ") || "none"})`);
  }
  // "48% gespart!" in the description, if the price label has no percentage
  const gespart = /(\d+)\s*%\s*gespart/i.exec(description ?? "")?.[1];

  return {
    uuid,
    offerId: tracking.promotion_id ?? null,
    ean: tracking.promotion_item_included_products?.[0] ?? null,
    category: tracking.promotion_item_category ?? null,
    validUntil: tracking.promotion_item_expiration_date?.slice(0, 10) ?? null,
    name,
    fixedPrice,
    discountedPrice,
    appPrice,
    discount: labelDiscount ?? (gespart ? `-${gespart}%` : null),
    lowestPrice30Days: lowest30 ? toNumber(lowest30) : null,
    description,
    unitPrice,
    lowestPriceText: lowestText,
    image: image ? decodeEntities(image) : null,
  };
}

/** All offer dialogs on the page, in page order. Bad ones are returned as errors. */
export function parseOffersPage(html) {
  const blocks = [...html.matchAll(/<dialog id="dialog-angebot-[\s\S]*?<\/dialog>/g)].map((m) => m[0]);
  if (blocks.length === 0) throw new Error("no offers (dialog-angebot-…) on the page — has the page changed?");
  const storeName = textOf(/<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? "").replace(/^Angebote\s+/, "") || null;
  const offers = blocks.map((block) => {
    try {
      return { ok: true, offer: parseOfferDialog(block) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  return { storeName, validity: parseValidity(html), offers };
}

// ── shared flyer format ───────────────────────────────────

/** One EDEKA offer → a catalog product. */
export function toProduct(o, page) {
  const appNote = o.appPrice !== null ? `App-Preis: ${o.appPrice.toFixed(2)} €` : null;
  return {
    product: o.name,
    brand: null, // EDEKA puts the brand in the name ("Kühne Gurken")
    // the price everyone pays: reduced price, else the offer price; app-only offers: the app price
    price: o.discountedPrice ?? o.fixedPrice ?? o.appPrice,
    // EDEKA shows no regular price. The "lowest price of the last 30 days" shown with
    // reductions is not one: it can be below today's price (Leerdammer: 1.49 now, 1.29 lowest).
    // It stays in `detail` and in pages[].edeka.lowest_price_30_days.
    original_price: null,
    discount: o.discount,
    detail: [o.description, o.unitPrice, o.lowestPriceText, appNote].filter(Boolean).join("\n") || null,
    image_bbox: o.image ? [0, 0, 1, 1] : null, // the photo is the product
    page,
  };
}

/** The full result file, in the shared flyer format. */
export function buildResult({ url, storeId, html, now = new Date() }) {
  const { storeName, validity, offers } = parseOffersPage(html);
  const pages = [];
  const products = [];
  offers.forEach((r, i) => {
    const page = i + 1;
    if (!r.ok) {
      pages.push({ page, image_url: null, status: "failed", error: r.error });
      return;
    }
    const o = r.offer;
    pages.push({
      page,
      image_url: o.image,
      status: "ok",
      edeka: {
        offer_id: o.offerId,
        uuid: o.uuid,
        ean: o.ean,
        category: o.category,
        fixed_price: o.fixedPrice,
        discounted_price: o.discountedPrice,
        app_price: o.appPrice,
        lowest_price_30_days: o.lowestPrice30Days,
        valid_until: o.validUntil,
      },
    });
    products.push(toProduct(o, page));
  });
  const failed = pages.filter((p) => p.status === "failed").map((p) => p.page);

  return {
    source: {
      flyer_url: url,
      flyer_id: storeId,
      title: `${storeName ? `${storeName}: ` : ""}${validity.startText} – ${validity.endText}`,
      offer_start: validity.start,
      offer_end: validity.end,
      image_key: null,
    },
    model: null, // read from the page, no AI
    prompt_sha256: null,
    extracted_at: now.toISOString(),
    complete: failed.length === 0,
    failed_pages: failed,
    usage: { input_tokens: 0, output_tokens: 0 },
    pages,
    products,
  };
}

/** "Angebote-034462-23-11-2026-28-11-2026" */
export function outputName(storeId, validity) {
  const dmy = (iso) => iso.split("-").reverse().join("-");
  return `Angebote-${storeId}-${dmy(validity.start)}-${dmy(validity.end)}`;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

export async function getEdekaOffers(input, { outDir = "data/edeka", fetchImpl = fetch, log = console.error, now = new Date() } = {}) {
  const { url, storeId } = checkOffersUrl(input);
  const res = await fetchWithRetry(url, { fetchImpl, headers: { Accept: "text/html" } });
  const html = await res.text();
  const result = buildResult({ url, storeId, html, now });

  const outFile = path.join(outDir, `${outputName(storeId, { start: result.source.offer_start, end: result.source.offer_end })}.json`);
  await mkdir(outDir, { recursive: true });
  await writeFile(`${outFile}.tmp`, JSON.stringify(result, null, 2) + "\n");
  await rename(`${outFile}.tmp`, outFile); // never leave a half-written file
  log(
    `${result.source.title}: ${result.products.length} offers → ${outFile}` +
      (result.failed_pages.length ? ` (could not read ${result.failed_pages.length}: see pages with status "failed")` : ""),
  );
  return { outFile, result };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { out: { type: "string", default: "data/edeka" } },
  });
  if (positionals.length !== 1) throw new Error(positionals.length ? `expected one URL, got ${positionals.length}\n${USAGE}` : `missing URL\n${USAGE}`);
  const { result } = await getEdekaOffers(positionals[0], { outDir: values.out });
  if (result.failed_pages.length) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(`get-edeka-offers: ${err.message}`);
    process.exit(1);
  });
}
