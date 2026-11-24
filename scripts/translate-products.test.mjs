import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CATEGORIES,
  FOOD_CATEGORIES,
  buildPrompt,
  labelBatch,
  labelFiles,
  labelProducts,
  loadCache,
  normalizeName,
  productContexts,
  productKey,
  ruleCategory,
  rulesVersion,
  saveCache,
  storeOf,
} from "./translate-products.mjs";

import { CATEGORY_GUIDANCE } from "../data/categories.js";

const quiet = () => {};
const TEMPLATE = "Sort and translate.\n{{categories}}\nProducts:\n{{products}}";
const RULES = "meat, …, drinks, other; alcohol, pet_food, non_food";
const NOW = new Date("2026-11-23T10:00:00Z");
const tmp = () => mkdtemp(path.join(tmpdir(), "label-"));
const opts = (cacheFile, client, more = {}) => ({ cacheFile, client, template: TEMPLATE, categoriesText: RULES, log: quiet, now: NOW, ...more });

// What the stand-in for Claude answers, by product name
const ANSWERS = {
  Nackensteak: ["meat", "Neck steak", "頸排"],
  "Kühne Gurken": ["pantry", "Kühne cucumber", "Kühne 黃瓜"],
  "Die Ofenfrische": ["instant_food", "Die Ofenfrische", "Die Ofenfrische"],
  "Franziskaner Weißbier": ["alcohol", "should be dropped", "不應翻譯"],
  "Erdinger Alkoholfrei": ["drinks", "Erdinger alcohol-free", "Erdinger 無酒精"],
  Avocado: ["fruits", "Avocado", "酪梨"],
  Glasur: ["pantry", "Icing", "糖霜"],
};
function fakeClaude({ calls = [], drop = [], fail = false, override = {}, stuckOn = null } = {}) {
  return {
    calls,
    messages: {
      async create(req) {
        const text = req.messages[0].content;
        const items = JSON.parse(text.slice(text.lastIndexOf("Products:\n") + "Products:\n".length));
        calls.push(items);
        if (fail) throw new Error("overloaded");
        if (stuckOn && items.some((it) => it.name === stuckOn)) {
          // the model got stuck repeating itself and ran into max_tokens
          return { stop_reason: "max_tokens", content: [{ type: "text", text: '{"products":[{"id":1,"category":"pantry","en":"' + "Pasta ".repeat(500) }], usage: { input_tokens: 100, output_tokens: 8000 } };
        }
        const products = items
          .filter((it) => !drop.includes(it.name))
          .map((it) => {
            const [category, en, zh] = override[it.name] ?? ANSWERS[it.name] ?? ["other", `EN ${it.name}`, `中 ${it.name}`];
            return { id: it.id, category, en, zh };
          });
        return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ products }) }], usage: { input_tokens: 100, output_tokens: 30 * items.length } };
      },
    },
  };
}

// Small result files in each store's shape
const EDEKA = {
  source: { flyer_url: "https://www.edeka.de/maerkte/034462/angebote/" },
  pages: [
    { page: 1, edeka: { category: "Grundnahrung" } },
    { page: 2, edeka: { category: "Drogerie" } },
    { page: 3, edeka: { category: "Getränke" } },
    { page: 4, edeka: { category: "Tiernahrung" } },
  ],
  products: [
    { product: "Kühne Gurken", brand: null, detail: "Abtropfgewicht 360/370g, je 650/670g Glas\n1kg=2.75", page: 1 },
    { product: "Ariel Waschmittel", brand: null, detail: "je 20 WL", page: 2 },
    { product: "Franziskaner Weißbier", brand: null, detail: "20 x 0,5 l", page: 3 },
    { product: "felix Katzennahrung", brand: null, detail: null, page: 4 },
  ],
};
const ALDI = {
  source: { flyer_url: "https://prospekt.aldi-sued.de/kw48-26-op-mp/" },
  pages: [
    { page: 6, aldi: [{ product_type: null }, { product_type: "Geflügel frisch - Hühnchen frisch" }] },
    { page: 16, aldi: [{ product_type: "Damen-Textilien - Nachtwäsche" }] },
  ],
  products: [
    { product: "Nackensteak", brand: "MEINE METZGEREI", detail: "Vom Schwein; 500-g-Packung\nkg-Preis 7.58", page: 6 },
    { product: "Hähnchen-Ministeaks", brand: "MEINE METZGEREI", detail: "800-g-Packung", page: 6 },
    { product: "Fleece-Pyjama", brand: "UP2FASHION", detail: null, page: 16 },
  ],
};
const LIDL = {
  source: { flyer_url: "https://endpoints.leaflets.schwarz/v4/flyer?flyer_identifier=aktionsprospekt-23-11-2026-28-11-2026-08ced1" },
  pages: [{ page: 2, status: "ok" }],
  products: [
    { product: "Avocado", brand: null, detail: "Spanien, Kl. I", page: 2 },
    { product: "Nackensteak", brand: "MEINE METZGEREI", detail: null, page: 2 }, // same product as at ALDI
  ],
};

test("the categories: our 12 food ones and 3 that are dropped", () => {
  assert.deepEqual(FOOD_CATEGORIES, ["meat", "seafood", "vegetables", "fruits", "eggs", "bread", "dairy", "sweets_snacks", "pantry", "instant_food", "drinks", "other"]);
  assert.deepEqual(CATEGORIES.slice(12), ["alcohol", "pet_food", "non_food"]);
});

test("the prompts: categories listed, translation rules kept", async () => {
  const prompts = path.join(import.meta.dirname, "..", "prompts");
  const cats = CATEGORY_GUIDANCE;
  for (const c of CATEGORIES) assert.match(cats, new RegExp(`^- ${c}:`, "m"), c);
  assert.match(cats, /alcohol-free beer and wine are "drinks"/);
  const main = await readFile(path.join(prompts, "translate-products.txt"), "utf8");
  assert.match(main, /cannot be translated, keep it exactly as written/);
  assert.match(main, /"Kühne Gurken" is "Kühne cucumber"/);
  assert.match(main, /set en and zh to null/);
  assert.match(main, /\{\{categories\}\}[\s\S]*\{\{products\}\}/);
});

test("normalizeName and productKey", () => {
  assert.equal(normalizeName("Kühne   Gurken "), "Kühne Gurken");
  assert.equal(productKey("Nackensteak", "MEINE METZGEREI"), "Nackensteak | MEINE METZGEREI");
  assert.equal(productKey("Kühne Gurken", null), "Kühne Gurken");
  assert.equal(productKey("", "X"), null);
});

test("storeOf and productContexts: store categories from EDEKA pages and ALDI's per-page lists", () => {
  assert.deepEqual([storeOf(EDEKA), storeOf(ALDI), storeOf(LIDL), storeOf({})], ["EDEKA", "ALDI SÜD", "Lidl", null]);
  assert.deepEqual(productContexts(EDEKA)[0], {
    key: "Kühne Gurken", name: "Kühne Gurken", brand: null, store: "EDEKA", store_category: "Grundnahrung",
    detail: "Abtropfgewicht 360/370g, je 650/670g Glas",
  });
  assert.deepEqual(productContexts(ALDI).map((c) => c.store_category), [null, "Geflügel frisch - Hühnchen frisch", "Damen-Textilien - Nachtwäsche"]);
  assert.deepEqual(productContexts(LIDL).map((c) => c.store_category), [null, null]);
});

test("ruleCategory: only clearly non-food store categories decide without Claude", () => {
  const ctx = (store, store_category) => ({ store, store_category });
  assert.equal(ruleCategory(ctx("EDEKA", "Drogerie")), "non_food");
  assert.equal(ruleCategory(ctx("EDEKA", "Tiernahrung")), "pet_food");
  assert.equal(ruleCategory(ctx("EDEKA", "Getränke")), null); // could be alcohol or not: Claude decides
  assert.equal(ruleCategory(ctx("ALDI SÜD", "Damen-Textilien - Nachtwäsche")), "non_food");
  assert.equal(ruleCategory(ctx("ALDI SÜD", "Spielwaren - Kleinkinderspielzeug")), "non_food");
  assert.equal(ruleCategory(ctx("ALDI SÜD", "Wein - Rotwein")), null); // alcohol-free wine exists
  assert.equal(ruleCategory(ctx("ALDI SÜD", null)), null);
  assert.equal(ruleCategory(ctx("Lidl", "Drogerie")), null);
});

test("buildPrompt: numbered from 1, empty hints left out", () => {
  const prompt = buildPrompt(TEMPLATE, RULES, [{ name: "Avocado", brand: null, store: "Lidl", store_category: null, detail: "Spanien" }]);
  assert.match(prompt, /meat, …, drinks/);
  assert.deepEqual(JSON.parse(prompt.slice(prompt.indexOf("["))), [{ id: 1, name: "Avocado", store: "Lidl", description: "Spanien" }]);
});

test("labelProducts: store rule first, then the saved file, then Claude — and what Claude says is saved", async () => {
  const cacheFile = path.join(await tmp(), "known.json");
  await saveCache(cacheFile, { entries: { Avocado: { category: "fruits", en: "Avocado", zh: "酪梨", rules: rulesVersion(RULES), model: "x", added: "2026-11-01" } } });
  const client = fakeClaude();
  const contexts = [...productContexts(EDEKA), ...productContexts(ALDI), ...productContexts(LIDL)];

  const r = await labelProducts(contexts, opts(cacheFile, client));
  // asked: everything except the 3 store-rule products and the saved Avocado; Nackensteak once for ALDI and Lidl
  assert.deepEqual(client.calls.flat().map((it) => it.name), ["Kühne Gurken", "Franziskaner Weißbier", "Nackensteak", "Hähnchen-Ministeaks"]);
  assert.deepEqual(r.counts, { products: 8, rule: 3, saved: 1, stale: 0, ask: 4, added: 4 });
  assert.deepEqual(r.labels.get("Ariel Waschmittel"), { category: "non_food", en: null, zh: null, from: "rule" });
  assert.deepEqual(r.labels.get("felix Katzennahrung"), { category: "pet_food", en: null, zh: null, from: "rule" });
  assert.deepEqual(r.labels.get("Fleece-Pyjama | UP2FASHION"), { category: "non_food", en: null, zh: null, from: "rule" });
  assert.deepEqual(r.labels.get("Avocado"), { category: "fruits", en: "Avocado", zh: "酪梨", from: "saved" });
  assert.deepEqual(r.labels.get("Nackensteak | MEINE METZGEREI"), { category: "meat", en: "Neck steak", zh: "頸排", from: "claude" });
  // alcohol: dropped, and any translation Claude sent anyway is thrown away
  assert.deepEqual(r.labels.get("Franziskaner Weißbier"), { category: "alcohol", en: null, zh: null, from: "claude" });

  const saved = (await loadCache(cacheFile)).entries;
  assert.deepEqual(saved["Kühne Gurken"], { category: "pantry", en: "Kühne cucumber", zh: "Kühne 黃瓜", rules: rulesVersion(RULES), model: "claude-haiku-5-5", added: "2026-11-23" });
  assert.equal(saved["Ariel Waschmittel"], undefined); // store-rule decisions cost nothing: not saved
  assert.equal(saved.Avocado.added, "2026-11-01");

  // second run: nothing to ask
  const again = fakeClaude();
  const r2 = await labelProducts(contexts, opts(cacheFile, again));
  assert.deepEqual(again.calls, []);
  assert.equal(r2.counts.saved, 5);
});

test("labelProducts: Claude gets the hints (brand, store, store category, description)", async () => {
  const client = fakeClaude();
  await labelProducts(productContexts(ALDI), opts(path.join(await tmp(), "k.json"), client));
  assert.deepEqual(client.calls[0][1], {
    id: 2, name: "Hähnchen-Ministeaks", brand: "MEINE METZGEREI", store: "ALDI SÜD",
    store_category: "Geflügel frisch - Hühnchen frisch", description: "800-g-Packung",
  });
});

test("labelProducts: when the category rules change, entries are asked again but keep their translation", async () => {
  const cacheFile = path.join(await tmp(), "known.json");
  await saveCache(cacheFile, {
    entries: {
      Glasur: { category: "sweets_snacks", en: "Glaze", zh: "淋醬", rules: "old", model: "claude-haiku-5-5", added: "2026-11-01" },
      Avocado: { category: "fruits", en: "Avocado (hand-checked)", zh: "酪梨", rules: "old", model: "manual" },
    },
  });
  const client = fakeClaude();
  const r = await labelProducts(
    [{ key: "Glasur", name: "Glasur" }, { key: "Avocado", name: "Avocado" }],
    opts(cacheFile, client),
  );
  assert.deepEqual(client.calls.flat().map((it) => it.name), ["Glasur"]); // "manual" is never asked again
  assert.equal(r.counts.stale, 1);
  assert.deepEqual(r.labels.get("Glasur"), { category: "pantry", en: "Glaze", zh: "淋醬", from: "claude" }); // new category, old words
  assert.equal(r.labels.get("Avocado").en, "Avocado (hand-checked)");
});

test("labelProducts: batches; failures are reported, not saved, and asked again next run", async () => {
  const cacheFile = path.join(await tmp(), "known.json");
  const many = Array.from({ length: 5 }, (_, i) => ({ key: `P${i}`, name: `P${i}` }));
  const client = fakeClaude({ drop: ["P3"] });
  const r = await labelProducts(many, opts(cacheFile, client, { batchSize: 2 }));
  assert.deepEqual(client.calls.map((c) => c.length), [2, 2, 1]);
  assert.deepEqual(r.failed, [{ key: "P3", error: "missing from reply" }]);
  assert.equal((await loadCache(cacheFile)).entries.P3, undefined);

  const down = await labelProducts([{ key: "A", name: "A" }], opts(cacheFile, fakeClaude({ fail: true })));
  assert.deepEqual(down.failed, [{ key: "A", error: "overloaded" }]);

  const next = fakeClaude();
  await labelProducts(many, opts(cacheFile, next));
  assert.deepEqual(next.calls.flat().map((it) => it.name), ["P3"]);
});

test("labelProducts: a cut-off reply is split until only the product that causes it fails", async () => {
  const cacheFile = path.join(await tmp(), "known.json");
  const items = Array.from({ length: 8 }, (_, i) => ({ key: `P${i}`, name: `P${i}` }));
  const client = fakeClaude({ stuckOn: "P5" });
  const logs = [];
  const r = await labelProducts(items, opts(cacheFile, client, { batchSize: 8, log: (m) => logs.push(m) }));
  // 8 cut off → P0–3 ok, P4–7 cut off → P4–5 cut off → P4 ok, P5 fails → P6–7 ok
  assert.deepEqual(client.calls.map((c) => c.map((it) => it.name).join(",")), [
    "P0,P1,P2,P3,P4,P5,P6,P7", "P0,P1,P2,P3", "P4,P5,P6,P7", "P4,P5", "P4", "P5", "P6,P7",
  ]);
  assert.equal(r.counts.added, 7);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].key, "P5");
  assert.match(r.failed[0].error, /it ended with: ".*Pasta Pasta/);
  assert.ok(logs.some((l) => /batch 1: reply cut off, trying 4 \+ 4/.test(l)));
  assert.equal(Object.keys((await loadCache(cacheFile)).entries).length, 7);
});

test("labelProducts: --dry-run counts without calling Claude", async () => {
  const client = fakeClaude();
  const r = await labelProducts(productContexts(EDEKA), opts(path.join(await tmp(), "k.json"), client, { dryRun: true }));
  assert.deepEqual(client.calls, []);
  assert.deepEqual(r.counts, { products: 4, rule: 2, saved: 0, stale: 0, ask: 2, added: 0 });
  await assert.rejects(labelProducts(productContexts(EDEKA), opts(path.join(await tmp(), "k.json"), undefined)), /no Claude client/);
});

test("labelBatch: food without a translation or an unknown category is an error for that product", async () => {
  const reply = (products, stop_reason = "end_turn") => ({
    messages: { create: async () => ({ stop_reason, content: [{ type: "text", text: JSON.stringify({ products }) }], usage: {} }) },
  });
  const items = [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }];
  const { results } = await labelBatch(
    reply([
      { id: 1, category: "meat", en: " ", zh: "肉" },
      { id: 2, category: "snacks", en: "x", zh: "y" },
      { id: 3, category: "non_food", en: null, zh: null },
    ]),
    { model: "m", template: TEMPLATE, categoriesText: RULES, items },
  );
  assert.deepEqual(results, [
    { error: "food (meat) without a translation" },
    { error: 'unknown category "snacks"' },
    { category: "non_food", en: null, zh: null },
    { error: "missing from reply" },
  ]);
  await assert.rejects(labelBatch(reply([], "max_tokens"), { model: "m", template: TEMPLATE, categoriesText: RULES, items }), /reply cut off \(max_tokens\); it ended with: /);
});

test("loadCache: a missing file is empty; a broken one is an error", async () => {
  const dir = await tmp();
  assert.deepEqual(await loadCache(path.join(dir, "none.json")), { entries: {} });
  await writeFile(path.join(dir, "bad.json"), "{oops");
  await assert.rejects(loadCache(path.join(dir, "bad.json")));
  await writeFile(path.join(dir, "list.json"), JSON.stringify({ entries: [] }));
  await assert.rejects(loadCache(path.join(dir, "list.json")), /not a known-products file/);
});

test("labelFiles: every product gets category, product_en, product_cn; brands untouched", async () => {
  const dir = await tmp();
  const files = { edeka: path.join(dir, "edeka.json"), aldi: path.join(dir, "aldi.json"), lidl: path.join(dir, "lidl.json") };
  await writeFile(files.edeka, JSON.stringify(EDEKA));
  await writeFile(files.aldi, JSON.stringify(ALDI));
  await writeFile(files.lidl, JSON.stringify(LIDL));
  const client = fakeClaude();
  await labelFiles(Object.values(files), opts(path.join(dir, "known.json"), client));
  assert.equal(client.calls.length, 1);

  const read = async (f) => JSON.parse(await readFile(f, "utf8")).products;
  const aldi = await read(files.aldi);
  assert.deepEqual(
    aldi.map((p) => [p.brand, p.category, p.product_en, p.product_cn]),
    [
      ["MEINE METZGEREI", "meat", "Neck steak", "頸排"],
      ["MEINE METZGEREI", "other", "EN Hähnchen-Ministeaks", "中 Hähnchen-Ministeaks"],
      ["UP2FASHION", "non_food", null, null],
    ],
  );
  const edeka = await read(files.edeka);
  assert.deepEqual(edeka.map((p) => p.category), ["pantry", "non_food", "alcohol", "pet_food"]);
  assert.equal((await read(files.lidl))[1].product_cn, "頸排"); // same product at ALDI and Lidl: decided once

  await assert.rejects(labelFiles([path.join(dir, "known.json")], opts(path.join(dir, "known.json"), client)), /no "products" list/);
});
