#!/usr/bin/env node
/**
 * translate-products — sort products into our categories and translate the food ones, from a
 * saved list first.
 *
 *   node scripts/translate-products.mjs data/edeka/*.json data/aldi/*.json data/lidl/*.json
 *   node scripts/translate-products.mjs data/aldi/*.json --dry-run      # counts only; no API call
 *
 * Categories (data/categories.js):
 *   food:     meat, seafood, vegetables, fruits, eggs, bread, dairy, sweets_snacks, pantry,
 *             instant_food, drinks, other
 *   dropped:  alcohol, pet_food, non_food   (not translated; alcohol-free beer/wine are drinks)
 *
 * Each product is decided once and kept in data/known-products.json, keyed by name and brand:
 *
 *   "Nackensteak | MEINE METZGEREI": { "category": "meat", "en": "Neck steak", "zh": "頸排",
 *                                      "rules": "3f2a…", "model": "claude-haiku-5-5", "added": "2026-11-23" }
 *
 * For every product, in this order:
 *   1. The store's own category says it's clearly not food (EDEKA "Drogerie", ALDI "Damen-Textilien
 *      - …", …) → dropped, no Claude call.
 *   2. It's in known-products.json → that entry is used.
 *   3. Otherwise Claude decides the category and, for food, translates the name — 40 products per
 *      call, with brand, store, store category and a short description as hints. The file is saved
 *      after every call.
 * When classification guidance in data/categories.js changes, entries made under the old version are asked again
 * (their translations are kept). Entries with "model": "manual" are never asked again: to correct
 * one, edit it and set "model" to "manual".
 *
 * The files given are updated in place: each product gets `category`, `product_en`, `product_cn`.
 *
 * Options
 *   --cache <file>   known products file (default: data/known-products.json)
 *   --model <id>     Claude model (default: claude-haiku-5-5; or CLAUDE_TRANSLATE_MODEL env)
 *   --batch <n>      products per Claude call (default: 40)
 *   --dry-run        counts only; no API call, no files changed
 *
 * Needs ANTHROPIC_API_KEY (except --dry-run). Node 22+.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { productExtras, storeOf } from "./store-extras.mjs";

import { CATEGORIES, FOOD_CATEGORIES, CATEGORY_GUIDANCE } from "../data/categories.js";

export { CATEGORIES, DROPPED, FOOD_CATEGORIES } from "../data/categories.js";
export { storeOf };

export const DEFAULT_MODEL = "claude-haiku-5-5";
export const CACHE_FILE = "data/known-products.json";
export const BATCH_SIZE = 40;
const PROMPTS = path.join(import.meta.dirname, "..", "prompts");

export const isFood = (category) => FOOD_CATEGORIES.includes(category);

// ── products and their hints ──────────────────────────────────────────────────

/** Same Unicode form, single spaces, no padding. */
export function normalizeName(name) {
  if (typeof name !== "string") return null;
  const s = name.normalize("NFC").replace(/\s+/g, " ").trim();
  return s || null;
}

/** "Nackensteak | MEINE METZGEREI", or just the name without a brand. */
export function productKey(name, brand) {
  const n = normalizeName(name);
  if (!n) return null;
  const b = normalizeName(brand);
  return b ? `${n} | ${b}` : n;
}

/** Each product of a result file with what we know about it: [{ key, name, brand, store, store_category, detail }]. */
export function productContexts(doc) {
  const store = storeOf(doc);
  const extras = productExtras(doc);
  return doc.products.map((p, i) => {
    const storeCategory = extras[i].edeka?.category ?? extras[i].aldi?.product_type ?? null;
    const detail = normalizeName(String(p.detail ?? "").split("\n")[0])?.slice(0, 120) ?? null;
    return { key: productKey(p.product, p.brand), name: normalizeName(p.product), brand: normalizeName(p.brand), store, store_category: storeCategory, detail };
  });
}

// Store categories that are never food: decided without asking Claude.
// (Alcohol is left to Claude: "Wein" can be alcohol-free.)
export const EDEKA_RULES = { Drogerie: "non_food", Tiernahrung: "pet_food" };
export const ALDI_NON_FOOD = new Set([
  "Beleuchtung", "Damen-Textilien", "Herren-Textilien", "Kinder-Textilien", "Folien/Tücher", "Haushaltsgeräte",
  "Heimtextilien", "Körperhygiene", "Lederwaren/Schirme", "Papierwaren", "Pflanzen/Blumen", "Schuhe", "Spielwaren",
  "Sport & Sportbekleidung", "Unterhaltungselektronik", "Wasch-/Putz-/Reinigungsmittel",
]);

/** The category the store's own category already settles, or null. */
export function ruleCategory(ctx) {
  if (!ctx.store_category) return null;
  if (ctx.store === "EDEKA") return EDEKA_RULES[ctx.store_category] ?? null;
  if (ctx.store === "ALDI SÜD") return ALDI_NON_FOOD.has(ctx.store_category.split(" - ")[0].trim()) ? "non_food" : null;
  return null;
}

// ── the saved decisions ───────────────────────────────────────────────────────

export async function loadCache(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { entries: {} };
    throw err;
  }
  const data = JSON.parse(text); // a broken file is an error, not an empty one: we'd pay to redo it
  if (!data || typeof data.entries !== "object" || Array.isArray(data.entries)) throw new Error(`${file}: no "entries" — not a known-products file?`);
  return data;
}

/** Sorted by key, so the file diffs cleanly in git. Written via a temp file. */
export async function saveCache(file, cache) {
  const entries = Object.fromEntries(Object.entries(cache.entries).sort(([a], [b]) => a.localeCompare(b, "de")));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify({ ...cache, entries }, null, 2) + "\n");
  await rename(`${file}.tmp`, file);
}

/** A short fingerprint of the category rules: entries made under other rules get asked again. */
export const rulesVersion = (categoriesText) => createHash("sha256").update(categoriesText).digest("hex").slice(0, 12);

// ── Claude ────────────────────────────────────────────────────────────────────

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
export const LABEL_SCHEMA = {
  type: "object",
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "integer" }, category: { type: "string", enum: CATEGORIES }, en: nullableString, zh: nullableString },
        required: ["id", "category", "en", "zh"],
        additionalProperties: false,
      },
    },
  },
  required: ["products"],
  additionalProperties: false,
};

/** The prompt for a batch: ids from 1, empty hints left out. */
export function buildPrompt(template, categoriesText, items) {
  const list = items.map((it, i) =>
    Object.fromEntries(
      Object.entries({ id: i + 1, name: it.name, brand: it.brand, store: it.store, store_category: it.store_category, description: it.detail }).filter(
        ([, v]) => v !== null && v !== undefined,
      ),
    ),
  );
  return template.replace("{{categories}}", categoriesText.trim()).replace("{{products}}", JSON.stringify(list, null, 1));
}

/**
 * The reply hit max_tokens. With ~70 tokens per product that only happens when the model gets
 * stuck repeating something, so the end of the reply is kept to show what.
 */
export class CutOffError extends Error {
  constructor(text) {
    const tail = JSON.stringify(String(text ?? "").slice(-160));
    super(`reply cut off (max_tokens); it ended with: ${tail}`);
    this.name = "CutOffError";
  }
}

/** One call for a batch → { results: [{ category, en, zh } | { error }] in input order, usage }. */
export async function labelBatch(client, { model, template, categoriesText, items }) {
  const res = await client.messages.create({
    model,
    max_tokens: 8000,
    messages: [{ role: "user", content: buildPrompt(template, categoriesText, items) }],
    output_config: { format: { type: "json_schema", schema: LABEL_SCHEMA } },
  });
  const text = res.content?.find((b) => b.type === "text")?.text;
  if (res.stop_reason === "max_tokens") throw new CutOffError(text);
  if (res.stop_reason === "refusal") throw new Error("model refused");
  if (!text) throw new Error(`no text in reply (stop_reason=${res.stop_reason})`);
  const byId = new Map(JSON.parse(text).products.map((t) => [t.id, t]));
  const results = items.map((_, i) => {
    const t = byId.get(i + 1);
    if (!t) return { error: "missing from reply" };
    if (!CATEGORIES.includes(t.category)) return { error: `unknown category "${t.category}"` };
    if (!isFood(t.category)) return { category: t.category, en: null, zh: null }; // dropped: no translation
    const en = t.en?.trim();
    const zh = t.zh?.trim();
    if (!en || !zh) return { error: `food (${t.category}) without a translation` };
    return { category: t.category, en, zh };
  });
  return { results, usage: { input_tokens: res.usage?.input_tokens ?? 0, output_tokens: res.usage?.output_tokens ?? 0 } };
}

// ── the function ──────────────────────────────────────────────────────────────

/**
 * Category and translation for each product context: from the store's category, the saved file,
 * or Claude. Returns { labels: Map<key, { category, en, zh, from }>, counts, failed, usage }.
 * `from` is "rule", "saved" or "claude".
 */
export async function labelProducts(
  contexts,
  { cacheFile = CACHE_FILE, client, model = DEFAULT_MODEL, template, categoriesText, batchSize = BATCH_SIZE, dryRun = false, log = console.error, now = new Date() } = {},
) {
  template ??= await readFile(path.join(PROMPTS, "translate-products.txt"), "utf8");
  categoriesText ??= CATEGORY_GUIDANCE;
  const rules = rulesVersion(categoriesText);
  const cache = await loadCache(cacheFile);

  const byKey = new Map();
  for (const ctx of contexts) if (ctx.key && !byKey.has(ctx.key)) byKey.set(ctx.key, ctx); // first one's hints are used
  const labels = new Map();
  const ask = [];
  let stale = 0;
  for (const [key, ctx] of byKey) {
    const byRule = ruleCategory(ctx);
    if (byRule) {
      labels.set(key, { category: byRule, en: null, zh: null, from: "rule" });
      continue;
    }
    const hit = cache.entries[key];
    const usable = hit && CATEGORIES.includes(hit.category) && (!isFood(hit.category) || (hit.en && hit.zh));
    if (usable && (hit.rules === rules || hit.model === "manual")) {
      labels.set(key, { category: hit.category, en: hit.en ?? null, zh: hit.zh ?? null, from: "saved" });
      continue;
    }
    if (usable) stale++;
    ask.push(ctx);
  }
  const counts = { products: byKey.size, rule: [...labels.values()].filter((l) => l.from === "rule").length, saved: 0, stale, ask: ask.length, added: 0 };
  counts.saved = labels.size - counts.rule;
  const result = { labels, counts, failed: [], usage: { input_tokens: 0, output_tokens: 0 } };
  log(`${counts.products} products: ${counts.rule} not food by store category, ${counts.saved} known, ${ask.length} to ask Claude` + (stale ? ` (${stale} because the category rules changed)` : ""));
  if (dryRun || ask.length === 0) return result;
  if (!client) throw new Error("no Claude client (is ANTHROPIC_API_KEY set?)");

  const day = now.toISOString().slice(0, 10);
  const save = (ctx, r) => {
    const old = cache.entries[ctx.key];
    // re-asked because the rules changed: keep the translation we already had
    const en = isFood(r.category) ? (old?.en ?? r.en) : null;
    const zh = isFood(r.category) ? (old?.zh ?? r.zh) : null;
    cache.entries[ctx.key] = { category: r.category, en, zh, rules, model, added: day };
    labels.set(ctx.key, { category: r.category, en, zh, from: "claude" });
    result.counts.added++;
  };
  // One call; a cut-off reply is split in half and tried again, down to single products,
  // so only the product that sets it off fails.
  const run = async (batch, name) => {
    let reply;
    try {
      reply = await labelBatch(client, { model, template, categoriesText, items: batch });
    } catch (err) {
      if (err instanceof CutOffError && batch.length > 1) {
        const half = Math.ceil(batch.length / 2);
        log(`  ${name}: reply cut off, trying ${half} + ${batch.length - half}`);
        await run(batch.slice(0, half), `${name}a`);
        await run(batch.slice(half), `${name}b`);
        return;
      }
      result.failed.push(...batch.map((c) => ({ key: c.key, error: err.message })));
      log(`  ${name}: failed (${err.message})`);
      return; // other batches can still succeed; failed products are asked again next run
    }
    result.usage.input_tokens += reply.usage.input_tokens;
    result.usage.output_tokens += reply.usage.output_tokens;
    batch.forEach((ctx, j) => {
      const r = reply.results[j];
      if (r.error) result.failed.push({ key: ctx.key, error: r.error });
      else save(ctx, r);
    });
    await saveCache(cacheFile, cache); // after every call: what we paid for is kept
    log(`  ${name}: ${batch.length} products`);
  };
  for (let i = 0; i < ask.length; i += batchSize) await run(ask.slice(i, i + batchSize), `batch ${i / batchSize + 1}`);
  return result;
}

// ── result files ──────────────────────────────────────────────────────────────

/** Add category / product_en / product_cn to every product in the result files. */
export async function labelFiles(files, { dryRun = false, log = console.error, ...opts } = {}) {
  const docs = [];
  for (const file of files) {
    const doc = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(doc.products)) throw new Error(`${file}: no "products" list`);
    docs.push({ file, doc, contexts: productContexts(doc) });
  }
  const result = await labelProducts(docs.flatMap((d) => d.contexts), { ...opts, dryRun, log });
  if (dryRun) return result;

  for (const { file, doc, contexts } of docs) {
    doc.products.forEach((p, i) => {
      const l = result.labels.get(contexts[i].key);
      p.category = l?.category ?? null; // null: not decided yet (see the run's failures)
      p.product_en = l?.en ?? null;
      p.product_cn = l?.zh ?? null;
    });
    await writeFile(`${file}.tmp`, JSON.stringify(doc, null, 2) + "\n");
    await rename(`${file}.tmp`, file);
  }
  return result;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cache: { type: "string", default: CACHE_FILE },
      model: { type: "string" },
      batch: { type: "string", default: String(BATCH_SIZE) },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (positionals.length === 0) throw new Error("usage: translate-products <result.json>… [--dry-run] [--cache file] [--model id] [--batch n]");
  const batchSize = Number(values.batch);
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error(`--batch must be a whole number, got "${values.batch}"`);
  const dryRun = values["dry-run"];
  const model = values.model || process.env.CLAUDE_TRANSLATE_MODEL || DEFAULT_MODEL;

  let client;
  if (!dryRun) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (use --dry-run to only count)");
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    client = new Anthropic({ maxRetries: 5, timeout: 2 * 60 * 1000 });
  }
  const r = await labelFiles(positionals, { cacheFile: values.cache, client, model, batchSize, dryRun });
  if (dryRun) return;

  const byCategory = {};
  for (const l of r.labels.values()) byCategory[l.category] = (byCategory[l.category] ?? 0) + 1;
  console.error(Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(", "));
  console.error(
    `${r.counts.added} new products saved to ${values.cache} (${r.usage.input_tokens} input / ${r.usage.output_tokens} output tokens)` +
      (r.failed.length ? `; ${r.failed.length} failed and will be asked again next run:` : ""),
  );
  for (const f of r.failed.slice(0, 20)) console.error(`  ${f.key}: ${f.error}`);
  if (r.failed.length) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(`translate-products: ${err.message}`);
    process.exit(1);
  });
}
