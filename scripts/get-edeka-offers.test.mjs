import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildResult,
  checkOffersUrl,
  decodeEntities,
  getEdekaOffers,
  outputName,
  parseOffersPage,
  parseValidity,
  textOf,
  toProduct,
} from "./get-edeka-offers.mjs";

const HTML = await readFile(path.join(import.meta.dirname, "fixtures", "edeka-angebote.html"), "utf8");
const URL_ = "https://www.edeka.de/maerkte/034462/angebote/";
const quiet = () => {};

test("checkOffersUrl: offers page, flyer page, and mistakes", () => {
  assert.deepEqual(checkOffersUrl(URL_), { url: URL_, storeId: "034462" });
  assert.deepEqual(checkOffersUrl("https://www.edeka.de/maerkte/034462/angebote"), { url: URL_, storeId: "034462" });
  // the flyer page you started from works too
  assert.deepEqual(
    checkOffersUrl("https://www.edeka.de/maerkte/034462/prospekte/#prospekt-3f4eaae6-c86a-4ce2-8b06-32346d958fe5"),
    { url: URL_, storeId: "034462" },
  );
  assert.throws(() => checkOffersUrl(undefined), /missing URL/);
  assert.throws(() => checkOffersUrl("034462"), /not a URL/);
  assert.throws(() => checkOffersUrl("https://www.edeka.de/angebote/"), /maerkte\/<store id>\/angebote/);
  assert.throws(() => checkOffersUrl("https://www.lidl.de/maerkte/1/angebote/"), /expected https:\/\/www\.edeka\.de/);
});

test("decodeEntities and textOf", () => {
  assert.equal(decodeEntities("Knabbern &amp; Naschen &quot;x&quot; &#228; &#xE4;"), 'Knabbern & Naschen "x" ä ä');
  assert.equal(textOf("\n  Grundpreis mit App: 1kg=7.70<br>\n  Grundpreis ohne App: 1kg=8.95\n"), "Grundpreis mit App: 1kg=7.70\nGrundpreis ohne App: 1kg=8.95");
  assert.equal(textOf('<span class="sr-only">Angebot:</span>\n   Kühne   Gurken '), "Angebot: Kühne Gurken");
});

test("parseValidity reads the week", () => {
  assert.deepEqual(parseValidity(HTML), { start: "2026-11-23", end: "2026-11-28", startText: "23.11.2026", endText: "28.11.2026" });
  assert.throws(() => parseValidity("<p>nothing</p>"), /Gültig vom/);
});

test("parseOffersPage reads every dialog with its prices, text and photo", () => {
  const { storeName, offers } = parseOffersPage(HTML);
  assert.equal(storeName, "EDEKA Braun");
  assert.equal(offers.length, 5);
  assert.ok(offers.every((r) => r.ok));
  const [potatoes, actimel, gherkins, nippon, ferrero] = offers.map((r) => r.offer);

  assert.deepEqual(gherkins, {
    uuid: "bd05b133-7d3f-4e51-84ea-4aa8f5aab08b",
    offerId: "16187359",
    ean: "40804651",
    category: "Grundnahrung",
    validUntil: "2026-11-28",
    name: "Kühne Gurken",
    fixedPrice: 1.79,
    discountedPrice: null,
    appPrice: null,
    discount: null,
    lowestPrice30Days: null,
    description: "Abtropfgewicht 360/370g, je 650/670g Glas",
    unitPrice: "Grundpreis: 1kg=4.97/4.84",
    lowestPriceText: null,
    image: "https://offer-images.api.edeka/b976f14d-d8a6-4c89-ac43-69ec71126d86_40804651_VOR.png",
  });
  // reduced price: "Rabattierter Preis von 1.88€ (Insgesamt -53% Rabatt)" + 30-day lowest price
  assert.equal(actimel.fixedPrice, null);
  assert.equal(actimel.discountedPrice, 1.88);
  assert.equal(actimel.discount, "-53%");
  assert.equal(actimel.lowestPrice30Days, 2.22);
  assert.equal(actimel.lowestPriceText, "Niedrigster Gesamtpreis der letzten 30 Tage: 2,22 €");
  assert.equal(actimel.ean, null);
  // the product photo, not the brand logo that comes first
  assert.equal(potatoes.image, "https://offer-images.api.edeka/ff810736-f105-44e9-92b3-f47d7f06ab78_speisekartoffeln.png");
  assert.equal(potatoes.category, "Sonstiges");
  // app + normal price, two unit-price lines, "&amp;" decoded
  assert.equal(nippon.appPrice, 1.54);
  assert.equal(nippon.fixedPrice, 1.79);
  assert.equal(nippon.category, "Knabbern & Naschen");
  assert.equal(nippon.unitPrice, "Grundpreis mit App: 1kg=7.70/12.32\nGrundpreis ohne App: 1kg=8.95/14.32");
  // app-only, valid one day
  assert.equal(ferrero.fixedPrice, null);
  assert.equal(ferrero.appPrice, 2.49);
  assert.equal(ferrero.validUntil, "2026-11-23");
  assert.equal(ferrero.discount, "-48%"); // from "48% gespart!" in the text
});

test("an offer without name or price is reported, not silently dropped", () => {
  const broken = HTML.replace("<span class=\"sr-only\">Festpreis von 1.79€</span>\n      </div>\n    </div>\n    <p class=\"line-clmap-2\">\n      <span class=\"inline-block\">\n        Abtropfgewicht", "</div></div><p class=\"line-clmap-2\"><span>Abtropfgewicht");
  const { offers } = parseOffersPage(broken);
  assert.equal(offers.filter((r) => !r.ok).length, 1);
  assert.match(offers[2].error, /"Kühne Gurken": no price/);
  assert.throws(() => parseOffersPage("<html><title>x</title></html>"), /no offers/);
});

test("toProduct: shared product fields, EDEKA values mapped", () => {
  const { offers } = parseOffersPage(HTML);
  const [, actimel, gherkins, nippon, ferrero] = offers.map((r) => r.offer);

  const productKeys = ["product", "brand", "price", "original_price", "discount", "detail", "image_bbox", "page"];
  assert.deepEqual(Object.keys(toProduct(gherkins, 2)), productKeys);

  assert.deepEqual(toProduct(gherkins, 2), {
    product: "Kühne Gurken",
    brand: null,
    price: 1.79,
    original_price: null,
    discount: null,
    detail: "Abtropfgewicht 360/370g, je 650/670g Glas\nGrundpreis: 1kg=4.97/4.84",
    image_bbox: [0, 0, 1, 1],
    page: 2,
  });
  // normal price is the price; app price noted in detail
  assert.equal(toProduct(nippon, 3).price, 1.79);
  assert.match(toProduct(nippon, 3).detail, /App-Preis: 1\.54 €$/);
  // app-only: the app price is the price; printed "48% gespart!" becomes the discount
  assert.equal(toProduct(ferrero, 5).price, 2.49);
  assert.equal(toProduct(ferrero, 5).discount, "-48%");
  // reduced price: price and discount; the 30-day lowest price is only in detail
  // (it is not a regular price: on the live page Leerdammer is 1.49 with a 30-day low of 1.29)
  assert.deepEqual(toProduct(actimel, 2), {
    product: "Danone Actimel",
    brand: null,
    price: 1.88,
    original_price: null,
    discount: "-53%",
    detail: "versch. Sorten und Fettstufen, 8x 100g\nGrundpreis: 1kg = € 2,35\nNiedrigster Gesamtpreis der letzten 30 Tage: 2,22 €",
    image_bbox: [0, 0, 1, 1],
    page: 2,
  });
});

test("buildResult uses the shared flyer format", () => {
  const result = buildResult({ url: URL_, storeId: "034462", html: HTML, now: new Date("2026-11-22T21:00:00Z") });
  assert.deepEqual(Object.keys(result), [
    "source", "model", "prompt_sha256", "extracted_at", "complete", "failed_pages", "usage", "pages", "products",
  ]);
  assert.deepEqual(result.source, {
    flyer_url: URL_,
    flyer_id: "034462",
    title: "EDEKA Braun: 23.11.2026 – 28.11.2026",
    offer_start: "2026-11-23",
    offer_end: "2026-11-28",
    image_key: null,
  });
  assert.equal(result.model, null);
  assert.equal(result.complete, true);
  assert.deepEqual(result.usage, { input_tokens: 0, output_tokens: 0 });
  assert.equal(result.products.length, 5);
  // each product's page holds its photo, plus the EDEKA-only details
  const p = result.products[3];
  const page = result.pages[p.page - 1];
  assert.equal(page.image_url, "https://offer-images.api.edeka/4a5f0a5c-aa76-4352-9ceb-8ed66a2638e9_4021700900021_VOR.png");
  assert.deepEqual(page.edeka, {
    offer_id: "16186871",
    uuid: "e02c6b74-1726-439f-a06a-d056b45dfd1e",
    ean: "4021700900021",
    category: "Knabbern & Naschen",
    fixed_price: 1.79,
    discounted_price: null,
    app_price: 1.54,
    lowest_price_30_days: null,
    valid_until: "2026-11-28",
  });
});

test("outputName", () => {
  assert.equal(outputName("034462", { start: "2026-11-23", end: "2026-11-28" }), "Angebote-034462-23-11-2026-28-11-2026");
});

test("getEdekaOffers: downloads the page once and writes the JSON file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "edeka-"));
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return new Response(HTML, { status: 200, headers: { "content-type": "text/html" } });
  };
  const { outFile, result } = await getEdekaOffers("https://www.edeka.de/maerkte/034462/prospekte/", { outDir: dir, fetchImpl, log: quiet });
  assert.deepEqual(calls, [URL_]);
  assert.equal(path.basename(outFile), "Angebote-034462-23-11-2026-28-11-2026.json");
  assert.deepEqual(JSON.parse(await readFile(outFile, "utf8")), result);
});
