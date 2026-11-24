import { test } from "node:test";
import assert from "node:assert/strict";
import { FILTER_MODEL, buildFilterPrompt, pageEvidence, selectFoodPages } from "./select-food-pages.mjs";

const TEMPLATE = "Categories:\n{{categories}}\nPages:\n{{pages}}";
const PAGES = [
  { page: 1, altText: "Werbeprospekt mit Rabatten auf Nutella und Pizza", keyWords: "Nutella Pizza Lidl Plus" },
  { page: 2, altText: "Küchenmaschine Monsieur Cuisine", keyWords: "Silvercrest Premium-Küchenmaschine" },
  { page: 3, altText: "Reiseangebote von Lidl Reisen", keyWords: "Rundreise Flug Hotel" },
  { page: 4 }, // no text at all
];

/** Fake Anthropic client that answers the page filter. */
function fakeClient(reply) {
  const requests = [];
  return {
    requests,
    messages: {
      async create(req) {
        requests.push(req);
        const r = typeof reply === "function" ? reply(req) : reply;
        return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(r) }], usage: { input_tokens: 900, output_tokens: 80 }, ...(r.__raw ?? {}) };
      },
    },
  };
}

test("pageEvidence: tidies the text, cuts long OCR text, and gives nothing for a page without text", () => {
  assert.deepEqual(pageEvidence({ page: 7, altText: "  Frische   Fleisch­waren ", keyWords: "a\n b" }), { page: 7, alt_text: "Frische Fleischwaren", keywords: "a b" });
  assert.equal(pageEvidence({ page: 7, altText: "x", keyWords: "word ".repeat(1000) }).keywords.length, 800);
  assert.equal(pageEvidence({ page: 7 }), null);
  assert.equal(pageEvidence({ page: 7, altText: "  ", keyWords: "" }), null);
});

test("buildFilterPrompt: puts the category guidance and the page evidence into the prompt", () => {
  const prompt = buildFilterPrompt(TEMPLATE, [{ page: 1, alt_text: "Nutella", keywords: "" }]);
  assert.match(prompt, /meat: fresh and processed meat/);
  assert.match(prompt, /non_food: everything else/);
  assert.match(prompt, /"alt_text": "Nutella"/);
  assert.doesNotMatch(prompt, /\{\{/);
});

test("selectFoodPages: one text-only call; only pages the model is sure have no food are skipped", async () => {
  const client = fakeClient({
    pages: [
      { page: 1, food: true, reason: "Nutella, pizza" },
      { page: 2, food: false, reason: "kitchen appliance" },
      { page: 3, food: false, reason: "travel offers" },
      { page: 99, food: false, reason: "a page we never asked about" },
    ],
  });
  const { skip, usage } = await selectFoodPages(client, { pages: PAGES, template: TEMPLATE });
  assert.deepEqual([...skip], [[2, "kitchen appliance"], [3, "travel offers"]]);
  assert.deepEqual(usage, { input_tokens: 900, output_tokens: 80 });

  assert.equal(client.requests.length, 1);
  const req = client.requests[0];
  assert.equal(req.model, FILTER_MODEL);
  assert.equal(typeof req.messages[0].content, "string", "text only: no images");
  assert.match(req.messages[0].content, /Küchenmaschine Monsieur Cuisine/);
  assert.doesNotMatch(req.messages[0].content, /"page": 4/, "a page without text is not sent");
  assert.equal(req.output_config.format.type, "json_schema");
});

test("selectFoodPages: pages missing from the reply are not skipped", async () => {
  const client = fakeClient({ pages: [{ page: 2, food: false, reason: "appliance" }] });
  const { skip } = await selectFoodPages(client, { pages: PAGES, template: TEMPLATE });
  assert.deepEqual([...skip.keys()], [2]);
});

test("selectFoodPages: no page text means no call", async () => {
  const client = fakeClient({ pages: [] });
  const { skip } = await selectFoodPages(client, { pages: [{ page: 1 }, { page: 2 }], template: TEMPLATE });
  assert.equal(skip.size, 0);
  assert.equal(client.requests.length, 0);
});

test("selectFoodPages: a cut-off, refused, empty or malformed reply throws (the caller then reads every page)", async () => {
  const bad = (extra) => ({
    messages: { create: async () => ({ content: [{ type: "text", text: "{}" }], usage: {}, ...extra }) },
  });
  await assert.rejects(selectFoodPages(bad({ stop_reason: "max_tokens" }), { pages: PAGES, template: TEMPLATE }), /cut off/);
  await assert.rejects(selectFoodPages(bad({ stop_reason: "refusal" }), { pages: PAGES, template: TEMPLATE }), /refused/);
  await assert.rejects(selectFoodPages(bad({ content: [] }), { pages: PAGES, template: TEMPLATE }), /no text/);
  await assert.rejects(selectFoodPages(bad({ stop_reason: "end_turn" }), { pages: PAGES, template: TEMPLATE }), /no pages array/);
});
