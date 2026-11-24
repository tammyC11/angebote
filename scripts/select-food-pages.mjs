/**
 * select-food-pages — before extract-flyer-lidl pays to read page pictures, ask a small model from
 * the pages' text whether a page can have food or drink offers at all.
 *
 * Lidl's leaflet API gives each page `altText` (a one-sentence description) and `keyWords` (the words
 * printed on the page, from OCR). One text-only call per flyer sends those for every page and gets a
 * verdict per page back. The rule fails open — a wrong "skip" loses offers, a wrong "read" costs a page:
 *   - a page the model did not answer for, or a page without any text, is read;
 *   - if the call fails or its reply is unusable, every page is read (the caller catches the error).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CATEGORY_GUIDANCE } from "../data/categories.js";

export const FILTER_MODEL = "claude-haiku-5-5";
const PROMPT_FILE = path.join(import.meta.dirname, "..", "prompts", "select-food-pages.txt");
const MAX_KEYWORDS_CHARS = 800; // OCR text is long and noisy; the start of it says what the page sells

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pages"],
  properties: {
    pages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["page", "food", "reason"],
        properties: { page: { type: "integer" }, food: { type: "boolean" }, reason: { type: "string" } },
      },
    },
  },
};

const tidy = (s) => (typeof s === "string" ? s.replace(/­/g, "").replace(/\s+/g, " ").trim() : "");

/** What the model is shown for one page: { page, alt_text, keywords }, or null if the page has no text. */
export function pageEvidence({ page, altText, keyWords }) {
  const alt = tidy(altText);
  const keywords = tidy(keyWords).slice(0, MAX_KEYWORDS_CHARS);
  return alt || keywords ? { page, alt_text: alt, keywords } : null;
}

export function buildFilterPrompt(template, evidence) {
  const vars = { categories: CATEGORY_GUIDANCE, pages: JSON.stringify(evidence, null, 1) };
  return template.replace(/\{\{(\w+)\}\}/g, (all, key) => (key in vars ? vars[key] : all));
}

/**
 * Ask which of `pages` ([{ page, altText, keyWords }]) can have food or drink offers.
 * → { skip: Map<page, reason> (only pages the model is sure about), usage }. Throws if the call fails.
 */
export async function selectFoodPages(client, { model = FILTER_MODEL, pages, template }) {
  const evidence = pages.map(pageEvidence).filter(Boolean);
  if (!evidence.length) return { skip: new Map(), usage: { input_tokens: 0, output_tokens: 0 } };

  const prompt = buildFilterPrompt(template ?? (await readFile(PROMPT_FILE, "utf8")), evidence);
  const res = await client.messages.create({
    model,
    max_tokens: 8000,
    messages: [{ role: "user", content: prompt }],
    output_config: { format: { type: "json_schema", schema: VERDICT_SCHEMA } },
  });
  if (res.stop_reason === "max_tokens") throw new Error("reply cut off (max_tokens)");
  if (res.stop_reason === "refusal") throw new Error("model refused");
  const text = res.content?.find((b) => b.type === "text")?.text;
  if (!text) throw new Error(`no text in reply (stop_reason=${res.stop_reason})`);
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.pages)) throw new Error("reply has no pages array");

  const asked = new Set(evidence.map((e) => e.page));
  const skip = new Map();
  for (const v of parsed.pages) {
    if (asked.has(v.page) && v.food === false) skip.set(v.page, String(v.reason ?? "").trim() || "no food or drink offers");
  }
  return { skip, usage: { input_tokens: res.usage?.input_tokens ?? 0, output_tokens: res.usage?.output_tokens ?? 0 } };
}
