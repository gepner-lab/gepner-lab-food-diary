/**
 * Research Food Diary — Google Apps Script backend.
 *
 * Paste this file into an Apps Script project that is bound to the study's
 * control spreadsheet (Sheets → Extensions → Apps Script). See README.md.
 *
 * Drive layout created by this script:
 *   <Root folder>/
 *     <PARTICIPANT_CODE>/
 *       FoodDiary_<CODE>   (spreadsheet: Meals, Ingredients)
 *       photos/<date>_<time>_<mealId>.jpg
 *
 * Control spreadsheet (the one this script is bound to):
 *   Participants : code | group | active | notes | registered_at | last_sync_at | folder_url
 *   SyncLog      : time | action | code | detail
 *   All_Meals / All_Ingredients / Daily_Summary : built by "Build combined dataset"
 */

const MEAL_HEADERS = [
  'meal_id', 'participant_code', 'group', 'date', 'day_name', 'meal_type', 'time',
  'description', 'ingredients_summary', 'finished', 'leftover_pct',
  'kcal', 'protein_g', 'carb_g', 'fat_g', 'calcium_mg', 'sodium_mg',
  'fiber_g', 'sugar_g', 'satfat_g', 'iron_mg', 'cholesterol_mg',
  'missing_nutrients', 'photo_url', 'entered_at', 'updated_at', 'received_at',
  'deleted', 'db_version', 'app_version', 'raw_json'
];
const ING_HEADERS = [
  'meal_id', 'participant_code', 'date', 'time', 'item_no', 'source', 'tzameret_code', 'smlmitzrach',
  'food_name', 'quantity', 'unit', 'unit_grams', 'grams', 'leftover_pct',
  'kcal', 'protein_g', 'carb_g', 'fat_g', 'calcium_mg', 'sodium_mg',
  'fiber_g', 'sugar_g', 'satfat_g', 'iron_mg', 'cholesterol_mg', 'deleted',
  // 2.4.0: packaged products scanned by barcode (added at the end so older rows stay aligned)
  'barcode', 'barcode_db_values'
];
const ING_DELETED = ING_HEADERS.indexOf('deleted');
const NUT_KEYS = ['cal', 'pro', 'carb', 'fat', 'calc', 'sod', 'fiber', 'sugar', 'satfat', 'iron', 'chol'];
const PARTICIPANT_HEADERS = ['code', 'group', 'active', 'notes', 'registered_at', 'last_sync_at', 'folder_url'];
const VALID_GROUPS = ['CR', 'TRE', 'RT'];

// ---------------------------------------------------------------------------
// One-time setup — run from the editor (select "setup" → Run).
// ---------------------------------------------------------------------------
function setup() {
  const props = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('This script must be bound to a Google Sheet (Extensions → Apps Script).');
  props.setProperty('CONTROL_SHEET_ID', ss.getId());

  if (!props.getProperty('ROOT_FOLDER_ID')) {
    const folder = DriveApp.createFolder('Food Diary Study — Participant Data');
    props.setProperty('ROOT_FOLDER_ID', folder.getId());
  }
  if (!props.getProperty('STUDY_KEY')) {
    props.setProperty('STUDY_KEY', Utilities.getUuid().replace(/-/g, '').slice(0, 20));
  }

  const p = getOrCreateSheet_(ss, 'Participants', PARTICIPANT_HEADERS);
  p.getRange('B2:B1000').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(VALID_GROUPS, true).build());
  p.getRange('C2:C1000').insertCheckboxes();
  getOrCreateSheet_(ss, 'SyncLog', ['time', 'action', 'code', 'detail']);
  const def = ss.getSheetByName('Sheet1') || ss.getSheetByName('גיליון1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);

  const root = DriveApp.getFolderById(props.getProperty('ROOT_FOLDER_ID'));
  const msg = 'Setup complete.\n\nSTUDY_KEY (copy into config.js): ' + props.getProperty('STUDY_KEY') +
    '\n\nData folder: ' + root.getUrl() +
    '\n\nNext: add participant codes to the "Participants" sheet, then Deploy → New deployment → Web app.';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* not in UI context */ }
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('יומן אכילה')
    .addItem('Build combined dataset (All_Meals / All_Ingredients / Daily_Summary)', 'buildCombinedDataset')
    .addItem('Show STUDY_KEY and data folder', 'showSettings')
    .addToUi();
}

function showSettings() {
  const props = PropertiesService.getScriptProperties();
  const root = DriveApp.getFolderById(props.getProperty('ROOT_FOLDER_ID'));
  SpreadsheetApp.getUi().alert('STUDY_KEY: ' + props.getProperty('STUDY_KEY') + '\nData folder: ' + root.getUrl());
}

// ---------------------------------------------------------------------------
// Web app entry points
// ---------------------------------------------------------------------------
function doGet() {
  return json_({ ok: true, service: 'food-diary', time: new Date().toISOString() });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad_json' });
  }
  const props = PropertiesService.getScriptProperties();
  if (!req.studyKey || req.studyKey !== props.getProperty('STUDY_KEY')) {
    return json_({ ok: false, error: 'bad_study_key' });
  }
  const code = String(req.participantCode || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,40}$/.test(code)) return json_({ ok: false, error: 'bad_code_format' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return json_({ ok: false, error: 'busy' });
  try {
    let participant = findParticipant_(code);
    let created = false;
    // Self-registration: a new code signing in is added to the Participants sheet with the
    // group the participant chose. An existing code keeps the group already in the sheet.
    if (!participant && req.action === 'register') {
      const group = String(req.group || '').trim().toUpperCase();
      if (VALID_GROUPS.indexOf(group) === -1) return json_({ ok: false, error: 'bad_group' });
      addParticipant_(code, group);
      participant = findParticipant_(code);
      created = true;
    }
    if (!participant) { log_('rejected', code, req.action); return json_({ ok: false, error: 'unknown_code' }); }
    if (participant.active === false) return json_({ ok: false, error: 'inactive_code' });
    if (req.action === 'register') {
      const res = register_(participant, req);
      res.created = created;
      return json_(res);
    }

    switch (req.action) {
      case 'register': return json_(register_(participant, req));
      case 'upsertMeal': return json_(upsertMeal_(participant, req));
      default: return json_({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    log_('error', code, String(err && err.stack || err));
    return json_({ ok: false, error: 'server_error' });
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
function register_(participant, req) {
  const files = ensureParticipantFiles_(participant);
  if (!participant.registeredAt) setParticipantField_(participant.row, 'registered_at', new Date());
  log_('register', participant.code, (req.userAgent || '').slice(0, 200));

  // Return previously uploaded meals so a new phone can restore the diary.
  const sheet = files.ss.getSheetByName('Meals');
  const meals = [];
  if (sheet.getLastRow() > 1) {
    const rawCol = MEAL_HEADERS.indexOf('raw_json') + 1;
    const delCol = MEAL_HEADERS.indexOf('deleted') + 1;
    const vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, MEAL_HEADERS.length).getValues();
    vals.forEach(function (r) {
      if (r[delCol - 1] === true) return;
      try { meals.push(JSON.parse(r[rawCol - 1])); } catch (e) {}
    });
  }
  return { ok: true, group: participant.group, meals: meals };
}

function upsertMeal_(participant, req) {
  const meal = req.meal;
  if (!meal || !meal.id) return { ok: false, error: 'missing_meal' };
  if (String(meal.participantCode).toUpperCase() !== participant.code) return { ok: false, error: 'code_mismatch' };

  const files = ensureParticipantFiles_(participant);
  const now = new Date();

  // Photo → Drive (one file per meal; re-upload replaces the old one).
  let photoUrl = '';
  const mealsSheet = files.ss.getSheetByName('Meals');
  const rowIdx = findRowById_(mealsSheet, meal.id);
  if (rowIdx > 0) photoUrl = mealsSheet.getRange(rowIdx, MEAL_HEADERS.indexOf('photo_url') + 1).getValue();
  if (req.photoBase64) {
    const name = [meal.date, String(meal.time).replace(':', ''), meal.id].join('_') + '.jpg';
    const existing = files.photos.getFilesByName(name);
    while (existing.hasNext()) existing.next().setTrashed(true);
    const blob = Utilities.newBlob(Utilities.base64Decode(req.photoBase64), 'image/jpeg', name);
    photoUrl = files.photos.createFile(blob).getUrl();
  }

  const n = meal.nutrition || {};
  const mealRow = [
    meal.id, participant.code, participant.group, "'" + meal.date, meal.dayName, meal.mealType, "'" + meal.time,
    meal.description, meal.preciseSummary, meal.finished === true, meal.leftoverPct || 0
  ].concat(NUT_KEYS.map(function (k) { return numOrBlank_(n[k]); })).concat([
    (meal.missingNutrients || []).join(','), photoUrl, meal.enteredAt || '', meal.updatedAt || '', now,
    meal.deleted === true, meal.dbVersion || '', meal.appVersion || '', JSON.stringify(meal)
  ]);
  if (rowIdx > 0) mealsSheet.getRange(rowIdx, 1, 1, mealRow.length).setValues([mealRow]);
  else mealsSheet.appendRow(mealRow);

  // Ingredients: replace this meal's rows.
  const ingSheet = files.ss.getSheetByName('Ingredients');
  ensureHeaders_(ingSheet, ING_HEADERS);
  deleteRowsById_(ingSheet, meal.id);
  const ingRows = (meal.ingredients || []).map(function (ing, i) {
    const net = ing.net || {};
    return [
      meal.id, participant.code, "'" + meal.date, "'" + meal.time, i + 1, ing.source,
      ing.tzameretCode || '', ing.smlmitzrach || '', ing.name, ing.quantity, ing.unitName,
      numOrBlank_(ing.unitGrams), numOrBlank_(ing.grams), meal.leftoverPct || 0
    ].concat(NUT_KEYS.map(function (k) { return numOrBlank_(net[k]); })).concat([
      meal.deleted === true,
      ing.barcode ? "'" + ing.barcode : '',   // as text, so leading zeros survive
      ing.offPer100 ? JSON.stringify({ source: 'openfoodfacts', per100: ing.offPer100, last_modified: ing.offLastModified || null }) : ''
    ]);
  });
  if (ingRows.length) {
    ingSheet.getRange(ingSheet.getLastRow() + 1, 1, ingRows.length, ING_HEADERS.length).setValues(ingRows);
  }

  setParticipantField_(participant.row, 'last_sync_at', now);
  log_(meal.deleted ? 'delete' : 'upsert', participant.code, meal.id);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Combined dataset for analysis (run from the spreadsheet menu)
// ---------------------------------------------------------------------------
function buildCombinedDataset() {
  const control = controlSheet_();
  const pSheet = control.getSheetByName('Participants');
  const pVals = pSheet.getLastRow() > 1 ? pSheet.getRange(2, 1, pSheet.getLastRow() - 1, PARTICIPANT_HEADERS.length).getValues() : [];
  const allMeals = [], allIngs = [];

  pVals.forEach(function (r) {
    const code = String(r[0]).trim().toUpperCase();
    if (!code) return;
    const ss = findParticipantSpreadsheet_(code);
    if (!ss) return;
    const m = ss.getSheetByName('Meals'), g = ss.getSheetByName('Ingredients');
    if (m.getLastRow() > 1) {
      m.getRange(2, 1, m.getLastRow() - 1, MEAL_HEADERS.length).getValues().forEach(function (row) {
        if (row[MEAL_HEADERS.indexOf('deleted')] !== true) allMeals.push(row.slice(0, MEAL_HEADERS.length - 1));
      });
    }
    if (g.getLastRow() > 1) {
      g.getRange(2, 1, g.getLastRow() - 1, ING_HEADERS.length).getValues().forEach(function (row) {
        if (row[ING_DELETED] !== true) allIngs.push(withoutCol_(row, ING_DELETED));
      });
    }
  });

  writeTable_(control, 'All_Meals', MEAL_HEADERS.slice(0, -1), allMeals);
  writeTable_(control, 'All_Ingredients', withoutCol_(ING_HEADERS, ING_DELETED), allIngs);

  // Daily summary per participant/date, incl. the TRE 8-hour window check.
  const H = function (name) { return MEAL_HEADERS.indexOf(name); };
  const byDay = {};
  allMeals.forEach(function (r) {
    const date = r[H('date')] instanceof Date ? Utilities.formatDate(r[H('date')], 'Asia/Jerusalem', 'yyyy-MM-dd') : String(r[H('date')]);
    const key = r[H('participant_code')] + '|' + date;
    (byDay[key] = byDay[key] || { code: r[H('participant_code')], group: r[H('group')], date: date, rows: [] }).rows.push(r);
  });
  const nutCols = ['kcal', 'protein_g', 'carb_g', 'fat_g', 'calcium_mg', 'sodium_mg', 'fiber_g', 'sugar_g', 'satfat_g', 'iron_mg', 'cholesterol_mg'];
  const dayRows = Object.keys(byDay).sort().map(function (k) {
    const d = byDay[k];
    const mins = d.rows.map(function (r) { return toMinutes_(r[H('time')]); }).sort(function (a, b) { return a - b; });
    const first = mins[0], last = mins[mins.length - 1];
    const violations = mins.filter(function (x) { return x > first + 480; }).length;
    const sums = nutCols.map(function (c) {
      return Math.round(d.rows.reduce(function (s, r) { return s + (Number(r[H(c)]) || 0); }, 0) * 100) / 100;
    });
    const missing = {};
    d.rows.forEach(function (r) { String(r[H('missing_nutrients')] || '').split(',').filter(String).forEach(function (x) { missing[x] = true; }); });
    return [d.code, d.group, d.date, d.rows.length, fromMinutes_(first), fromMinutes_(last), last - first,
      d.group === 'TRE' ? violations : ''].concat(sums).concat([Object.keys(missing).join(',')]);
  });
  writeTable_(control, 'Daily_Summary',
    ['participant_code', 'group', 'date', 'meal_count', 'first_meal', 'last_meal', 'eating_window_min', 'tre_violations']
      .concat(nutCols).concat(['missing_nutrients']), dayRows);

  try {
    SpreadsheetApp.getUi().alert('Combined dataset built: ' + allMeals.length + ' meals, ' + allIngs.length + ' ingredients, ' + dayRows.length + ' participant-days.');
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function controlSheet_() {
  return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('CONTROL_SHEET_ID'));
}

function findParticipant_(code) {
  const sheet = controlSheet_().getSheetByName('Participants');
  if (sheet.getLastRow() < 2) return null;
  const vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, PARTICIPANT_HEADERS.length).getValues();
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim().toUpperCase() === code) {
      const group = String(vals[i][1]).trim().toUpperCase();
      if (VALID_GROUPS.indexOf(group) === -1) return null;
      return { code: code, group: group, active: vals[i][2] !== false, registeredAt: vals[i][4], row: i + 2 };
    }
  }
  return null;
}

function addParticipant_(code, group) {
  const sheet = controlSheet_().getSheetByName('Participants');
  const row = sheet.getLastRow() + 1;
  sheet.getRange(row, 1, 1, 4).setValues([[code, group, true, 'self-registered']]);
  log_('self_register', code, group);
}

function setParticipantField_(row, field, value) {
  controlSheet_().getSheetByName('Participants').getRange(row, PARTICIPANT_HEADERS.indexOf(field) + 1).setValue(value);
}

function ensureParticipantFiles_(participant) {
  const root = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('ROOT_FOLDER_ID'));
  const folder = firstOrCreateFolder_(root, participant.code);
  const photos = firstOrCreateFolder_(folder, 'photos');
  const ssName = 'FoodDiary_' + participant.code;
  let ss;
  const it = folder.getFilesByName(ssName);
  if (it.hasNext()) {
    ss = SpreadsheetApp.open(it.next());
  } else {
    ss = SpreadsheetApp.create(ssName);
    DriveApp.getFileById(ss.getId()).moveTo(folder);
    const first = ss.getSheets()[0];
    first.setName('Meals');
    first.appendRow(MEAL_HEADERS);
    first.setFrozenRows(1);
    const ing = ss.insertSheet('Ingredients');
    ing.appendRow(ING_HEADERS);
    ing.setFrozenRows(1);
    setParticipantField_(participant.row, 'folder_url', folder.getUrl());
  }
  return { folder: folder, photos: photos, ss: ss };
}

function findParticipantSpreadsheet_(code) {
  const root = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('ROOT_FOLDER_ID'));
  const f = root.getFoldersByName(code);
  if (!f.hasNext()) return null;
  const it = f.next().getFilesByName('FoodDiary_' + code);
  return it.hasNext() ? SpreadsheetApp.open(it.next()) : null;
}

function firstOrCreateFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function getOrCreateSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sh;
}

function findRowById_(sheet, id) {
  if (sheet.getLastRow() < 2) return -1;
  const ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (ids[i][0] === id) return i + 2;
  return -1;
}

function deleteRowsById_(sheet, id) {
  if (sheet.getLastRow() < 2) return;
  const ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) if (ids[i][0] === id) sheet.deleteRow(i + 2);
}

function writeTable_(ss, name, headers, rows) {
  let sh = ss.getSheetByName(name);
  if (sh) sh.clear(); else sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  if (rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sh.setFrozenRows(1);
}

// Older participant sheets get the newer column names added to their header row.
function ensureHeaders_(sheet, headers) {
  const range = sheet.getRange(1, 1, 1, headers.length);
  if (range.getValues()[0].join('|') !== headers.join('|')) range.setValues([headers]).setFontWeight('bold');
}

function withoutCol_(row, idx) { return row.slice(0, idx).concat(row.slice(idx + 1)); }

function numOrBlank_(v) { return (v === null || v === undefined || v === '') ? '' : Number(v); }

function toMinutes_(t) {
  if (t instanceof Date) return t.getHours() * 60 + t.getMinutes();
  const p = String(t).replace("'", '').split(':');
  return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
}

function fromMinutes_(m) {
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

function log_(action, code, detail) {
  try {
    controlSheet_().getSheetByName('SyncLog').appendRow([new Date(), action, code, String(detail || '').slice(0, 500)]);
  } catch (e) {}
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
