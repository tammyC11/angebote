/**
 * store-extras — the extra data EDEKA and ALDI result files keep about each product.
 *
 * It isn't stored on the product but beside it, in `pages`:
 *   EDEKA: every offer is its own page → pages[page].edeka = { category, offer_id, app_price, … }
 *   ALDI:  a page has several offers → pages[page].aldi is a list in the same order as that
 *          page's products (the 3rd product on page 6 ↔ the 3rd entry of page 6's list)
 *   Lidl:  nothing per offer (the page entry only describes the page image)
 *
 * Used by translate-products (the store's category) and build-catalog (ids, photos, prices).
 */

/** Which store a result file is from, by its source URL: "EDEKA", "ALDI SÜD", "Lidl" or null. */
export function storeOf(doc) {
  const url = doc?.source?.flyer_url ?? "";
  if (/edeka\.de/.test(url)) return "EDEKA";
  if (/aldi-sued\.de/.test(url)) return "ALDI SÜD";
  if (/leaflets\.schwarz|lidl\.de/.test(url)) return "Lidl";
  return null;
}

/** For each product of a result file, in order: { page, edeka, aldi } (null where there's none). */
export function productExtras(doc) {
  const pages = new Map((doc.pages ?? []).map((pg) => [pg.page, pg]));
  const seenOnPage = new Map();
  return (doc.products ?? []).map((p) => {
    const page = pages.get(p.page) ?? null;
    let aldi = null;
    if (Array.isArray(page?.aldi)) {
      const n = seenOnPage.get(p.page) ?? 0;
      seenOnPage.set(p.page, n + 1);
      aldi = page.aldi[n] ?? null;
    }
    return { page, edeka: page?.edeka ?? null, aldi };
  });
}
