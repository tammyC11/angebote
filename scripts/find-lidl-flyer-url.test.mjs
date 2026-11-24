import { test } from "node:test";
import assert from "node:assert/strict";
import { findLidlFlyerUrls, flyerApiUrl, parseAktionsprospekte, pickFlyers } from "./find-lidl-flyer-url.mjs";

// anchors as served by lidl.de/c/online-prospekte/s10005610 (22.11.2026), trimmed
const anchor = (slug, name = "Aktionsprospekt") => `<a href="https://www.lidl.de/l/prospekte/${slug}/ar/0?_ab=1&amp;lf=HHZ"
   target="_self"
   class="flyer"
   data-track-flyer
   data-track-name="${name}"
   data-track-type="flyer"
>`;
const PAGE = `<html><body>
  ${anchor("aktionsprospekt-23-11-2026-28-11-2026-7af21b")}
  ${anchor("aktionsprospekt-23-11-2026-28-11-2026-08ced1")}
  ${anchor("aktionsprospekt-30-11-2026-05-12-2026-faadb9")}
  ${anchor("spielwarenmagazin-2026-entdecke-zahlreiche-geschenkideen", "Spielwarenmagazin")}
  <a href="https://www.lidl.de/l/prospekte/aktionsprospekt-07-12-2026-12-12-2026-4da77e/ar/0">no tracking attribute</a>
</body></html>`;

test("parseAktionsprospekte: reads the id and dates of each tracked Aktionsprospekt link, in page order", () => {
  assert.deepEqual(parseAktionsprospekte(PAGE), [
    { id: "aktionsprospekt-23-11-2026-28-11-2026-7af21b", start: "2026-11-23", end: "2026-11-28" },
    { id: "aktionsprospekt-23-11-2026-28-11-2026-08ced1", start: "2026-11-23", end: "2026-11-28" },
    { id: "aktionsprospekt-30-11-2026-05-12-2026-faadb9", start: "2026-11-30", end: "2026-12-05" },
  ]);
});

test("parseAktionsprospekte: ignores other flyers and repeated links", () => {
  const html = anchor("aktionsprospekt-23-11-2026-28-11-2026-7af21b") + anchor("aktionsprospekt-23-11-2026-28-11-2026-7af21b");
  assert.equal(parseAktionsprospekte(html).length, 1);
  assert.deepEqual(parseAktionsprospekte("<a href='x'>nothing</a>"), []);
});

test("pickFlyers: the coming week on a Sunday, this week on a weekday, every flyer of that week", () => {
  const flyers = parseAktionsprospekte(PAGE);
  const ids = (today) => pickFlyers(flyers, today).map((f) => f.id.slice(-6));
  assert.deepEqual(ids("2026-11-22"), ["7af21b", "08ced1"]);
  assert.deepEqual(ids("2026-11-25"), ["7af21b", "08ced1"]);
  assert.deepEqual(ids("2026-11-28"), ["7af21b", "08ced1"]);
  assert.deepEqual(ids("2026-11-29"), ["faadb9"]);
  assert.throws(() => pickFlyers(flyers, "2026-12-06"), /ends on or after 2026-12-06/);
});

test("flyerApiUrl: the leaflet API URL extract-flyer-lidl expects", () => {
  assert.equal(
    flyerApiUrl("aktionsprospekt-23-11-2026-28-11-2026-7af21b"),
    "https://endpoints.leaflets.schwarz/v4/flyer?flyer_identifier=aktionsprospekt-23-11-2026-28-11-2026-7af21b&region_id=0&region_code=0",
  );
});

test("findLidlFlyerUrls: downloads the flyers page once and builds a URL for each flyer of the week", async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return new Response(PAGE, { status: 200 });
  };
  const found = await findLidlFlyerUrls({ today: "2026-11-22", fetchImpl, log: () => {} });
  assert.deepEqual(urls, ["https://www.lidl.de/c/online-prospekte/s10005610"]);
  assert.deepEqual(found, [
    "https://endpoints.leaflets.schwarz/v4/flyer?flyer_identifier=aktionsprospekt-23-11-2026-28-11-2026-7af21b&region_id=0&region_code=0",
    "https://endpoints.leaflets.schwarz/v4/flyer?flyer_identifier=aktionsprospekt-23-11-2026-28-11-2026-08ced1&region_id=0&region_code=0",
  ]);
});

test("findLidlFlyerUrls: says so when the page has no Aktionsprospekt link", async () => {
  const fetchImpl = async () => new Response("<html></html>", { status: 200 });
  await assert.rejects(findLidlFlyerUrls({ today: "2026-11-22", fetchImpl, log: () => {} }), /no Aktionsprospekt link found/);
});
