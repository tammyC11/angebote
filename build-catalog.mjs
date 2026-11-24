import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { productExtras } from "./scripts/store-extras.mjs";
import { CATEGORY_NAMES, FOOD_CATEGORIES } from "./data/categories.js";

export { CATEGORY_NAMES };

export const RETAILERS = ["lidl", "aldi", "edeka"];

const UNIT_LINE = /^(Grundpreis(?! mit App)|(?:1\s*)?(?:kg|l|100\s*g)\s*(?:-Preis|=))/i;

/** One product → the offer the page shows. */
export function toOffer(retailer, flyer, product, { page, edeka, aldi }) {
  const { offer_start: week, offer_end: weekEnd, flyer_url: source, title, flyer_id } = flyer.source;
  const identity = aldi?.id ?? edeka?.offer_id ?? [product.product, product.brand, product.page, product.image_bbox].join("|");
  const id = createHash("sha256")
    .update(JSON.stringify([retailer, week, weekEnd, retailer === "edeka" ? flyer_id : null, identity]))
    .digest("hex")
    .slice(0, 24);
  const detail = product.detail ?? "";
  // a product photo where the store has one; Lidl offers are cut out of the page image instead
  const photo = aldi?.photo_url || (retailer === "edeka" ? page?.image_url : null);
  return {
    id,
    retailer,
    week,
    weekEnd,
    source,
    store: retailer === "edeka" ? title.split(":")[0] : null,
    name: product.product,
    names: { en: product.product_en?.trim() || product.product, "zh-TW": product.product_cn?.trim() || product.product },
    brand: product.brand,
    price: product.price,
    originalPrice: product.original_price,
    discount: product.discount,
    detail,
    start: aldi?.start_date ?? week,
    end: edeka?.valid_until ?? weekEnd,
    unit: aldi?.unit_price ?? detail.split(/[;\n]/).map((line) => line.trim()).find((line) => UNIT_LINE.test(line)),
    appPrice: edeka?.app_price,
    appOnly: edeka?.app_price != null && edeka?.discounted_price == null && edeka?.fixed_price == null,
    loyalty: retailer === "lidl" && /Lidl\s*Plus/i.test(detail),
    category: product.category,
    categories: CATEGORY_NAMES[product.category],
    badges: aldi?.badges,
    photo: photo || page?.image_url,
    crop: photo ? null : product.image_bbox,
    ratio: page?.width && page?.height ? page.width / page.height : 0.59,
  };
}

/** All result files → { offers, excluded: Map<category, count> }. `flyers` is [{ retailer, flyer }]. */
export function catalogOffers(flyers) {
  const offers = new Map(); // by id: an offer listed twice is shown once
  const excluded = new Map();
  for (const { retailer, flyer } of flyers) {
    const extras = productExtras(flyer);
    flyer.products.forEach((product, i) => {
      const category = product.category ?? "uncategorized";
      if (!FOOD_CATEGORIES.includes(category)) {
        excluded.set(category, (excluded.get(category) ?? 0) + 1);
        return;
      }
      const offer = toOffer(retailer, flyer, product, extras[i]);
      offers.set(offer.id, offer);
    });
  }
  return { offers: [...offers.values()], excluded };
}

const flyers = [];
for (const retailer of RETAILERS) {
  const folder = resolve(import.meta.dirname, "data", retailer);
  const files = (await readdir(folder)).filter((file) => file.endsWith(".json")).sort();
  for (const file of files) {
    const flyer = JSON.parse(await readFile(resolve(folder, file), "utf8"));
    flyers.push({ retailer, flyer });
  }
}

export default catalogOffers(flyers).offers;
