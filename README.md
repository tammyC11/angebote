# Sales

Sales combines weekly supermarket offers from Lidl, ALDI SÜD, and EDEKA into a food and drink catalog with German, English, and Traditional Chinese product names.

## Use the catalog

Use Node.js 22 or newer. From the project directory, run `npm ci` to install the dependencies. The saved flyers already contain category and translation data. To read the combined offers in a Node.js module, import the default export:

```js
import offers from "./build-catalog.mjs";

console.log(offers.length);
```

On import, the builder reads all flyer JSON files under `data/lidl/`, `data/aldi/`, and `data/edeka/`. It keeps products with a recognized food or drink category, combines store-specific prices and photos with each product, and deduplicates offers by ID. Lidl photos use a crop of the flyer page.

## The website

Open `index.html` in a browser. Favourites are kept in the browser's storage. Pages opened as
files (`file:///…`) only share it in some browsers: Chrome does, Safari and Firefox can keep each
file separate, so a favourite saved on `offer.html` may not show on `index.html`. To try the site
the way it works when hosted, serve the folder from this computer and open
http://localhost:8080/:

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

`index.html` and `offer.html` share three files:

- `catalog.js`: the offers, as `window.CATALOG = […]`
- `site.js`: texts in three languages, the language choice, favourites, and how an offer is drawn
- `site.css`: the styles

`offer.html?id=<offer id>` shows one offer on its own, with a link back to the list. The
"copy product link" button in an offer's details copies this link.

The language is part of the address: `?lang=de` (German, the default), `?lang=en` (English) or
`?lang=zh` (Traditional Chinese, Taiwan), e.g. `index.html?lang=zh` or
`offer.html?id=…&lang=en`. Without `lang`, the page uses the last language chosen in this
browser. (A path like `index.html/zh` can't work for pages opened as files: the browser looks
for a file called `zh` inside a folder called `index.html`.)

The pages show what is in `catalog.js`. After refreshing the flyer files, run `build-catalog.mjs`
to save the offers as `catalog.js` again (importing it, as above, only returns them):

```sh
npm run build-catalog          # same as: node build-catalog.mjs
```

Refreshing the flyer files affects the Node export the next time you start Node.

## Refresh the offers

1. Collect ALDI and EDEKA flyer data. EDEKA offers are specific to the store in the URL.

   ```sh
   npm run get-aldi-offers
   npm run get-edeka-offers -- "https://www.edeka.de/maerkte/034462/angebote/"
   ```

2. Preview how many products need classification. A dry run reads the flyers and cache without calling the API or writing files.

   ```sh
   npm run translate-products -- data/aldi/*.json data/edeka/*.json data/lidl/*.json --dry-run
   ```

3. Set `ANTHROPIC_API_KEY` in your environment, then run the same command without `--dry-run`. It writes `category`, `product_en`, and `product_zh_tw` back to the input flyer files.

For Lidl, run the flyer extractor before translation to populate `data/lidl/`. See the command below.

## Classification and translation

Edit `data/categories.js` to change category definitions, classification guidance, or display labels. The classifier uses its allowed keys and guidance. The catalog builder uses its food category list and localized labels.

The translator groups products by normalized name and brand, then checks each distinct product in order:

1. Apply a retailer rule when the retailer's category settles the decision. For example, EDEKA’s `Tiernahrung` maps to `pet_food`.
2. Look up the product in `data/known-products.json`. A food entry needs both translations. Valid manual entries can be reused after classification guidance changes.
3. Ask Claude about the remaining products in batches of up to 40. The prompt in `prompts/translate-products.txt` includes the shared category guidance and product hints. The model chooses a category and translates food names in the same call. Alcohol, pet food, and non-food items receive null translations.

Successful model decisions are saved to the cache after each batch. If a reply hits the output token limit, the script retries with smaller batches. Unresolved products get null labels, and the command exits with status 1. A later run can retry those products. When classification guidance changes, the script rechecks affected model decisions and keeps existing translations for products that still qualify as food.

To correct a cached decision, edit its category and translations and set its `model` to `"manual"`. Use `--cache <file>` for another cache, `--batch <n>` to change batch size, or `--model <id>` to override the model. The model can also be set with `CLAUDE_TRANSLATE_MODEL`.

## Extract Lidl offers

Set `ANTHROPIC_API_KEY` and supply a quoted Lidl leaflet API URL for the flyer.
The extractor reads the page pictures of the flyer and writes the result to `data/lidl/`. Set
`--pages <n>` to read only the first n pages.

Pages that cannot have food or drink offers (electronics, clothing, travel, spirits, …) are skipped.
The leaflet API gives every page `altText` and `keyWords`; one text-only call to a small model
(`claude-haiku-5-5`, or `--filter-model <id>` / `CLAUDE_FILTER_MODEL`) sends them for all pages of
the flyer and gets a food / no-food verdict per page (`scripts/select-food-pages.mjs`,
`prompts/select-food-pages.txt`). It fails open: a page the model is unsure about, or without
text, is read, and if the call fails every page is read. Skipped pages are kept in the flyer JSON
with `"status": "skipped"` and the reason, and the filter's model, skipped pages and token usage are
under `page_filter`. Use `--all-pages` to read every page. `--dry-run` makes no Claude call, so it
does not filter.

```sh
npm run extract-flyer-lidl -- "$FLYER_URL"
```

To find the current flyers' URLs, run `scripts/find-lidl-flyer-url.mjs`. It reads the Aktionsprospekt
links on lidl.de/c/online-prospekte/s10005610 and prints, one per line, the API URL of every flyer of
the earliest week that has not ended (on a Sunday: the coming Monday–Saturday). Lidl sometimes
publishes two flyers for the same week, so extract each one:

```sh
node scripts/find-lidl-flyer-url.mjs | while read -r url; do npm run extract-flyer-lidl -- "$url"; done
```

Each flyer is saved as `data/lidl/<PDF name>-<hash>.json`; the hash is the end of the flyer's identifier,
so two flyers with the same PDF name don't overwrite each other.

## get-edeka-offers

`scripts/get-edeka-offers.mjs` reads one EDEKA store's weekly offers from edeka.de and
writes `data/edeka/Angebote-<store id>-<DD-MM-YYYY>-<DD-MM-YYYY>.json`, using the shared flyer format. No AI, no API key, no dependencies.

```bash
node scripts/get-edeka-offers.mjs "https://www.edeka.de/maerkte/034462/angebote/"
# the store's flyer page URL works too:
node scripts/get-edeka-offers.mjs "https://www.edeka.de/maerkte/034462/prospekte/"
```

The store's offers page has every offer in its HTML (about 240), including next week's on
a Sunday. "Mehr laden" only un-hides offers already on the page. Each offer's detail
dialog (`<dialog id="dialog-angebot-…">`) is read for name, prices, description, unit price
and product photo.

EDEKA fields in the shared flyer format

| field | EDEKA |
|---|---|
| `product` | offer name; the brand is part of it ("Kühne Gurken") |
| `brand` | `null` (EDEKA gives no separate brand) |
| `price` | "Rabattierter Preis", else "Festpreis"; app-only offers: the app price |
| `original_price` | `null` — EDEKA shows no regular price (the "lowest price of the last 30 days" can be below today's price, so it is not used) |
| `discount` | "-53%" from "(Insgesamt -53% Rabatt)" or "48% gespart!", else `null` |
| `detail` | description, unit price ("Grundpreis"), 30-day lowest price, "App-Preis: x €" |
| `image_bbox`, `page` | each offer has its own entry in `pages` with its photo, so the box is the whole picture `[0, 0, 1, 1]` |

EDEKA-only details are in each `pages` entry under `edeka`: `category` (EDEKA's own:
Obst & Gemüse, Getränke, Drogerie, Tiernahrung, …), `offer_id`, `ean`, `fixed_price`,
`discounted_price`, `app_price`, `lowest_price_30_days`, `valid_until`.

`model`/`prompt_sha256` are `null` and `usage` is 0 (no AI). An offer that can't be read is
listed in `failed_pages` (exit code 1); the page itself missing offers or dates is an error.

## get-aldi-offers

`scripts/get-aldi-offers.mjs` reads the week's ALDI SÜD flyer (Prospekt) as data and writes
`data/aldi/Prospekt-<DD-MM-YYYY>-<DD-MM-YYYY>.json`, using the shared flyer format. No AI, no API key, no dependencies.

```bash
node scripts/get-aldi-offers.mjs                     # Sunday: the coming Mon–Sat; otherwise this week
node scripts/get-aldi-offers.mjs "https://prospekt.aldi-sued.de/kw48-26-op-mp"   # a specific flyer
node scripts/get-aldi-offers.mjs --today 2026-11-22  # pretend it's that day
```

The flyer viewer at prospekt.aldi-sued.de loads, for each page, the offers printed on it as
JSON. The script reads:

1. `https://www.aldi-sued.de/prospekte`: finds the flyer for the week by its name (`kw48-26-…` = week 48 of 2026)
2. `<flyer>/data.json`: flyer id and page count
3. `<flyer>/spreads.json`: every page with its image
4. `<flyer>/page/<n>/hotspots_data.json`: the offers on page n, with where they are on the page

Recipes on the pages are skipped (listed under `skipped`). An offer on the facing page comes
back cut to zero size and is ignored, so each offer is counted once. A page that can't be read
is listed in `failed_pages` (exit code 1); a flyer whose offers don't start in the week is an
error. These are not public APIs: they can change without notice.

ALDI fields in the shared flyer format

| field | ALDI flyer |
|---|---|
| `product` | `title` ("Nackensteak") |
| `brand` | `brand` ("MEINE METZGEREI"); `null` for some fresh produce |
| `price` | `discountedPrice`, else `price` ("Aktion" offers have only one price) |
| `original_price` | `price` when there is a `discountedPrice` (the crossed-out price), else `null` |
| `discount` | "-20%" from the discount percentage, else `null` |
| `detail` | description, unit price (with deposit), and "Verfügbar ab …" for offers starting after Monday |
| `image_bbox` | the offer's area on the page, `[x1, y1, x2, y2]` from 0 to 1 |
| `page` | flyer page number; `pages[]` has the page image (`at1200`) |

ALDI-only details are in each `pages` entry under `aldi`, in the same order as that page's
products: `id` (article number_week), `start_date`, `unit_price`, `badges` ("Aktion", "XXL"),
`product_type` (ALDI's own category, e.g. "Geflügel frisch - Hühnchen frisch") and
`photo_url` (the product on its own, without the flyer around it).

## Tests

Run `npm test` to execute the Node.js test suite. The ALDI and EDEKA parser tests use saved HTML and JSON responses in `scripts/fixtures/` so they can run offline.
