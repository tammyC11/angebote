import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import vm from "node:vm";
import offers, { CATEGORY_NAMES, catalogOffers, catalogScript, toOffer } from "./build-catalog.mjs";
import { productExtras } from "./scripts/store-extras.mjs";
import { FOOD_CATEGORIES } from "./scripts/translate-products.mjs";

const lidl = (pdf, products) => ({
  source: { flyer_url: `https://endpoints.leaflets.schwarz/v4/flyer?x=${pdf}`, flyer_id: pdf, title: "23.11.2026 – 28.11.2026", offer_start: "2026-11-23", offer_end: "2026-11-28" },
  extracted_at: "2026-11-22T20:00:00Z",
  pages: [{ page: 2, image_url: `https://img/${pdf}/2.jpg`, width: 708, height: 1200 }],
  products,
});
const LIDL_FOOD = lidl("01", [
  { product: "Avocado", brand: null, price: 0.99, original_price: 1.29, discount: "-23%", detail: "Spanien, Kl. I\nLidl Plus Preis", image_bbox: [0.1, 0.2, 0.4, 0.5], page: 2, category: "fruits", product_en: "Avocado", product_zh_tw: "酪梨" },
  { product: "Ariel", brand: "ARIEL", price: 9.99, detail: null, image_bbox: [0, 0, 1, 1], page: 2, category: "non_food", product_en: null, product_zh_tw: null },
]);
const LIDL_NONFOOD_FLYER = lidl("00", [ // same week, other flyer: its food pages must not be lost
  { product: "Alesto Pistazien", brand: "ALESTO", price: 4.99, detail: null, image_bbox: [0, 0, 0.5, 0.5], page: 2, category: "sweets_snacks", product_en: "Alesto pistachios", product_zh_tw: "Alesto 開心果" },
]);
const ALDI = {
  source: { flyer_url: "https://prospekt.aldi-sued.de/kw48-26-op-mp/", flyer_id: "3538171", title: "ALDI SÜD Prospekt KW48: 23.11.2026 – 28.11.2026", offer_start: "2026-11-23", offer_end: "2026-11-28" },
  pages: [{ page: 6, image_url: "https://img/aldi/6.jpg", aldi: [
    { id: "486763_kw48", start_date: "2026-11-23", unit_price: "kg-Preis 8.74", badges: ["Aktion", "XXL"], product_type: "Geflügel frisch - Hühnchen frisch", photo_url: "https://photo/ministeaks.png" },
    { id: "731631_kw48", start_date: "2026-11-23", unit_price: "kg-Preis 7.58", badges: [], product_type: null, photo_url: "https://photo/nacken.png" },
  ] }],
  products: [
    { product: "Hähnchen-Ministeaks", brand: "MEINE METZGEREI", price: 6.99, original_price: null, discount: null, detail: "800-g-Packung\nkg-Preis 8.74", image_bbox: [0.5, 0.8, 1, 0.9], page: 6, category: "meat", product_en: "Chicken mini steaks", product_zh_tw: "雞肉迷你排" },
    { product: "Nackensteak", brand: "MEINE METZGEREI", price: 3.79, original_price: 4.79, discount: "-20%", detail: "Vom Schwein; 500-g-Packung", image_bbox: [0, 0.2, 0.5, 0.3], page: 6, category: null },
  ],
};
const EDEKA = {
  source: { flyer_url: "https://www.edeka.de/maerkte/034462/angebote/", flyer_id: "034462", title: "EDEKA Braun: 23.11.2026 – 28.11.2026", offer_start: "2026-11-23", offer_end: "2026-11-28" },
  pages: [{ page: 63, image_url: "https://offer-images/messmer.png", edeka: { offer_id: "16186738", category: "Grundnahrung", app_price: 1.49, fixed_price: 1.69, discounted_price: null, valid_until: "2026-11-28" } }],
  products: [{ product: "Meßmer Kräuter- oder Früchtetee", brand: null, price: 1.69, detail: "je 20-25er Packung\nApp-Preis: 1.49 €", image_bbox: [0, 0, 1, 1], page: 63, category: "drinks", product_en: "Meßmer herbal or fruit tea", product_zh_tw: "Meßmer 花草茶或水果茶" }],
};
const ALL = [
  { retailer: "lidl", flyer: LIDL_FOOD },
  { retailer: "lidl", flyer: LIDL_NONFOOD_FLYER },
  { retailer: "aldi", flyer: ALDI },
  { retailer: "edeka", flyer: EDEKA },
];

/** The id exactly as the first version of build-catalog made it (saved favourites depend on it). */
function oldId(retailer, flyer, product, aldi, edeka) {
  const identity = aldi?.id ?? edeka?.offer_id ?? [product.product, product.brand, product.page, product.image_bbox].join("|");
  return createHash("sha256")
    .update(JSON.stringify([retailer, flyer.source.offer_start, flyer.source.offer_end, retailer === "edeka" ? flyer.source.flyer_id : null, identity]))
    .digest("hex")
    .slice(0, 24);
}

test("every food category has a name in all three languages", () => {
  assert.deepEqual(Object.keys(CATEGORY_NAMES), FOOD_CATEGORIES);
  for (const names of Object.values(CATEGORY_NAMES)) assert.deepEqual(Object.keys(names), ["de", "en", "zh-TW"]);
});

test("catalogOffers: all files, food only; the rest is counted", () => {
  const { offers, excluded } = catalogOffers(ALL);
  assert.deepEqual(offers.map((o) => o.name), ["Avocado", "Alesto Pistazien", "Hähnchen-Ministeaks", "Meßmer Kräuter- oder Früchtetee"]);
  assert.deepEqual([...excluded], [["non_food", 1], ["uncategorized", 1]]);
});

test("the category is ours, with its name in each language — not the store's", () => {
  const { offers } = catalogOffers(ALL);
  const tea = offers.find((o) => o.retailer === "edeka");
  assert.equal(tea.category, "drinks"); // EDEKA said "Grundnahrung"
  assert.deepEqual(tea.categories, { de: "Getränke", en: "Drinks", "zh-TW": "飲料" });
  assert.equal(offers.find((o) => o.retailer === "aldi").category, "meat"); // ALDI said "Geflügel frisch - Hühnchen frisch"
});

test("ids are the same as before", () => {
  const { offers } = catalogOffers(ALL);
  for (const { retailer, flyer } of ALL) {
    const extras = productExtras(flyer);
    flyer.products.forEach((p, i) => {
      const offer = offers.find((o) => o.retailer === retailer && o.name === p.product);
      if (offer) assert.equal(offer.id, oldId(retailer, flyer, p, extras[i].aldi, extras[i].edeka), p.product);
    });
  }
});

test("toOffer: ALDI and EDEKA get their product photo and extras; Lidl a crop of the page", () => {
  const { offers } = catalogOffers(ALL);
  const [avocado, , steaks, tea] = offers;
  assert.deepEqual(
    { photo: avocado.photo, crop: avocado.crop, ratio: avocado.ratio, loyalty: avocado.loyalty, names: avocado.names },
    { photo: "https://img/01/2.jpg", crop: [0.1, 0.2, 0.4, 0.5], ratio: 0.59, loyalty: true, names: { en: "Avocado", "zh-TW": "酪梨" } },
  );
  assert.deepEqual(
    { photo: steaks.photo, crop: steaks.crop, unit: steaks.unit, badges: steaks.badges, start: steaks.start },
    { photo: "https://photo/ministeaks.png", crop: null, unit: "kg-Preis 8.74", badges: ["Aktion", "XXL"], start: "2026-11-23" },
  );
  assert.deepEqual(
    { photo: tea.photo, store: tea.store, appPrice: tea.appPrice, appOnly: tea.appOnly, end: tea.end },
    { photo: "https://offer-images/messmer.png", store: "EDEKA Braun", appPrice: 1.49, appOnly: false, end: "2026-11-28" },
  );
  // no translation yet: the German name is shown
  const plain = toOffer("lidl", LIDL_FOOD, { ...LIDL_FOOD.products[0], product_en: null, product_zh_tw: " " }, productExtras(LIDL_FOOD)[0]);
  assert.deepEqual(plain.names, { en: "Avocado", "zh-TW": "Avocado" });
});

test("the default export is an array of processed food offers", () => {
  assert.ok(Array.isArray(offers));
  for (const offer of offers) {
    assert.ok(FOOD_CATEGORIES.includes(offer.category));
    assert.ok(offer.id);
  }
});

test("source links open the exact flyer page or store offer", () => {
  const lidlFlyer = { ...LIDL_FOOD, source: { ...LIDL_FOOD.source,
    flyer_url: "https://endpoints.leaflets.schwarz/v4/flyer?flyer_identifier=weekly-flyer",
  } };
  const edekaFlyer = { ...EDEKA, pages: EDEKA.pages.map(p => ({
    ...p, edeka: { ...p.edeka, uuid: "d2ed0155-a88f-4a5a-92a2-428e3d569a69" },
  })) };
  const source = (retailer, flyer) => catalogOffers([{ retailer, flyer }]).offers[0].source;
  assert.equal(source("lidl", lidlFlyer), "https://www.lidl.de/l/prospekte/weekly-flyer/view/flyer/page/2?_ab=1&lf=HHZ");
  assert.equal(source("aldi", ALDI), "https://prospekt.aldi-sued.de/kw48-26-op-mp/page/6");
  assert.equal(source("edeka", edekaFlyer), "https://www.edeka.de/maerkte/034462/angebote/#angebot-d2ed0155-a88f-4a5a-92a2-428e3d569a69");
  assert.equal(source("edeka", EDEKA), EDEKA.source.flyer_url);
});

test("catalogScript: a script that sets window.CATALOG to the offers", () => {
  const list = [
    { id: "a1", name: "Avocado", names: { en: "Avocado", "zh-TW": "酪梨" }, price: 0.99 },
    { id: "b2", name: "Käse </script><b>", detail: "line 1\nline 2" },
  ];
  const script = catalogScript(list);
  assert.match(script, /^\/\/ Written by build-catalog\.mjs/);
  assert.ok(!script.includes("</script>"), "no text in the data may end the <script> tag early");
  const window = {};
  vm.runInNewContext(script, { window });
  assert.deepEqual(JSON.parse(JSON.stringify(window.CATALOG)), list); // made in another context: compare as data
});
