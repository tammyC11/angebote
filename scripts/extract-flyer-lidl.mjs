#!/usr/bin/env node
/**
 * extract-flyer-lidl — read the product offers on Lidl flyer pages with Claude.
 *
 * Give it the leaflet API URL of a flyer, in quotes (the URL contains "&"):
 *
 *   node scripts/extract-flyer-lidl.mjs "https://endpoints.leaflets.schwarz/v4/flyer?flyer_identifier=aktionsprospekt-23-11-2026-28-11-2026-08ced1&region_id=0&region_code=0"
 *   node scripts/extract-flyer-lidl.mjs "<url>" --image-key zoom      # full-resolution pages
 *   node scripts/extract-flyer-lidl.mjs "<url>" --dry-run --save-images tmp/pages   # download only
 *
 * How it works
 * 1. Load the flyer from Lidl's leaflet API (the URL you pass).
 * 2. Take the first N pages (default 3) and download each page's picture
 *    (`image` by default: 708×1200; `zoom`: 1415×2400).
 * 3. Send each picture to Claude with prompts/extract-flyer.txt and a JSON schema
 *    (structured output), so the reply is always valid JSON in our shape.
 * 4. Claude gives the product photo's box in pixels (it is much more accurate
 *    that way); we convert it to [x1, y1, x2, y2] between 0 and 1 of the page.
 * 5. Write data/lidl/<flyer name>.json. Failed pages are recorded; running again
 *    only redoes those (same picture, model and prompt). --force redoes all.
 *
 * Options
 *   --pages <n>          how many pages from the start (default: 3)
 *   --image-key <key>    image | zoom (default: image)
 *   --out <dir>          output folder (default: data/lidl)
 *   --model <id>         default: $CLAUDE_MODEL or claude-sonnet-5-5
 *   --concurrency <n>    pages in parallel (default: 3)
 *   --save-images <dir>  also save the downloaded page pictures (to check boxes)
 *   --dry-run            download only; no Claude calls, no API key needed
 *   --force              ignore previous results
 *
 * Needs ANTHROPIC_API_KEY (except --dry-run). Node 22+.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { fetchWithRetry } from "./fetch-with-retry.mjs";

const LIDL_HEADERS = { Origin: "https://www.lidl.de", Referer: "https://www.lidl.de/" };

export const FLYER_API_HOST = "endpoints.leaflets.schwarz";
const USAGE = 'usage: extract-flyer-lidl "<leaflet API URL>" [--image-key zoom] [--pages 3]';

/** Check the URL the user typed: Lidl's leaflet API with a flyer_identifier. */
export function checkFlyerUrl(input) {
  if (!input) throw new Error(`missing flyer URL\n${USAGE}`);
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`not a URL: "${input}"\n${USAGE}`);
  }
  if (url.protocol !== "https:" || url.hostname !== FLYER_API_HOST || !url.pathname.startsWith("/v4/flyer")) {
    throw new Error(`expected https://${FLYER_API_HOST}/v4/flyer?…, got ${url.origin}${url.pathname}`);
  }
  if (!url.searchParams.get("flyer_identifier")) {
    // the usual cause: the URL was not in quotes, so the shell cut it at the first "&"
    throw new Error(`the URL has no flyer_identifier — did you put it in quotes?\n${USAGE}`);
  }
  return url.toString();
}

export const DEFAULT_PAGES = 3;
export const DEFAULT_IMAGE_KEY = "image";
export const IMAGE_KEYS = ["image", "zoom"];
export const DEFAULT_MODEL = "claude-sonnet-5-5";
const PROMPT_FILE = path.join(import.meta.dirname, "..", "prompts", "extract-flyer.txt");

// ── flyer + page pictures ─────────────────────────────────────────────────────

/** Load the flyer JSON and return its `flyer` object. */
export async function fetchFlyer(url, { fetchImpl = fetch } = {}) {
  const res = await fetchWithRetry(url, { fetchImpl, headers: { ...LIDL_HEADERS, Accept: "application/json" } });
  const body = await res.json();
  const flyer = body?.flyer;
  if (!flyer || !Array.isArray(flyer.pages) || flyer.pages.length === 0) {
    throw new Error(`no pages in the flyer response from ${url}`);
  }
  return flyer;
}

/** First `count` pages by page number, each with its picture URL for `imageKey`. */
export function pickPages(flyer, count, imageKey) {
  return [...flyer.pages]
    .filter((p) => (p.pageType ?? "page") === "page")
    .sort((a, b) => a.number - b.number)
    .slice(0, count)
    .map((p) => {
      if (!p[imageKey]) throw new Error(`page ${p.number} has no "${imageKey}" URL`);
      return { page: p.number, url: p[imageKey] };
    });
}

/** Width, height and media type, read from the file's header bytes (JPEG, PNG, WebP). */
export function imageInfo(buf) {
  const b = Buffer.from(buf);
  // PNG: signature, then IHDR with width/height
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) {
    return { mediaType: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  // JPEG: walk the segments until a start-of-frame (SOFn) marker
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) throw new Error("JPEG: bad segment marker");
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; } // fill byte
      const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSof) return { mediaType: "image/jpeg", width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
    throw new Error("JPEG: no size found");
  }
  // WebP: RIFF....WEBP + VP8 / VP8L / VP8X chunk
  if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const chunk = b.toString("latin1", 12, 16);
    if (chunk === "VP8X") return { mediaType: "image/webp", width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { mediaType: "image/webp", width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (chunk === "VP8 ") return { mediaType: "image/webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  throw new Error("unsupported image format (expected JPEG, PNG or WebP)");
}

// ── what size Claude sees: its resize rule ────────────────────────────────────
// From https://platform.claude.com/docs/en/build-with-claude/vision-coordinates
// We can't resize without an image library, so if a picture is bigger than the
// model reads, Claude shrinks it and we rescale its pixel boxes by that size.

export const TIERS = {
  standard: { maxEdge: 1568, maxTokens: 1568 },
  high: { maxEdge: 2576, maxTokens: 4784 }, // "Claude 4.7 and later models"
};

/** Resolution tier of a model id, e.g. claude-sonnet-5-5 → high, claude-haiku-4-5-… → standard. */
export function tierFor(model) {
  const m = /^claude-[a-z]+-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(model);
  if (!m) return "high"; // unknown naming: assume current generation
  const major = Number(m[1]);
  const minor = m[2] === undefined ? 0 : Number(m[2]);
  return major > 4 || (major === 4 && minor >= 7) ? "high" : "standard";
}

export const countImageTokens = (w, h) => Math.ceil(w / 28) * Math.ceil(h / 28);

/** Python-style round (half to even), as the API uses. */
function roundTiesToEven(v) {
  const f = Math.floor(v);
  if (v - f !== 0.5) return Math.round(v);
  return f % 2 === 0 ? f : f + 1;
}

/** The size Claude resizes an image to (before padding). Returns [width, height]. */
export function resizedSize(width, height, { maxEdge, maxTokens } = TIERS.high) {
  const fits = (w, h) =>
    Math.ceil(w / 28) * 28 <= maxEdge && Math.ceil(h / 28) * 28 <= maxEdge && countImageTokens(w, h) <= maxTokens;
  if (fits(width, height)) return [width, height];
  if (height > width) {
    const [h, w] = resizedSize(height, width, { maxEdge, maxTokens });
    return [w, h];
  }
  const aspect = width / height;
  let lo = 1;
  let hi = width;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid, Math.max(roundTiesToEven(mid / aspect), 1))) lo = mid;
    else hi = mid;
  }
  return [lo, Math.max(roundTiesToEven(lo / aspect), 1)];
}

// ── prompt + schema ───────────────────────────────────────────────────────────

const nullable = (type) => ({ anyOf: [{ type }, { type: "null" }] });

/** Structured output schema: what Claude must return for one page. */
export const PAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["products"],
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["product", "brand", "price", "original_price", "discount", "detail", "image_bbox", "page"],
        properties: {
          product: nullable("string"),
          brand: nullable("string"),
          price: nullable("number"),
          original_price: nullable("number"),
          discount: nullable("string"),
          detail: nullable("string"),
          image_bbox: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["x1", "y1", "x2", "y2"],
                properties: { x1: { type: "number" }, y1: { type: "number" }, x2: { type: "number" }, y2: { type: "number" } },
              },
              { type: "null" },
            ],
          },
          page: { type: "integer" },
        },
      },
    },
  },
};

export function buildPrompt(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (all, key) => (key in vars ? String(vars[key]) : all));
}

// ── output cleanup ────────────────────────────────────────────────────────────

const round4 = (v) => Math.round(v * 10000) / 10000;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Pixel box on a w×h image → [x1, y1, x2, y2] in 0–1, or null if unusable. */
export function normalizeBox(box, width, height) {
  if (!box) return null;
  if (![box.x1, box.y1, box.x2, box.y2].every(Number.isFinite)) return null;
  const x1 = clamp01(Math.min(box.x1, box.x2) / width);
  const x2 = clamp01(Math.max(box.x1, box.x2) / width);
  const y1 = clamp01(Math.min(box.y1, box.y2) / height);
  const y2 = clamp01(Math.max(box.y1, box.y2) / height);
  if (x2 - x1 < 0.005 || y2 - y1 < 0.005) return null; // empty box
  return [round4(x1), round4(y1), round4(x2), round4(y2)];
}

const cleanText = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const cleanPrice = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null);

/** One product as written to the JSON file. `page` comes from us, not the model. */
export function normalizeProduct(p, { page, width, height }) {
  return {
    product: cleanText(p.product),
    brand: cleanText(p.brand),
    price: cleanPrice(p.price),
    original_price: cleanPrice(p.original_price),
    discount: cleanText(p.discount),
    detail: cleanText(p.detail),
    image_bbox: normalizeBox(p.image_bbox, width, height),
    page,
  };
}

// ── Claude call ───────────────────────────────────────────────────────────────

/** Ask Claude for the products on one page picture. Returns { products, usage }. */
export async function extractPage(client, { model, prompt, image, mediaType }) {
  const res = await client.messages.create({
    model,
    max_tokens: 16000,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: Buffer.from(image).toString("base64") } },
          { type: "text", text: prompt },
        ],
      },
    ],
    output_config: { format: { type: "json_schema", schema: PAGE_SCHEMA } },
  });
  if (res.stop_reason === "max_tokens") throw new Error("reply cut off (max_tokens) — page has too many offers?");
  if (res.stop_reason === "refusal") throw new Error("model refused this page");
  const text = res.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error(`no text in reply (stop_reason=${res.stop_reason})`);
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.products)) throw new Error("reply has no products array");
  return {
    products: parsed.products,
    usage: { input_tokens: res.usage?.input_tokens ?? 0, output_tokens: res.usage?.output_tokens ?? 0 },
  };
}

// ── run ───────────────────────────────────────────────────────────────────────

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function pMap(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/** "…/Aktionsprospekt-23-11-2026-28-11-2026-00.pdf" → "Aktionsprospekt-23-11-2026-28-11-2026-00". */
export function flyerName(flyer) {
  const fromPdf = flyer.pdfUrl && decodeURIComponent(new URL(flyer.pdfUrl).pathname.split("/").pop() ?? "");
  const name = (fromPdf || flyer.id || "flyer").replace(/\.pdf$/i, "");
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`unexpected flyer name: ${name}`);
  return name;
}

/**
 * Extract the first `pageCount` pages of a flyer and write <outDir>/<flyer name>.json.
 * `client` is an Anthropic client (or a fake with messages.create, in tests).
 */
export async function extractFlyer(opts = {}) {
  const {
    client,
    flyerUrl: flyerUrlInput,
    pageCount = DEFAULT_PAGES,
    imageKey = DEFAULT_IMAGE_KEY,
    model = DEFAULT_MODEL,
    outDir = "data/lidl",
    concurrency = 3,
    saveImagesDir,
    dryRun = false,
    force = false,
    promptTemplate,
    fetchImpl = fetch,
    log = console.error,
    now = () => new Date(),
  } = opts;
  const flyerUrl = checkFlyerUrl(flyerUrlInput);
  if (!IMAGE_KEYS.includes(imageKey)) throw new Error(`--image-key must be one of ${IMAGE_KEYS.join(", ")}`);

  const tier = tierFor(model);
  const template = promptTemplate ?? (await readFile(PROMPT_FILE, "utf8"));
  const promptHash = sha256(template);
  const flyer = await fetchFlyer(flyerUrl, { fetchImpl });
  const name = flyerName(flyer);
  const outFile = path.join(outDir, `${name}.json`);
  const pages = pickPages(flyer, pageCount, imageKey);

  // earlier results for the same picture + model + prompt are reused
  const previous = force ? null : await readJson(outFile);
  const done = new Map(); // page → { info, products }
  if (previous && previous.model === model && previous.prompt_sha256 === promptHash) {
    for (const info of previous.pages ?? []) {
      const wanted = pages.find((p) => p.page === info.page);
      if (info.status === "ok" && wanted && wanted.url === info.image_url) {
        done.set(info.page, { info, products: (previous.products ?? []).filter((p) => p.page === info.page) });
      }
    }
  }
  const todo = pages.filter((p) => !done.has(p.page));
  log(
    `${name}: pages ${pages.map((p) => p.page).join(", ")} of ${flyer.pages.length} (${imageKey}); ` +
      `${todo.length} to read, ${pages.length - todo.length} reused (${model}, ${tier} tier)`,
  );
  if (saveImagesDir) await mkdir(saveImagesDir, { recursive: true });

  await pMap(todo, dryRun ? 1 : concurrency, async ({ page, url }) => {
    const started = Date.now();
    try {
      const res = await fetchWithRetry(url, { fetchImpl, headers: { Accept: "image/jpeg,image/png,image/webp" } });
      const image = Buffer.from(await res.arrayBuffer());
      const { mediaType, width, height } = imageInfo(image);
      if (saveImagesDir) {
        const ext = mediaType.split("/")[1].replace("jpeg", "jpg");
        await writeFile(path.join(saveImagesDir, `${name}-p${String(page).padStart(2, "0")}-${imageKey}.${ext}`), image);
      }
      // the size Claude works in (same as the picture unless the model must shrink it)
      const [seenW, seenH] = resizedSize(width, height, TIERS[tier]);
      const info = {
        page,
        image_url: url,
        width,
        height,
        model_sees: [seenW, seenH],
        visual_tokens: countImageTokens(seenW, seenH),
      };
      if (dryRun) {
        done.set(page, { info: { ...info, status: "dry-run" }, products: [] });
        log(`  p${page}: ${width}×${height} ${mediaType}, ${Math.round(image.length / 1024)} KB, ${info.visual_tokens} visual tokens`);
        return;
      }
      const prompt = buildPrompt(template, { page, pages: flyer.pages.length, width: seenW, height: seenH });
      const { products, usage } = await extractPage(client, { model, prompt, image, mediaType });
      done.set(page, {
        info: { ...info, status: "ok", ...usage, seconds: Math.round((Date.now() - started) / 100) / 10 },
        products: products.map((p) => normalizeProduct(p, { page, width: seenW, height: seenH })),
      });
      log(`  p${page}: ${products.length} products (${usage.input_tokens} in / ${usage.output_tokens} out tokens)`);
    } catch (err) {
      done.set(page, { info: { page, image_url: url, status: "failed", error: err.message }, products: [] });
      log(`  p${page}: FAILED ${err.message}`);
    }
  });

  const entries = [...done.values()].sort((a, b) => a.info.page - b.info.page);
  const pageInfos = entries.map((e) => e.info);
  const failed = pageInfos.filter((p) => p.status === "failed").map((p) => p.page);
  const result = {
    source: {
      flyer_url: flyerUrl,
      flyer_id: flyer.id ?? null,
      title: flyer.title ?? null,
      offer_start: flyer.offerStartDate ?? null,
      offer_end: flyer.offerEndDate ?? null,
      image_key: imageKey,
    },
    model,
    prompt_sha256: promptHash,
    extracted_at: now().toISOString(),
    complete: failed.length === 0 && pageInfos.every((p) => p.status === "ok"),
    failed_pages: failed,
    usage: {
      input_tokens: pageInfos.reduce((s, p) => s + (p.input_tokens ?? 0), 0),
      output_tokens: pageInfos.reduce((s, p) => s + (p.output_tokens ?? 0), 0),
    },
    pages: pageInfos,
    products: entries.flatMap((e) => e.products),
  };

  if (!dryRun) {
    await mkdir(outDir, { recursive: true });
    await writeFile(`${outFile}.tmp`, JSON.stringify(result, null, 2) + "\n");
    await rename(`${outFile}.tmp`, outFile); // never leave a half-written file
    log(`  → ${outFile}: ${result.products.length} products${failed.length ? `, failed pages: ${failed.join(", ")}` : ""}`);
  }
  return { outFile, result };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      pages: { type: "string", default: String(DEFAULT_PAGES) },
      "image-key": { type: "string", default: DEFAULT_IMAGE_KEY },
      out: { type: "string", default: "data/lidl" },
      model: { type: "string" },
      concurrency: { type: "string", default: "3" },
      "save-images": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
  });
  if (positionals.length !== 1) throw new Error(positionals.length ? `expected one URL, got ${positionals.length} arguments — put the URL in quotes\n${USAGE}` : `missing flyer URL\n${USAGE}`);
  const flyerUrl = checkFlyerUrl(positionals[0]);
  const pageCount = Number(values.pages);
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error(`--pages must be a whole number ≥ 1, got "${values.pages}"`);
  const model = values.model || process.env.CLAUDE_MODEL || DEFAULT_MODEL;
  const dryRun = values["dry-run"];

  let client = null;
  if (!dryRun) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (use --dry-run to only download)");
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    client = new Anthropic({ maxRetries: 5, timeout: 5 * 60 * 1000 });
  }

  const { result } = await extractFlyer({
    client,
    flyerUrl,
    model,
    pageCount,
    imageKey: values["image-key"],
    outDir: values.out,
    concurrency: Math.max(1, Number(values.concurrency) || 3),
    saveImagesDir: values["save-images"],
    dryRun,
    force: values.force,
  });
  if (result.failed_pages.length) process.exitCode = 1; // results are saved; run again to redo failed pages
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(`extract-flyer-lidl: ${err.message}`);
    process.exit(1);
  });
}
