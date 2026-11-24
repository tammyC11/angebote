import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildResult,
  checkFlyerInput,
  dayMonthToIso,
  findFlyerSlug,
  getAldiOffers,
  isoWeek,
  listPages,
  notAnOffer,
  offerWeek,
  outputName,
  readPage,
  toBox,
  toProduct,
} from "./get-aldi-offers.mjs";

// real responses from prospekt.aldi-sued.de/kw48-26-op-mp (22.11.2026), trimmed:
// spreads for pages 1–7, hotspots for pages 1, 3, 6 and 3 offers of page 7; recipe text shortened
const FIX = JSON.parse(await readFile(path.join(import.meta.dirname, "fixtures", "aldi-prospekt.json"), "utf8"));
const PROSPEKTE = await readFile(path.join(import.meta.dirname, "fixtures", "aldi-prospekte.html"), "utf8");
const WEEK = { start: "2026-11-23", end: "2026-11-28" };
const quiet = () => {};
const hotspot = (page, re) => FIX.hotspots[page].find((h) => h.products?.some((p) => re.test(p.title)));
const item = (page, re) => hotspot(page, re).products.find((p) => re.test(p.title));

/** A stand-in for the two websites, serving the fixtures. Pages without fixture hotspots have none. */
function fakeSites({ calls = [], failPage = null, spreads = FIX.spreads } = {}) {
  return async (url) => {
    calls.push(url);
    const u = new URL(url);
    const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url === "https://www.aldi-sued.de/prospekte") return new Response(PROSPEKTE, { headers: { "content-type": "text/html" } });
    if (u.origin !== "https://prospekt.aldi-sued.de") return new Response("not found", { status: 404 });
    if (u.pathname === "/kw48-26-op-mp/data.json") return json({ ...FIX.data, numPages: spreads.flatMap((s) => s.pages).length });
    if (u.pathname === "/kw48-26-op-mp/spreads.json") return json(spreads);
    const m = /^\/kw48-26-op-mp\/page\/(\d+)\/hotspots_data\.json$/.exec(u.pathname);
    if (m && Number(m[1]) === failPage) return new Response("gone", { status: 404 });
    if (m) return json(FIX.hotspots[m[1]] ?? []);
    return new Response("not found", { status: 404 });
  };
}

test("offerWeek and isoWeek", () => {
  assert.deepEqual(offerWeek("2026-11-22"), WEEK); // Sunday night run → coming week
  assert.deepEqual(offerWeek("2026-11-26"), WEEK); // Thursday → this week
  assert.deepEqual(isoWeek("2026-11-23"), { week: 48, year: 2026 });
  assert.deepEqual(isoWeek("2026-12-28"), { week: 53, year: 2026 });
  assert.deepEqual(isoWeek("2027-01-04"), { week: 1, year: 2027 });
  assert.deepEqual(isoWeek("2027-12-27"), { week: 52, year: 2027 });
  assert.throws(() => offerWeek("22.11.2026"), /YYYY-MM-DD/);
});

test("dayMonthToIso picks the year of the offer week, also across New Year", () => {
  assert.equal(dayMonthToIso("23.11.", WEEK), "2026-11-23");
  assert.equal(dayMonthToIso("27.11", WEEK), "2026-11-27");
  assert.equal(dayMonthToIso("2.1.", { start: "2026-12-28", end: "2027-01-02" }), "2027-01-02");
  assert.equal(dayMonthToIso("30.12.", { start: "2027-01-04", end: "2027-01-09" }), "2026-12-30");
  assert.equal(dayMonthToIso(undefined, WEEK), null);
  assert.equal(dayMonthToIso("ab Montag", WEEK), null);
});

test("findFlyerSlug: the flyer whose name has the week number", () => {
  assert.equal(findFlyerSlug(PROSPEKTE, WEEK), "kw48-26-op-mp");
  assert.equal(findFlyerSlug(PROSPEKTE, { start: "2026-11-30", end: "2026-12-05" }), "kw49-26-op");
  assert.throws(() => findFlyerSlug(PROSPEKTE, { start: "2027-01-04", end: "2027-01-09" }), /no flyer for week 1\/2027.*kw48-26-op-mp, kw49-26-op, kw50-26-vop/);
});

test("checkFlyerInput: any page of a flyer, or its bare name", () => {
  assert.equal(checkFlyerInput("https://prospekt.aldi-sued.de/kw48-26-op-mp/page/6-7"), "kw48-26-op-mp");
  assert.equal(checkFlyerInput("https://prospekt.aldi-sued.de/kw48-26-op-mp"), "kw48-26-op-mp");
  assert.equal(checkFlyerInput("kw48-26-op-mp"), "kw48-26-op-mp");
  assert.throws(() => checkFlyerInput("https://www.aldi-sued.de/angebote"), /expected https:\/\/prospekt\.aldi-sued\.de/);
  assert.throws(() => checkFlyerInput("not a url!"), /not a flyer URL/);
});

test("listPages: every page of every spread, with a full image URL", () => {
  const pages = listPages(FIX.spreads);
  assert.deepEqual(pages.map((p) => p.number), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(pages[5].image_url, "https://prospekt.aldi-sued.de/73714/3538171/pages/b2bd31a6-92d0-4bfe-91e2-3daf040abc3f-at1200.jpg");
  assert.throws(() => listPages({}), /not a list/);
  assert.throws(() => listPages([]), /no pages/);
});

test("toBox: hotspot position → [x1, y1, x2, y2] on the page", () => {
  assert.deepEqual(toBox(hotspot(6, /Nackensteak/).position), [0.0332, 0.1648, 0.4949, 0.3411]);
  assert.deepEqual(toBox({ left: 0.9, top: 0.9, width: 0.2, height: 0.2 }), [0.9, 0.9, 1, 1]); // clamped
  assert.equal(toBox({}), null);
});

test("toProduct: shared product fields, flyer values mapped", () => {
  const productKeys = ["product", "brand", "price", "original_price", "discount", "detail", "image_bbox", "page"];
  const box = [0.0332, 0.1648, 0.4949, 0.3411];

  const steak = toProduct(item(6, /Nackensteak/), { page: 6, box, week: WEEK });
  assert.deepEqual(Object.keys(steak), productKeys);
  assert.deepEqual(steak, {
    product: "Nackensteak",
    brand: "MEINE METZGEREI",
    price: 3.79, // discountedPrice
    original_price: 4.79, // price, shown crossed out
    discount: "-20%",
    detail: "Vom Schwein; 500-g-Packung\nkg-Preis 7.58",
    image_bbox: box,
    page: 6,
  });

  // "Aktion" offers have one price and no discount; the deposit is in the unit price text
  const cola = toProduct(item(7, /Coca-Cola/), { page: 7, box, week: WEEK });
  assert.equal(cola.price, 0.88);
  assert.equal(cola.original_price, null);
  assert.equal(cola.discount, null);
  assert.equal(cola.detail, "Teilweise koffeinhaltig; versch. Sorten; je 1,25-l-Flasche\nl-Preis 0.70; zzgl. Pfand 0.25");

  // no brand → null; an offer starting later in the week says so
  const filet = toProduct({ ...item(6, /Bio-Filetsteak/), customLabel1: "27.11." }, { page: 6, box, week: WEEK });
  assert.equal(filet.brand, null);
  assert.equal(filet.detail, "Vom Rind; versch. Gewichte, z. B. 308 g\nkg-Preis 38.90\nVerfügbar ab 27.11.2026");
});

test("notAnOffer: recipes and items without a price are skipped", () => {
  assert.equal(notAnOffer(item(3, /Zitronenkuchen/)), "recipe");
  assert.equal(notAnOffer({ title: "x", price: "1.00", removedFromFeed: true }), "removed from feed");
  assert.equal(notAnOffer({ title: "x" }), "no price");
  assert.equal(notAnOffer(item(3, /Avocado/)), null);
});

test("readPage: offers in page order, links and recipes left out", () => {
  const p6 = readPage(FIX.hotspots[6], { page: 6, week: WEEK });
  assert.equal(p6.products.length, 8);
  assert.equal(p6.aldi.length, 8);
  assert.deepEqual(p6.skipped, []);
  assert.ok(p6.products.every((p) => p.page === 6 && p.image_bbox.length === 4));

  const p3 = readPage(FIX.hotspots[3], { page: 3, week: WEEK });
  assert.deepEqual(p3.products.map((p) => p.product), ["Bio-Naturland-Zitronen", "Ananas, lose", "Avocado"]);
  assert.deepEqual(p3.skipped, [{ title: "Saftiger Zitronenkuchen mit Glasur", reason: "recipe" }]);
  assert.deepEqual(p3.aldi[0], {
    id: "482464_kw48",
    start_date: "2026-11-23",
    unit_price: "kg-Preis 2.38",
    badges: ["Aktion"],
    product_type: "Obst - Zitrusfrüchte",
    photo_url: "https://aldi-assets.publitas.com/feed-images/2026/48/482464_001_2026_Zitronen-02.png",
  });

  // an offer on the facing page is listed too, cut to nothing (as Winter-Clogs on page 16 of kw48-26)
  const facing = { ...hotspot(6, /Nackensteak/), position: { left: 1, top: 0.48746, width: 0, height: 0.22157 } };
  assert.equal(readPage([facing], { page: 6, week: WEEK }).products.length, 0);

  assert.deepEqual(readPage(FIX.hotspots[1], { page: 1, week: WEEK }).products, []); // cover: links only
  assert.throws(() => readPage({}, { page: 2, week: WEEK }), /not a list/);
});

test("buildResult uses the shared flyer format", () => {
  const pages = listPages(FIX.spreads).map((p) => (p.number === 5 ? { ...p, error: "HTTP 404" } : { ...p, hotspots: FIX.hotspots[p.number] ?? [] }));
  const r = buildResult({ slug: "kw48-26-op-mp", data: FIX.data, week: WEEK, pages, now: new Date("2026-11-22T20:17:00Z") });

  assert.deepEqual(Object.keys(r), ["source", "model", "prompt_sha256", "extracted_at", "complete", "failed_pages", "usage", "pages", "products"]);
  assert.deepEqual(r.source, {
    flyer_url: "https://prospekt.aldi-sued.de/kw48-26-op-mp/",
    flyer_id: "3538171",
    title: "ALDI SÜD Prospekt KW48: 23.11.2026 – 28.11.2026",
    offer_start: "2026-11-23",
    offer_end: "2026-11-28",
    image_key: "at1200",
  });
  assert.equal(r.products.length, 3 + 8 + 3);
  assert.equal(r.complete, false);
  assert.deepEqual(r.failed_pages, [5]);
  assert.deepEqual(r.pages[4], { page: 5, image_url: pages[4].image_url, status: "failed", error: "HTTP 404" });
  assert.deepEqual(r.pages.map((p) => p.offers ?? null), [0, 0, 3, 0, null, 8, 3]);
});

test("outputName", () => {
  assert.equal(outputName(WEEK), "Prospekt-23-11-2026-28-11-2026");
});

test("getAldiOffers: finds the week's flyer, reads every page, writes the JSON file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aldi-"));
  const calls = [];
  const { outFile, result } = await getAldiOffers({ today: "2026-11-22", outDir: dir, fetchImpl: fakeSites({ calls }), log: quiet });

  assert.equal(outFile, path.join(dir, "Prospekt-23-11-2026-28-11-2026.json"));
  assert.deepEqual(JSON.parse(await readFile(outFile, "utf8")), JSON.parse(JSON.stringify(result)));
  assert.equal(calls[0], "https://www.aldi-sued.de/prospekte");
  assert.equal(calls.filter((c) => c.endsWith("/hotspots_data.json")).length, 7); // one per page
  assert.equal(result.products.length, 14);
  assert.equal(result.complete, true);
});

test("getAldiOffers: a named flyer skips the lookup; a failed page is reported, not fatal", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aldi-"));
  const calls = [];
  const { result } = await getAldiOffers({
    flyer: "https://prospekt.aldi-sued.de/kw48-26-op-mp/page/6-7",
    today: "2026-11-22",
    outDir: dir,
    fetchImpl: fakeSites({ calls, failPage: 7 }),
    log: quiet,
  });
  assert.ok(!calls.includes("https://www.aldi-sued.de/prospekte"));
  assert.deepEqual(result.failed_pages, [7]);
  assert.equal(result.products.length, 11);
});

test("getAldiOffers: a flyer for another week is refused", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aldi-"));
  await assert.rejects(
    getAldiOffers({ flyer: "kw48-26-op-mp", today: "2026-12-06", outDir: dir, fetchImpl: fakeSites(), log: quiet }),
    /no offers starting 2026-12-07 – 2026-12-12.*wrong flyer/,
  );
});
