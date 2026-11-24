import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PAGE_SCHEMA,
  TIERS,
  buildPrompt,
  checkFlyerUrl,
  countImageTokens,
  extractFlyer,
  flyerName,
  imageInfo,
  normalizeBox,
  normalizeProduct,
  DEFAULT_PAGES,
  pickPages,
  resizedSize,
  tierFor,
} from "./extract-flyer-lidl.mjs";

const FLYER_URL =
  "https://endpoints.leaflets.schwarz/v4/flyer?flyer_identifier=aktionsprospekt-23-11-2026-28-11-2026-7af21b&region_id=0&region_code=0";

const TEMPLATE = await readFile(path.join(import.meta.dirname, "..", "prompts", "extract-flyer.txt"), "utf8");
const quiet = () => {};

// ── tiny real image headers (enough for imageInfo; Claude is faked) ───────────

/** A JPEG: SOI, an APP0 segment, then SOF0 with the size. */
function jpeg(width, height) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
function png(width, height) {
  const b = Buffer.alloc(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
function webpVp8x(width, height) {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1");
  b.write("WEBPVP8X", 8, "latin1");
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

// ── a fake leaflet API: 5 pages, listed out of order, like the real shape ────

const PAGE_URL = (n, key) => `https://imgproxy.leaflets.schwarz/x${n}/rs:fit:${key === "zoom" ? 2400 : 1200}:${key === "zoom" ? 2400 : 1200}:1/p${n}.jpg`;
const FLYER = {
  id: "01a1f337-a78a-703c-96d9-eac2b56e2201",
  title: "23.11.2026 – 28.11.2026",
  offerStartDate: "2026-11-23",
  offerEndDate: "2026-11-28",
  pdfUrl: "https://assets.leaflets.schwarz/leaflets/pdfs/01a1f337-a78a-703c-96d9-eac2b56e2201/Aktionsprospekt-23-11-2026-28-11-2026-00.pdf",
  pages: [3, 1, 5, 2, 4].map((n) => ({
    id: `p${n}`,
    number: n,
    width: 1415,
    height: 2400,
    pageType: "page",
    image: PAGE_URL(n, "image"),
    zoom: PAGE_URL(n, "zoom"),
  })),
};

function fakeFetch({ flyer = FLYER, failImage } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (url === FLYER_URL) return Response.json({ success: true, flyer });
    if (url.startsWith("https://imgproxy.leaflets.schwarz/")) {
      if (failImage?.(url)) return new Response("gone", { status: 404 });
      return new Response(url.includes(":2400:") ? jpeg(1415, 2400) : jpeg(708, 1200));
    }
    return new Response("unexpected", { status: 500 });
  };
  return { impl, calls };
}

/** Fake Anthropic client: answers per page, records requests. */
function fakeClient(answer, filterAnswer) {
  const requests = [];
  return {
    requests,
    messages: {
      async create(req) {
        requests.push(req);
        if (typeof req.messages[0].content === "string") {
          // the text-only page filter
          if (!filterAnswer) throw new Error("unexpected page filter call");
          return {
            stop_reason: "end_turn",
            content: [{ type: "text", text: JSON.stringify(await filterAnswer(req)) }],
            usage: { input_tokens: 700, output_tokens: 60 },
          };
        }
        const text = req.messages[0].content[1].text;
        const page = Number(/page (\d+) of/.exec(text)[1]);
        const [, w, h] = /It is (\d+)×(\d+) pixels/.exec(text).map(Number);
        const out = await answer({ page, w, h, req });
        return {
          stop_reason: out.stop_reason ?? "end_turn",
          content: [{ type: "text", text: JSON.stringify({ products: out.products ?? [] }) }],
          usage: { input_tokens: 1300, output_tokens: 250 },
        };
      },
    },
  };
}

const ITEM = {
  product: "Espresso-Vollautomat",
  brand: "KRUPS",
  price: 279,
  original_price: 449,
  discount: "-37%",
  detail: "EA8108",
  image_bbox: { x1: 100, y1: 300, x2: 600, y2: 900 },
  page: 99, // wrong on purpose: the script must use the real page number
};

// ── helpers ───────────────────────────────────────────────────────────────────

test("checkFlyerUrl accepts the leaflet API URL and explains common mistakes", () => {
  assert.equal(checkFlyerUrl(FLYER_URL), FLYER_URL);
  assert.throws(() => checkFlyerUrl(undefined), /missing flyer URL/);
  assert.throws(() => checkFlyerUrl("aktionsprospekt-23-11-2026-28-11-2026-7af21b"), /not a URL/);
  assert.throws(() => checkFlyerUrl("https://www.lidl.de/c/online-prospekte/s10005610"), /expected https:\/\/endpoints\.leaflets\.schwarz/);
  // what the shell passes when the URL is not quoted: cut at the first "&" — still has the id
  assert.equal(
    checkFlyerUrl("https://endpoints.leaflets.schwarz/v4/flyer?flyer_identifier=aktionsprospekt-23-11-2026-28-11-2026-7af21b"),
    "https://endpoints.leaflets.schwarz/v4/flyer?flyer_identifier=aktionsprospekt-23-11-2026-28-11-2026-7af21b",
  );
  assert.throws(() => checkFlyerUrl("https://endpoints.leaflets.schwarz/v4/flyer?region_id=0"), /no flyer_identifier — did you put it in quotes/);
});

test("imageInfo reads size and type from JPEG, PNG and WebP headers", () => {
  assert.deepEqual(imageInfo(jpeg(708, 1200)), { mediaType: "image/jpeg", width: 708, height: 1200 });
  assert.deepEqual(imageInfo(png(1415, 2400)), { mediaType: "image/png", width: 1415, height: 2400 });
  assert.deepEqual(imageInfo(webpVp8x(1415, 2400)), { mediaType: "image/webp", width: 1415, height: 2400 });
  assert.throws(() => imageInfo(Buffer.from("<html>blocked</html>")), /unsupported image format/);
});

test("pickPages: first N by page number, using the chosen key", () => {
  assert.deepEqual(pickPages(FLYER, 3, "image").map((p) => p.page), [1, 2, 3]);
  assert.equal(pickPages(FLYER, 3, "zoom")[0].url, PAGE_URL(1, "zoom"));
  assert.equal(pickPages(FLYER, 99, "image").length, 5);
  assert.equal(pickPages(FLYER, DEFAULT_PAGES, "image").length, 5); // the default is every page
  assert.throws(() => pickPages({ pages: [{ number: 1 }] }, 1, "image"), /no "image" URL/);
});

test("flyerName comes from the PDF file name, plus the flyer's hash when the URL has one", () => {
  assert.equal(flyerName(FLYER), "Aktionsprospekt-23-11-2026-28-11-2026-00");
  assert.equal(flyerName(FLYER, FLYER_URL), "Aktionsprospekt-23-11-2026-28-11-2026-00-7af21b");
  assert.equal(flyerName(FLYER, "https://endpoints.leaflets.schwarz/v4/flyer?flyer_identifier=weekly-flyer"), "Aktionsprospekt-23-11-2026-28-11-2026-00");
  assert.equal(flyerName({ id: "abc-123" }), "abc-123");
});

test("resizedSize matches the documented examples", () => {
  assert.deepEqual(resizedSize(1075, 1520, TIERS.standard), [924, 1307]); // A4 at 130 DPI
  assert.deepEqual(resizedSize(1920, 1080, TIERS.standard), [1456, 819]);
  // the docs' table says 1269×952, but their own reference implementation gives 1270×952
  assert.deepEqual(resizedSize(2000, 1500, TIERS.standard), [1270, 952]);
  assert.deepEqual(resizedSize(1920, 1080, TIERS.high), [1920, 1080]);
  assert.deepEqual(resizedSize(3840, 2160, TIERS.high), [2576, 1449]);
});

test("Lidl page sizes: both keys fit current models without shrinking", () => {
  assert.deepEqual(resizedSize(708, 1200, TIERS.high), [708, 1200]);
  assert.equal(countImageTokens(708, 1200), 1118);
  assert.deepEqual(resizedSize(1415, 2400, TIERS.high), [1415, 2400]);
  assert.equal(countImageTokens(1415, 2400), 4386);
  // an older (standard-tier) model would shrink `zoom`
  const [w, h] = resizedSize(1415, 2400, TIERS.standard);
  assert.ok(w < 1415 && h < 2400 && countImageTokens(w, h) <= 1568);
});

test("tierFor: Claude 4.7 and later are high-resolution", () => {
  assert.equal(tierFor("claude-sonnet-5-5"), "high");
  assert.equal(tierFor("claude-opus-4-7"), "high");
  assert.equal(tierFor("claude-sonnet-4-6"), "standard");
  assert.equal(tierFor("claude-haiku-4-5-20251001"), "standard");
});

test("PAGE_SCHEMA uses only supported JSON-schema features", () => {
  const banned = ["minimum", "maximum", "multipleOf", "minLength", "maxLength", "maxItems", "oneOf", "not"];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    for (const k of banned) assert.ok(!(k in node), `unsupported keyword ${k}`);
    if (node.type === "object") assert.equal(node.additionalProperties, false);
    if ("anyOf" in node) assert.ok(!("type" in node) && !("properties" in node), "anyOf next to type/properties");
    Object.values(node).forEach(walk);
  };
  walk(PAGE_SCHEMA);
  assert.deepEqual(PAGE_SCHEMA.properties.products.items.required, [
    "product", "brand", "price", "original_price", "discount", "detail", "image_bbox", "page",
  ]);
});

test("buildPrompt fills page and size, keeps your requirements", () => {
  const p = buildPrompt(TEMPLATE, { page: 3, pages: 43, width: 708, height: 1200 });
  assert.match(p, /page 3 of 43\. It is 708×1200 pixels\./);
  assert.match(p, /Do not invent missing information\./);
  assert.ok(!p.includes("{{"));
});

test("normalizeBox: pixels → 0–1, clamped; swapped corners ok; empty → null", () => {
  assert.deepEqual(normalizeBox({ x1: 177, y1: 300, x2: 531, y2: 900 }, 708, 1200), [0.25, 0.25, 0.75, 0.75]);
  assert.deepEqual(normalizeBox({ x1: 800, y1: 1300, x2: 600, y2: 1100 }, 708, 1200), [0.8475, 0.9167, 1, 1]);
  assert.equal(normalizeBox({ x1: 10, y1: 10, x2: 10, y2: 400 }, 708, 1200), null);
  assert.equal(normalizeBox(null, 708, 1200), null);
});

test("normalizeProduct: real page number, clean prices and empty strings", () => {
  const p = normalizeProduct({ ...ITEM, brand: "  ", price: -1, discount: "" }, { page: 1, width: 708, height: 1200 });
  assert.equal(p.page, 1);
  assert.equal(p.brand, null);
  assert.equal(p.price, null);
  assert.equal(p.discount, null);
  assert.equal(p.original_price, 449);
  assert.deepEqual(Object.keys(p), ["product", "brand", "price", "original_price", "discount", "detail", "image_bbox", "page"]);
});

// ── end to end with fake API + fake Claude ────────────────────────────────────

test("extractFlyer: flyer URL → first 3 `image` pictures → one request each → JSON", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "flyer-"));
  const { impl, calls } = fakeFetch();
  const client = fakeClient(async ({ page }) => ({ products: page === 1 ? [ITEM] : [] }));

  const { outFile, result } = await extractFlyer({
    client,
    flyerUrl: FLYER_URL,
    fetchImpl: impl,
    pageCount: 3,
    outDir: path.join(dir, "out"),
    saveImagesDir: path.join(dir, "img"),
    log: quiet,
    now: () => new Date("2026-11-22T20:30:00Z"),
  });

  // downloads: the flyer, then pages 1–3 at `image` size only
  assert.equal(calls[0], FLYER_URL);
  assert.deepEqual(calls.slice(1).sort(), [PAGE_URL(1, "image"), PAGE_URL(2, "image"), PAGE_URL(3, "image")]);

  // requests: picture first (as base64 JPEG), then the prompt with the real size; schema attached
  assert.equal(client.requests.length, 3);
  const req = client.requests.find((r) => /page 1 of 5/.test(r.messages[0].content[1].text));
  assert.equal(req.model, "claude-sonnet-5-5");
  assert.deepEqual(req.messages[0].content[0].source.media_type, "image/jpeg");
  assert.deepEqual(Buffer.from(req.messages[0].content[0].source.data, "base64"), jpeg(708, 1200));
  assert.match(req.messages[0].content[1].text, /It is 708×1200 pixels/);
  assert.deepEqual(req.output_config.format, { type: "json_schema", schema: PAGE_SCHEMA });

  // output
  assert.equal(path.basename(outFile), "Aktionsprospekt-23-11-2026-28-11-2026-00-7af21b.json");
  const saved = JSON.parse(await readFile(outFile, "utf8"));
  assert.deepEqual(saved, result);
  assert.equal(saved.complete, true);
  assert.deepEqual(saved.source, {
    flyer_url: FLYER_URL,
    flyer_id: FLYER.id,
    title: FLYER.title,
    offer_start: "2026-11-23",
    offer_end: "2026-11-28",
    image_key: "image",
  });
  assert.deepEqual(saved.pages.map((p) => [p.page, p.width, p.height, p.status]), [
    [1, 708, 1200, "ok"],
    [2, 708, 1200, "ok"],
    [3, 708, 1200, "ok"],
  ]);
  assert.deepEqual(saved.products, [
    { ...ITEM, image_bbox: [0.1412, 0.25, 0.8475, 0.75], page: 1 },
  ]);
  assert.deepEqual(saved.usage, { input_tokens: 3900, output_tokens: 750 });
  assert.equal((await readdir(path.join(dir, "img"))).length, 3);
});

test("extractFlyer --image-key zoom: full-size pictures, boxes still 0–1", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "flyer-"));
  const { impl, calls } = fakeFetch();
  // the fake model reports a box covering the middle half of whatever size it is told
  const client = fakeClient(async ({ w, h }) => ({ products: [{ ...ITEM, image_bbox: { x1: w / 4, y1: h / 4, x2: (3 * w) / 4, y2: (3 * h) / 4 } }] }));
  const { result } = await extractFlyer({ client, flyerUrl: FLYER_URL, fetchImpl: impl, imageKey: "zoom", pageCount: 1, outDir: dir, log: quiet });
  assert.deepEqual(calls.slice(1), [PAGE_URL(1, "zoom")]);
  assert.match(client.requests[0].messages[0].content[1].text, /It is 1415×2400 pixels/);
  assert.deepEqual(result.products[0].image_bbox, [0.25, 0.25, 0.75, 0.75]);
});

test("extractFlyer with an older model: Claude shrinks `zoom`, boxes are rescaled correctly", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "flyer-"));
  const { impl } = fakeFetch();
  const client = fakeClient(async ({ w, h }) => ({ products: [{ ...ITEM, image_bbox: { x1: w / 4, y1: h / 4, x2: (3 * w) / 4, y2: (3 * h) / 4 } }] }));
  const { result } = await extractFlyer({
    client, flyerUrl: FLYER_URL, fetchImpl: impl, imageKey: "zoom", pageCount: 1, model: "claude-haiku-4-5-20251001", outDir: dir, log: quiet,
  });
  const [seenW, seenH] = resizedSize(1415, 2400, TIERS.standard);
  assert.match(client.requests[0].messages[0].content[1].text, new RegExp(`It is ${seenW}×${seenH} pixels`));
  assert.deepEqual(result.pages[0].model_sees, [seenW, seenH]);
  assert.deepEqual(result.products[0].image_bbox, [0.25, 0.25, 0.75, 0.75]);
});

test("extractFlyer: a failed page is recorded, and a re-run only redoes that page", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "flyer-"));
  let broken = true;
  const { impl } = fakeFetch({ failImage: (url) => broken && url === PAGE_URL(2, "image") });
  const client = fakeClient(async ({ page }) => ({ products: [{ ...ITEM, product: `item p${page}` }] }));

  const first = await extractFlyer({ client, flyerUrl: FLYER_URL, fetchImpl: impl, pageCount: 3, outDir: dir, log: quiet });
  assert.equal(first.result.complete, false);
  assert.deepEqual(first.result.failed_pages, [2]);
  assert.match(first.result.pages[1].error, /HTTP 404/);
  assert.equal(client.requests.length, 2);

  broken = false;
  const second = await extractFlyer({ client, flyerUrl: FLYER_URL, fetchImpl: impl, pageCount: 3, outDir: dir, log: quiet });
  assert.equal(client.requests.length, 3, "only page 2 was sent again");
  assert.equal(second.result.complete, true);
  assert.deepEqual(second.result.products.map((p) => p.product), ["item p1", "item p2", "item p3"]);

  // switching to zoom means different pictures → all pages again
  await extractFlyer({ client, flyerUrl: FLYER_URL, fetchImpl: impl, pageCount: 3, imageKey: "zoom", outDir: dir, log: quiet });
  assert.equal(client.requests.length, 6);
});

test("extractFlyer: reads every page of the flyer unless pageCount is given", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "flyer-"));
  const { impl } = fakeFetch();
  const client = fakeClient(async () => ({ products: [] }));
  const { result } = await extractFlyer({ client, flyerUrl: FLYER_URL, fetchImpl: impl, outDir: dir, log: quiet });
  assert.deepEqual(result.pages.map((p) => p.page), [1, 2, 3, 4, 5]);
  assert.equal(client.requests.length, 5);
});

// the same flyer with page text, as the leaflet API gives it
const FLYER_WITH_TEXT = {
  ...FLYER,
  pages: FLYER.pages.map((p) => ({
    ...p,
    altText: p.number % 2 ? `Lebensmittel Angebote Seite ${p.number}` : `Elektrogeräte Seite ${p.number}`,
    keyWords: p.number % 2 ? "Käse Brot Milch" : "Akku Staubsauger Ladegerät",
  })),
};
const verdicts = (req) => ({
  pages: [...req.messages[0].content.matchAll(/"page": (\d+),\s+"alt_text": "([^"]*)"/g)].map(([, n, alt]) => ({
    page: Number(n),
    food: !alt.startsWith("Elektro"),
    reason: alt.startsWith("Elektro") ? "appliances" : "food",
  })),
});

test("extractFlyer with filterPages: pages without food offers are neither downloaded nor sent to Claude", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "flyer-"));
  const { impl, calls } = fakeFetch({ flyer: FLYER_WITH_TEXT });
  const client = fakeClient(async () => ({ products: [ITEM] }), verdicts);
  const { result } = await extractFlyer({
    client, flyerUrl: FLYER_URL, fetchImpl: impl, outDir: dir, filterPages: true, log: quiet,
  });
  assert.deepEqual(result.pages.map((p) => [p.page, p.status]), [[1, "ok"], [2, "skipped"], [3, "ok"], [4, "skipped"], [5, "ok"]]);
  assert.equal(result.pages[1].reason, "appliances");
  assert.equal(result.pages[1].image_url, PAGE_URL(2, "image"));
  assert.equal(result.complete, true, "skipped pages do not make the flyer incomplete");
  assert.deepEqual(result.failed_pages, []);
  assert.deepEqual(result.products.map((p) => p.page), [1, 3, 5]);
  assert.deepEqual(result.page_filter, { model: "claude-haiku-5-5", skipped: [2, 4], input_tokens: 700, output_tokens: 60 });

  const pictures = calls.filter((u) => u.startsWith("https://imgproxy"));
  assert.deepEqual(pictures, [PAGE_URL(1, "image"), PAGE_URL(3, "image"), PAGE_URL(5, "image")]);
  assert.equal(client.requests.filter((r) => typeof r.messages[0].content === "string").length, 1, "one filter call per flyer");
  assert.equal(client.requests.length, 4, "1 filter call + 3 page reads");
});

test("extractFlyer with filterPages: a failing filter reads every page", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "flyer-"));
  const { impl } = fakeFetch({ flyer: FLYER_WITH_TEXT });
  const client = fakeClient(async () => ({ products: [] }), () => {
    throw new Error("overloaded");
  });
  const logs = [];
  const { result } = await extractFlyer({
    client, flyerUrl: FLYER_URL, fetchImpl: impl, outDir: dir, filterPages: true, log: (m) => logs.push(m),
  });
  assert.deepEqual(result.pages.map((p) => p.status), ["ok", "ok", "ok", "ok", "ok"]);
  assert.equal(result.page_filter, null);
  assert.ok(logs.some((m) => /page filter failed \(overloaded\); reading every page/.test(m)));
});

test("extractFlyer: without filterPages, or in --dry-run, there is no filter call", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "flyer-"));
  const { impl } = fakeFetch({ flyer: FLYER_WITH_TEXT });
  const client = fakeClient(async () => ({ products: [] })); // a filter call would throw
  const { result } = await extractFlyer({ client, flyerUrl: FLYER_URL, fetchImpl: impl, outDir: dir, log: quiet });
  assert.equal(result.pages.length, 5);
  const dry = await extractFlyer({ client, flyerUrl: FLYER_URL, fetchImpl: impl, outDir: dir, filterPages: true, dryRun: true, log: quiet });
  assert.equal(dry.result.pages.length, 5);
});

test("extractFlyer: a cut-off reply fails only that page", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "flyer-"));
  const { impl } = fakeFetch();
  const client = fakeClient(async ({ page }) => (page === 3 ? { stop_reason: "max_tokens" } : { products: [ITEM] }));
  const { result } = await extractFlyer({ client, flyerUrl: FLYER_URL, fetchImpl: impl, pageCount: 3, outDir: dir, log: quiet });
  assert.deepEqual(result.failed_pages, [3]);
  assert.match(result.pages[2].error, /max_tokens/);
  assert.equal(result.products.length, 2);
});

test("extractFlyer --dry-run downloads only: no Claude calls, no JSON", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "flyer-"));
  const { impl, calls } = fakeFetch();
  const client = fakeClient(async () => assert.fail("must not call Claude"));
  const { result } = await extractFlyer({ client, flyerUrl: FLYER_URL, fetchImpl: impl, pageCount: 3, dryRun: true, outDir: path.join(dir, "out"), log: quiet });
  assert.equal(calls.length, 4);
  assert.deepEqual(result.pages.map((p) => [p.page, p.status, p.visual_tokens]), [
    [1, "dry-run", 1118],
    [2, "dry-run", 1118],
    [3, "dry-run", 1118],
  ]);
  await assert.rejects(readdir(path.join(dir, "out")));
});

test("extractFlyer rejects an unknown --image-key", async () => {
  await assert.rejects(extractFlyer({ flyerUrl: FLYER_URL, imageKey: "thumbnail", log: quiet }), /must be one of image, zoom/);
});

test("extractFlyer needs a flyer URL", async () => {
  await assert.rejects(extractFlyer({ log: quiet }), /missing flyer URL/);
});
