# Research Food Diary — GepnerLab

A Hebrew, mobile-first food diary for the GepnerLab study (groups **CR**, **TRE**, **RT**).
Participants install it on their phone's home screen (iPhone and Android). Each participant's
meals and photos are uploaded to the lab's Google Drive, into a separate folder per participant.

- **Hosting:** GitHub Pages (free static hosting of this folder).
- **Cloud storage:** Google Apps Script web app → Google Drive + Google Sheets (no server to run).
- **Food composition:** *Tzameret* (צמרת), the Israeli Ministry of Health national nutrient database
  (4,624 foods, 74 nutrients per 100 g, official portion weights), from
  [data.gov.il](https://data.gov.il/dataset/nutrition-database). Last data update: 2022-07-11.
- **Packaged products not in Tzameret:** scan the barcode → [Open Food Facts](https://world.openfoodfacts.org)
  (open database, ODbL licence). Its values are only used after the participant confirms they match the
  label in their hand; otherwise they correct them in the label form. See *Barcode scanning* below.

## What the app records (per meal)

| Field | Notes |
|---|---|
| Date, weekday, eating time, meal type | weekday is derived from the date |
| Free-text description | the participant's own words, for researcher review |
| Ingredients | each with Tzameret code (`Code`, `smlmitzrach`) or barcode / package label, quantity, portion unit, unit grams, total grams, per-100 g values used |
| Plate waste | % left on the plate; net nutrients = gross × (100 − %) |
| Nutrients | kcal, protein, carbs, fat, calcium, sodium, fiber, sugars, sat. fat, iron, cholesterol |
| Missing values | a nutrient missing in Tzameret stays **empty (not 0)** and is listed in `missing_nutrients` |
| Photo | full photo (1280 px JPEG) in Drive; small thumbnail kept on the phone |
| Audit | `entered_at`, `updated_at`, `received_at`, deletions are soft (row kept, `deleted = TRUE`) |

The TRE 8-hour window is measured from the day's first meal; meals after first + 8 h are flagged.
RT participants never see nutrition values. A researcher can unlock them on an RT phone only if
`RESEARCHER_PIN` is set in `config.js`; with no PIN the option does not exist on the phone at all.
Participants pick their own group at first sign-in and confirm code + group before the diary opens.

## Barcode scanning (2.4.0)

When a search finds nothing in Tzameret, the app offers **Scan barcode** (also in the *From package label* tab,
or type the barcode number into the search box). The camera reads EAN-13/EAN-8/UPC codes: Android Chrome uses
its built-in reader; iPhone Safari uses the bundled open-source ZXing library (`vendor/`, Apache-2.0).
If the camera is refused or missing, the participant types the 13 digits (the check digit is verified).

| What happens | Ingredient `source` |
|---|---|
| Found, participant answers *“values match the label”* | `openfoodfacts` |
| Found, participant answers *“no”* and corrects, or values were missing / implausible | `openfoodfacts_corrected` |
| Not in Open Food Facts, offline, or service down → typed from the label (barcode kept) | `label` |
| Typed from the label without scanning | `label` (no barcode) |

Every barcode item stores the `barcode` and the values exactly as fetched (`barcode_db_values`, JSON with the
product's last-modified date), so values used can be compared with values fetched. Values that are obviously
wrong (energy far from 4/4/9 × macros, > 950 kcal or > 105 g macros per 100 g) are never offered for one-tap
confirmation; the label form opens instead. Scanned products are saved to the participant's *My products*, so
scanning the same barcode again is instant and works offline.

## Files

| Path | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | the app |
| `config.js` | **the only file to edit** — backend URL, study key, researcher PIN |
| `foods.json` | Tzameret, compacted for the app (built by `tools/build_foods.py`) |
| `sw.js`, `manifest.webmanifest`, `icons/` | home-screen install + offline support |
| `apps-script/Code.gs` | the Google backend (paste into Apps Script) |
| `vendor/` | ZXing barcode reader (iPhone) + its licence |
| `data-source/` | raw Tzameret tables as downloaded (provenance) |
| `tools/` | build scripts (food database, logo, icons) |

## Setup

### 1. Google Drive backend (once, with the lab's Google account)

1. In Google Drive create a new Google Sheet, e.g. **"Food Diary — Study Control"**.
2. In that sheet: **Extensions → Apps Script**. Delete the sample code, paste `apps-script/Code.gs`.
   In *Project Settings* tick "Show appsscript.json" and paste `apps-script/appsscript.json`.
3. Select the function **`setup`** and press **Run**. Google asks for permission (Drive + Sheets) — allow it.
   It creates the Drive folder *"Food Diary Study — Participant Data"*, the `Participants` and `SyncLog`
   tabs, and shows a **STUDY_KEY**.
4. **Deploy → New deployment → Web app**: *Execute as: Me*, *Who has access: Anyone*. Copy the URL ending in `/exec`.
5. Put the URL and STUDY_KEY into `config.js` (`BACKEND_URL`, `STUDY_KEY`), and choose a `RESEARCHER_PIN`.
6. Participants register themselves: on first sign-in they type their code and pick their group, and the
   app adds a row to the `Participants` tab (`notes` = *self-registered*). A code that already exists keeps
   its group (signing in on a new phone restores the diary). To block a code, untick `active`.
   Give participants random codes, not `P001`, `P002` — the code is the only thing that identifies them.

For analysis, use the sheet menu **יומן אכילה → Build combined dataset**: it writes `All_Meals`,
`All_Ingredients` and `Daily_Summary` (incl. TRE window and violations) from every participant.

> Changing `Code.gs` later requires **Deploy → Manage deployments → Edit → New version**, otherwise the
> old code keeps running.

### 2. GitHub Pages hosting

1. Create the lab's GitHub account and an empty public repository (e.g. `food-diary`).
2. Push this folder to it (or upload the files on github.com: *Add file → Upload files*).
3. Repository **Settings → Pages → Build from branch → `main` / root**. The app is then at
   `https://<account>.github.io/food-diary/`.
4. Every later change: bump `CACHE_VERSION` in `sw.js` so installed phones pick up the new files.

### 3. Participants

Send the link. On the phone:
- **iPhone (Safari):** Share ⬆︎ (on newer iOS inside the ☰ menu next to the address) → *Add to Home Screen* → *Add*.
- **Android (Chrome):** ⋮ → *Add to Home screen* / *Install app* (the app also shows an "Install" button).

Install **before** entering the participant code: on iPhone the home-screen app has its own storage,
separate from Safari. If a phone is replaced, entering the same code restores previously uploaded meals.

## Tests

The automated tests live in `tests/` on the development machine (not part of the website):
```bash
node --test tests/*.test.js
```
`app.test.js` runs the real `app.js` (search, nutrient maths, portions, TRE window, storage, sign-in,
upload queue); `barcode.test.js` covers scanning, Open Food Facts parsing and every fallback;
`gas.test.js` runs `apps-script/Code.gs` against an in-memory fake of Sheets/Drive.

## Rebuilding the food database

```bash
python3 tools/build_foods.py
```
Reads `data-source/*.json` (Tzameret tables) and writes `foods.json`. Bump `CACHE_VERSION` in `sw.js` afterwards.

## Known limits

- The TRE window is counted per calendar day: a snack at 00:30 belongs to the next day's window.
- Meals cannot be edited, only deleted and added again (deletions are kept in Drive, flagged `deleted`).
- Photos stay in Drive; a participant who signs in on a new phone gets their meals back without photos.
- If the server ever refuses a meal (e.g. a code mismatch), the phone marks it "not uploaded" and keeps
  uploading the rest; the participant can still export it to Excel from the menu.

- Tzameret's branded products reflect 2022; newer packaged products come from a barcode scan (confirmed against
  the label) or are typed from the label.
- Open Food Facts is crowd-sourced. Its coverage of Israeli products is partial (~7,700 with nutrition values in
  late 2026), and values are only as good as the participant's check against the label.
- Portion sizes are self-reported — the main source of error in any food diary. The app requires an explicit portion
  choice for every food (no default) and warns above 500 g, and the photo lets researchers check.
- The study key in `config.js` is visible to anyone who opens the site; it blocks random traffic, not a determined
  attacker. Participant codes should be random. No names or other identifying data are collected.
