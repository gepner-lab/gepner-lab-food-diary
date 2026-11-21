// =============================================================================
// Research Food Diary (GepnerLab) — app logic
// Food composition: Tzameret (Israeli MoH national nutrient database), loaded
// from foods.json. Every saved ingredient keeps its Tzameret code, portion unit,
// gram weight and the per-100g values used, so the research team can audit or
// recompute any number later.
// =============================================================================
'use strict';

const CFG = Object.assign({ BACKEND_URL: '', STUDY_KEY: '', RESEARCHER_PIN: '', SYNC_RETRY_MS: 60000 }, window.STUDY_CONFIG || {});
function cloudEnabled() { return !!CFG.BACKEND_URL; }
const APP_VERSION = '2.4.0';

const NUT_KEYS = ['cal', 'pro', 'carb', 'fat', 'calc', 'sod', 'fiber', 'sugar', 'satfat', 'iron', 'chol'];
const CORE_KEYS = ['cal', 'pro', 'carb', 'fat', 'calc', 'sod'];
const NUT_LABELS = {
    cal: 'קלוריות (kcal)', pro: 'חלבון (גרם)', carb: 'פחמימות (גרם)', fat: 'שומן (גרם)',
    calc: 'סידן (מ"ג)', sod: 'נתרן (מ"ג)', fiber: 'סיבים תזונתיים (גרם)', sugar: 'סוכרים (גרם)',
    satfat: 'שומן רווי (גרם)', iron: 'ברזל (מ"ג)', chol: 'כולסטרול (מ"ג)'
};
const NUT_SHORT = { cal: 'קלוריות', pro: 'חלבון', carb: 'פחמימות', fat: 'שומן', calc: 'סידן', sod: 'נתרן' };
const NUT_UNIT = { cal: 'קק״ל', pro: 'ג׳', carb: 'ג׳', fat: 'ג׳', calc: 'מ״ג', sod: 'מ״ג' };
const GRAM_UNIT = 700; // Tzameret unit code for grams
const HEBREW_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const HEBREW_DAY_LETTERS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const STORAGE_KEY = 'research_food_diary_v2';
const UI_KEY = 'research_food_diary_ui';

// =============================================================================
// 1. STORAGE (localStorage with in-memory fallback; reports failures)
// =============================================================================
const SafeStorage = (function () {
    const mem = {};
    let available = false;
    try {
        window.localStorage.setItem('__fd_test__', '1');
        window.localStorage.removeItem('__fd_test__');
        available = true;
    } catch (e) { available = false; }
    return {
        available: function () { return available; },
        getItem: function (key) {
            if (available) { try { return window.localStorage.getItem(key); } catch (e) {} }
            return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null;
        },
        setItem: function (key, val) {
            mem[key] = String(val);
            if (!available) return false;
            try { window.localStorage.setItem(key, String(val)); return true; } catch (e) { return false; }
        }
    };
})();

// =============================================================================
// 2. FOOD DATABASE (Tzameret)
// =============================================================================
const FoodDB = { loaded: false, meta: null, foods: [], byCode: {}, unitNames: {} };

function normalizeText(str) {
    return String(str || '')
        .toLowerCase()
        .replace(/[׳’'`"״]/g, '')
        .replace(/[.,;:()\[\]\/\\\-–—+%]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function loadFoodDatabase() {
    const resp = await fetch('foods.json');
    if (!resp.ok) throw new Error('foods.json HTTP ' + resp.status);
    const data = await resp.json();
    FoodDB.meta = { source: data.source, sourceUrl: data.sourceUrl, dataLastUpdated: data.dataLastUpdated, nutrientsPer: data.nutrientsPer };
    FoodDB.unitNames = data.unitNames;
    FoodDB.foods = data.foods.map(function (f) {
        const n = {};
        NUT_KEYS.forEach(function (k, i) { n[k] = f[5][i]; });
        const food = { code: f[0], sml: f[1], name: f[2], en: f[3], makor: f[4], n: n, units: f[6], isFfq: /^FFQ/.test(f[2]) };
        food.norm = normalizeText(food.name.replace(/^FFQ-?/, '')) + ' | ' + normalizeText(food.en);
        return food;
    });
    FoodDB.foods.forEach(function (f) { FoodDB.byCode[f.code] = f; });
    FoodDB.loaded = true;
}

function unitName(code) {
    if (code === GRAM_UNIT) return 'גרם';
    return FoodDB.unitNames[code] || ('יחידה ' + code);
}

function unitsForFood(f) { return f.units.concat([[GRAM_UNIT, 1]]); }
const RAW_FORMS = ['לא מבושל', 'מיובש', 'אבקה', 'יבש', 'גולמי'];
const LARGE_PORTION_G = 500;  // above this, ask the participant to double-check

// Every query word must appear; rank by how early / whole-word it matches.
function searchFoods(query, limit) {
    const q = normalizeText(query);
    if (!q) return [];
    const tokens = q.split(' ').filter(Boolean);
    const results = [];
    for (let i = 0; i < FoodDB.foods.length; i++) {
        const f = FoodDB.foods[i];
        let score = 0, ok = true;
        for (let t = 0; t < tokens.length; t++) {
            let idx = f.norm.indexOf(tokens[t]);
            if (idx === -1) { ok = false; break; }
            // "מבושל" must not be satisfied by "לא מבושל" (raw) when a better match exists
            if (f.norm.slice(Math.max(0, idx - 3), idx) === 'לא ') {
                const again = f.norm.indexOf(tokens[t], idx + 1);
                if (again !== -1) idx = again; else score -= 60;
            }
            if (idx === 0) score += 60;
            else if (f.norm.charAt(idx - 1) === ' ') score += 30;
            else if (/^[הובלמכש]$/.test(f.norm.charAt(idx - 1)) && (idx === 1 || f.norm.charAt(idx - 2) === ' ')) score += 20;
            score -= Math.min(idx, 40) * 0.3;
        }
        if (!ok) continue;
        score -= f.name.length * 0.25;
        if (f.isFfq) score -= 25;
        // Diary entries are mostly ready-to-eat foods: rank raw / dried / powder forms lower
        // unless the participant typed those words.
        RAW_FORMS.forEach(function (w) { if (f.norm.indexOf(w) !== -1 && q.indexOf(w) === -1) score -= 15; });
        results.push({ f: f, score: score });
    }
    results.sort(function (a, b) { return b.score - a.score; });
    return results.slice(0, limit || 40).map(function (r) { return r.f; });
}

// =============================================================================
// 3. STATE
// =============================================================================
let appState = {
    isLocked: false,
    participantCode: '',
    group: 'CR',
    registeredAt: '',
    selectedDate: '',
    selectedDayName: '',
    userPickedDate: false,
    meals: [],
    savedCustomProducts: [],
    rtSummaryRevealed: false,
    // Draft of the meal being added
    step: 1,
    draft: { type: '', time: '', desc: '' },
    // { uid, kind:'tz', code, unitCode, quantity }
    // | { uid, kind:'label', name, basis, per, amount, badge, source?, barcode?, unitGrams?, unitLabel?, offPer100?, offLastModified? }
    activeIngredients: [],
    scan: null,              // barcode product being confirmed (see section 9b)
    labelBarcode: null,      // barcode attached to the label form, when it was opened from a scan
    finishedFood: true,
    leftoverPct: 25,
    currentPhotoDataUrl: null,
    sync: { inFlight: false, lastError: '', lastSyncAt: '' }
};

let deferredInstallPrompt = null;

function newId(prefix) { return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
function visibleMeals() { return appState.meals.filter(function (m) { return !m.deleted && m.participantCode === appState.participantCode; }); }
function isRtBlinded() { return appState.group === 'RT' && !appState.rtSummaryRevealed; }
function $(id) { return document.getElementById(id); }

// Closing a sheet in code steps history back; the resulting popstate must not be read as the
// participant pressing Back (which would also move the meal form a step back).
let pendingProgrammaticBacks = 0;
function programmaticBack() { pendingProgrammaticBacks++; history.back(); }

// =============================================================================
// 4. INIT
// =============================================================================
document.addEventListener('DOMContentLoaded', function () {
    setSelectedDate(formatIsoDate(new Date()));

    if (cloudEnabled()) {
        $('auth-cloud-note').classList.remove('hidden');
    } else {
        $('auth-demo-note').classList.remove('hidden');
    }

    $('auth-form').addEventListener('submit', function (e) { e.preventDefault(); handleRegistration(); });

    document.querySelectorAll('#meal-type-chips button').forEach(function (b) {
        b.addEventListener('click', function () { appState.draft.type = b.dataset.type; renderTypeChips(); });
    });
    $('meal-time-input').addEventListener('input', function (e) { appState.draft.time = e.target.value; });
    $('meal-desc-input').addEventListener('input', function (e) { appState.draft.desc = e.target.value; });
    document.querySelectorAll('#source-seg button').forEach(function (b) {
        b.addEventListener('click', function () { switchSource(b.dataset.src); });
    });
    let searchTimer = null;
    $('food-search').addEventListener('input', function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(renderSearchResults, 120);
    });
    $('leftover-slider').addEventListener('input', function (e) { setLeftoverPct(e.target.value); });
    $('meal-photo-input').addEventListener('change', handlePhotoSelect);

    document.addEventListener('click', function (e) {
        if (!e.target.closest('#menu') && !e.target.closest('.icon-btn')) toggleMenu(false);
    });

    // Android back gesture / button closes an open sheet instead of leaving the app.
    window.addEventListener('popstate', function () {
        if (pendingProgrammaticBacks > 0) { pendingProgrammaticBacks--; return; }   // our own back(), not the participant
        if (!$('scanner-root').classList.contains('hidden')) { closeScanner(true); return; }
        if (!$('info-sheet-root').classList.contains('hidden')) { closeInfoSheet(true); return; }
        if (!$('meal-sheet-root').classList.contains('hidden')) {
            if (appState.step > 1) { appState.step--; renderSheetStep(); history.pushState({ sheet: 'meal' }, ''); }
            else closeMealSheet(true);
        }
    });

    window.addEventListener('online', function () { syncNow(false); });
    document.addEventListener('visibilitychange', function () {
        // The phone stops the camera when the app is in the background: close the scanner cleanly.
        if (document.visibilityState === 'hidden' && !$('scanner-root').classList.contains('hidden')) closeScanner();
        if (document.visibilityState === 'visible' && appState.isLocked) {
            // Returning to the app on a new day shows the new day.
            if (!appState.userPickedDate) setSelectedDate(formatIsoDate(new Date()));
            renderDiary();
            syncNow(false);
        }
    });
    setInterval(function () { if (pendingCount() > 0) syncNow(false); }, CFG.SYNC_RETRY_MS);

    window.addEventListener('beforeinstallprompt', function (e) {
        e.preventDefault();
        deferredInstallPrompt = e;
        renderInstallHints();
    });
    window.addEventListener('appinstalled', function () { deferredInstallPrompt = null; renderInstallHints(); });

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
        navigator.serviceWorker.register('sw.js').catch(function (err) { console.warn('SW registration failed', err); });
    }

    loadPersistedState();
    renderSourceFooter();
    renderInstallHints();

    loadFoodDatabase().then(function () {
        renderSourceFooter();
        $('food-search').disabled = false;
        $('food-search').placeholder = 'חיפוש מזון (לדוגמה: קוטג׳ 5, פיתה)';
    }).catch(function (err) {
        console.error(err);
        showToast('שגיאה בטעינת מאגר המזון. בדקו חיבור לאינטרנט ופתחו מחדש.', 'error');
    });

    if (appState.isLocked && appState.participantCode) {
        enterLockedDiaryView();
        syncNow(false);
    }
});

function formatIsoDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function parseIso(iso) { const p = iso.split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
function formatDisplayDate(iso) { if (!iso) return ''; const p = iso.split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : iso; }
function dayNameForIso(iso) { return HEBREW_DAYS[parseIso(iso).getDay()]; }
function addDays(iso, n) { const d = parseIso(iso); d.setDate(d.getDate() + n); return formatIsoDate(d); }
function ltr(s) { return '<bdi class="ltr">' + escapeHtml(s) + '</bdi>'; }

function setSelectedDate(iso) {
    appState.selectedDate = iso;
    appState.selectedDayName = dayNameForIso(iso);
}

function savePersistedState() {
    const ok = SafeStorage.setItem(STORAGE_KEY, JSON.stringify({
        isLocked: appState.isLocked,
        participantCode: appState.participantCode,
        group: appState.group,
        registeredAt: appState.registeredAt,
        meals: appState.meals,
        savedCustomProducts: appState.savedCustomProducts,
        lastSyncAt: appState.sync.lastSyncAt
    }));
    if (!ok) {
        showToast(SafeStorage.available()
            ? 'אזהרה: זיכרון המכשיר מלא — הנתונים לא נשמרו במכשיר. פנו לצוות המחקר.'
            : 'אזהרה: הדפדפן חוסם שמירה מקומית (גלישה פרטית?). הנתונים יישמרו רק בענן.', 'error');
    }
}

function loadPersistedState() {
    const raw = SafeStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
        const p = JSON.parse(raw);
        appState.savedCustomProducts = Array.isArray(p.savedCustomProducts) ? p.savedCustomProducts : [];
        appState.sync.lastSyncAt = p.lastSyncAt || '';
        if (p.isLocked && p.participantCode) {
            appState.isLocked = true;
            appState.participantCode = p.participantCode;
            appState.group = p.group || 'CR';
            appState.registeredAt = p.registeredAt || '';
            appState.meals = Array.isArray(p.meals) ? p.meals : [];
        }
    } catch (e) { console.error('Corrupt local state', e); }
}

// =============================================================================
// 5. INSTALL TO HOME SCREEN
// =============================================================================
function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function isIOS() {
    return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isMobile() { return isIOS() || /Android/i.test(navigator.userAgent); }

function installInstructionsHtml() {
    if (isIOS()) {
        return 'בספארי: לחצו על כפתור השיתוף <b>⬆︎</b> (בגרסאות חדשות הוא בתפריט <b>☰</b> שליד כתובת האתר ← <b>"שיתוף"</b>), ' +
            'גללו או לחצו <b>"עוד"</b>, בחרו <b>"הוספה למסך הבית"</b> ואז <b>"הוסף"</b>. מעכשיו פתחו את היומן מהאייקון.';
    }
    if (deferredInstallPrompt) return 'לחצו על "התקנה" כדי להוסיף את היומן למסך הבית.';
    return 'בכרום: לחצו על התפריט <b>⋮</b> ובחרו <b>"הוספה למסך הבית"</b> או <b>"התקנת אפליקציה"</b>.';
}

function renderInstallHints() {
    const show = isMobile() && !isStandalone();
    const loginBox = $('install-hint-login');
    const main = $('install-hint-main');
    $('menu-install').classList.toggle('hidden', isStandalone());
    if (!show) { loginBox.classList.add('hidden'); main.classList.add('hidden'); return; }

    // An iPhone home-screen app keeps its own storage, separate from Safari — install before signing in.
    loginBox.innerHTML = '<b>מומלץ להתקין לפני הכניסה.</b> ' + installInstructionsHtml() +
        (deferredInstallPrompt ? '<div style="margin-top:8px;"><button type="button" class="btn primary sm" onclick="promptInstall()">התקנה</button></div>' : '');
    loginBox.classList.remove('hidden');

    let dismissed = false;
    try { dismissed = JSON.parse(SafeStorage.getItem(UI_KEY) || '{}').installDismissed; } catch (e) {}
    if (dismissed) { main.classList.add('hidden'); return; }
    main.innerHTML = '<img src="icons/icon-192.png" alt="">' +
        '<div style="flex:1;"><b class="ih-title">הוסיפו את היומן למסך הבית</b><span class="small muted">' + installInstructionsHtml() + '</span>' +
        '<div style="margin-top:8px; display:flex; gap:8px;">' +
        (deferredInstallPrompt ? '<button type="button" class="btn primary sm" onclick="promptInstall()">התקנה</button>' : '') +
        '<button type="button" class="btn sm" onclick="dismissInstallHint()">לא עכשיו</button></div></div>';
    main.classList.remove('hidden');
}

function promptInstall() {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.finally(function () { deferredInstallPrompt = null; renderInstallHints(); });
}

function dismissInstallHint() {
    SafeStorage.setItem(UI_KEY, JSON.stringify({ installDismissed: true }));
    $('install-hint-main').classList.add('hidden');
}

function showInstallHelp() {
    openInfoSheet('התקנה למסך הבית', '<p style="font-size:15px; line-height:1.6;">' + installInstructionsHtml() + '</p>' +
        (deferredInstallPrompt ? '<button type="button" class="btn primary block" onclick="promptInstall()">התקנה</button>' : ''));
}

// =============================================================================
// 6. REGISTRATION
// =============================================================================
async function handleRegistration() {
    const codeInput = $('participant-code-input');
    const errorBox = $('auth-error');
    const btn = $('enter-diary-btn');
    const code = codeInput.value.trim().toUpperCase();

    const showError = function (msg) {
        errorBox.textContent = msg;
        errorBox.classList.remove('hidden');
    };
    errorBox.classList.add('hidden');
    if (!code) { showError('נא להזין קוד נחקר.'); codeInput.focus(); return; }
    // Same rule as the server: letters, digits, - and _ only (no spaces or Hebrew).
    if (!/^[A-Z0-9_-]{2,40}$/.test(code)) {
        showError('קוד נחקר יכול להכיל רק אותיות באנגלית, ספרות, מקף או קו תחתון.');
        codeInput.focus();
        return;
    }
    const picked = document.querySelector('input[name="study-group"]:checked');
    if (!picked) { showError('נא לבחור קבוצת מחקר.'); return; }
    // Self-registration has no list to catch typos, so the participant confirms both values.
    if (!confirm('לאשר את הפרטים?\n\nקוד נחקר: ' + code + '\nקבוצת מחקר: ' + picked.value + '\n\nלא ניתן לשנות אותם אחרי הכניסה.')) return;

    let group = picked.value, restoredMeals = [];
    if (cloudEnabled()) {
        btn.disabled = true;
        btn.querySelector('span').textContent = 'מתחבר... בכניסה הראשונה זה עשוי לקחת עד חצי דקה';
        try {
            const res = await apiCall('register', { participantCode: code, group: picked.value, appVersion: APP_VERSION, userAgent: navigator.userAgent });
            if (!res.ok) {
                showError(res.error === 'inactive_code' ? 'קוד זה אינו פעיל. פנו לצוות המחקר.'
                    : res.error === 'bad_code_format' ? 'קוד נחקר לא תקין.'
                    : 'שגיאה: ' + (res.error || 'לא ידועה'));
                return;
            }
            group = res.group;   // an existing code keeps the group it was registered with
            restoredMeals = Array.isArray(res.meals) ? res.meals : [];
            if (!res.created && group !== picked.value) {
                alert('הקוד ' + code + ' כבר רשום בקבוצת ' + group + '. היומן ייפתח בקבוצה זו.\nאם זו טעות, פנו לצוות המחקר.');
            }
        } catch (err) {
            showError('אין חיבור לשרת המחקר. ודאו שיש אינטרנט ונסו שוב.');
            return;
        } finally {
            btn.disabled = false;
            btn.querySelector('span').textContent = 'כניסה ליומן';
        }
    }

    appState.participantCode = code;
    appState.group = group;
    appState.registeredAt = new Date().toISOString();
    appState.isLocked = true;
    // Never carry meals of another code into this diary (they would be refused by the server).
    appState.meals = appState.meals.filter(function (m) { return m.participantCode === code; });
    restoredMeals.forEach(function (m) {
        m.syncStatus = 'synced';
        if (!appState.meals.some(function (x) { return x.id === m.id; })) appState.meals.push(m);
    });
    savePersistedState();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
    enterLockedDiaryView();
    showToast(restoredMeals.length ? 'ברוכים הבאים! שוחזרו ' + restoredMeals.length + ' ארוחות מהענן.' : 'ברוכים הבאים ליומן האכילה', 'success');
}

function enterLockedDiaryView() {
    $('auth-view').classList.add('hidden');
    $('diary-view').classList.remove('hidden');
    // RT researcher view exists only when a PIN is configured; otherwise RT stays fully blinded.
    $('menu-researcher').classList.toggle('hidden', !(appState.group === 'RT' && CFG.RESEARCHER_PIN));
    renderDiary();
    renderSyncStatus();
}

// =============================================================================
// 7. TODAY SCREEN
// =============================================================================
function shiftWeek(dir) {
    const today = formatIsoDate(new Date());
    let target = addDays(appState.selectedDate, dir * 7);
    if (target > today) target = today;
    selectDay(target);
}

function selectDay(iso) {
    appState.userPickedDate = iso !== formatIsoDate(new Date());
    setSelectedDate(iso);
    renderDiary();
}

function renderWeek(userMeals) {
    const today = formatIsoDate(new Date());
    const start = addDays(appState.selectedDate, -parseIso(appState.selectedDate).getDay());
    const hasMeals = {};
    userMeals.forEach(function (m) { hasMeals[m.date] = true; });
    let html = '';
    for (let i = 0; i < 7; i++) {
        const iso = addDays(start, i);
        const cls = ['wd'];
        if (iso === appState.selectedDate) cls.push('on');
        if (iso === today) cls.push('today');
        if (hasMeals[iso]) cls.push('has');
        html += '<button type="button" class="' + cls.join(' ') + '"' + (iso > today ? ' disabled' : '') +
            ' onclick="selectDay(\'' + iso + '\')" aria-label="יום ' + HEBREW_DAYS[i] + ' ' + formatDisplayDate(iso) + '">' +
            HEBREW_DAY_LETTERS[i] + '<b>' + parseIso(iso).getDate() + '</b></button>';
    }
    $('week-strip').innerHTML = html;
    $('week-next').disabled = addDays(start, 7) > today;
}

function renderDiary() {
    const userMeals = visibleMeals();
    const today = formatIsoDate(new Date());
    const d = parseIso(appState.selectedDate);
    const prefix = appState.selectedDate === today ? 'היום · ' : (appState.selectedDate === addDays(today, -1) ? 'אתמול · ' : '');
    $('day-title').textContent = prefix + 'יום ' + appState.selectedDayName + ', ' + d.getDate() + ' ב' + d.toLocaleDateString('he-IL', { month: 'long' });
    $('identity-chip').innerHTML = '🔒 ' + ltr(appState.participantCode) + ' · קבוצת ' + ltr(appState.group);
    renderWeek(userMeals);

    const tre = evaluateMealsForDay(userMeals.filter(function (m) { return m.date === appState.selectedDate; }));
    const meals = tre.sorted;
    const s = sumNutrition(meals);
    const t = s.totals;
    const blind = isRtBlinded();

    $('day-sub').textContent = blind
        ? meals.length + ' ארוחות'
        : fmt0(t.cal) + ' קק״ל · ' + fmt1(t.pro) + ' ג׳ חלבון · ' + meals.length + ' ארוחות';
    $('meal-count').textContent = meals.length + ' ארוחות';

    const stats = $('stats-row');
    if (!blind) {
        stats.innerHTML = [['cal', 'קלוריות'], ['pro', 'חלבון ג׳'], ['carb', 'פחמ׳ ג׳'], ['fat', 'שומן ג׳']].map(function (p) {
            return '<div class="stat"><span class="v">' + (p[0] === 'cal' ? fmt0(t.cal) : fmt1(t[p[0]])) + '</span><span class="l">' + p[1] + '</span></div>';
        }).join('');
        stats.classList.remove('hidden');
    } else {
        stats.classList.add('hidden');
    }

    renderTreBanner(tre);
    renderTimeline(tre);

    const sum = $('full-summary');
    $('rt-blinded').classList.toggle('hidden', !blind);
    if (!blind && meals.length) {
        $('summary-grid').innerHTML = CORE_KEYS.map(function (k) {
            const v = (k === 'cal' || k === 'calc' || k === 'sod') ? fmt0(t[k]) : fmt1(t[k]);
            return '<div>' + NUT_SHORT[k] + '<b>' + v + (s.missing[k] ? '*' : '') + '</b>' + NUT_UNIT[k] + '</div>';
        }).join('');
        const miss = CORE_KEYS.filter(function (k) { return s.missing[k]; });
        $('summary-note').textContent = '* חסר נתון במאגר לחלק מהרכיבים (' + miss.map(function (k) { return NUT_SHORT[k]; }).join(', ') + ') — הסכום חלקי.';
        $('summary-note').classList.toggle('hidden', !miss.length);
        sum.classList.remove('hidden');
    } else {
        sum.classList.add('hidden');
    }
}

function renderTreBanner(tre) {
    const el = $('tre-banner');
    if (appState.group !== 'TRE') { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    if (!tre.firstTime) {
        el.className = 'tre-banner idle';
        el.innerHTML = '⏱ חלון האכילה (8 שעות) יתחיל בארוחה הראשונה של היום';
        return;
    }
    const range = ltr(tre.firstTime + '–' + tre.windowEnd);
    if (tre.hasViolation) {
        el.className = 'tre-banner bad';
        el.innerHTML = '⚠ ' + (tre.violationCount === 1 ? 'ארוחה אחת' : tre.violationCount + ' ארוחות') + ' מחוץ לחלון ' + range;
        return;
    }
    el.className = 'tre-banner ok';
    let extra = '';
    if (appState.selectedDate === formatIsoDate(new Date())) {
        const now = new Date();
        const left = timeToMinutes(tre.firstTime) + 480 - (now.getHours() * 60 + now.getMinutes());
        extra = left > 0 ? ' · נותרו ' + ltr(Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0')) + ' שעות' : ' · החלון נסגר להיום';
    }
    el.innerHTML = '⏱ חלון האכילה: ' + range + extra;
}

function renderTimeline(tre) {
    const meals = tre.sorted;
    const tl = $('timeline');
    $('empty-state').classList.toggle('hidden', meals.length > 0);
    if (!meals.length) { tl.innerHTML = ''; return; }

    const isTre = appState.group === 'TRE';
    const rows = [];
    if (isTre) rows.push({ marker: 'start', time: tre.firstTime });
    let endPlaced = false;
    meals.forEach(function (m) {
        if (isTre && !endPlaced && m.isOutsideTreWindow) { rows.push({ marker: 'end', time: tre.windowEnd }); endPlaced = true; }
        rows.push({ meal: m });
    });
    if (isTre && !endPlaced) rows.push({ marker: 'end', time: tre.windowEnd });

    const blind = isRtBlinded();
    let inWindow = isTre;
    tl.innerHTML = rows.map(function (r) {
        if (r.marker) {
            const html = '<div class="tl-row marker ' + (r.marker === 'end' ? 'end ' : '') + (inWindow ? 'in-window' : '') + '">' +
                '<div class="tl-time">' + ltr(r.time) + '</div><div class="tl-rail"><span class="tl-dot"></span></div>' +
                '<div class="tl-label">' + (r.marker === 'start' ? 'תחילת חלון האכילה' : 'סוף חלון 8 השעות') + '</div></div>';
            if (r.marker === 'end') inWindow = false;
            return html;
        }
        const m = r.meal;
        const bad = isTre && m.isOutsideTreWindow;
        const n = m.nutrition || {};
        const chips = [];
        if (bad) chips.push('<span class="chip danger sm">מחוץ לחלון</span>');
        if (!m.finished) chips.push('<span class="chip warn sm">נשאר ' + m.leftoverPct + '% בצלחת</span>');
        if (cloudEnabled() && m.syncStatus === 'pending') chips.push('<span class="chip muted sm">ממתין להעלאה</span>');
        if (cloudEnabled() && m.syncStatus === 'rejected') chips.push('<span class="chip danger sm">לא הועלה — פנו לצוות המחקר</span>');
        const items = (m.ingredients || []).map(function (i) { return shortName(i.name); }).join(' · ') || m.description;
        return '<div class="tl-row ' + (inWindow ? 'in-window ' : '') + (bad ? 'bad' : '') + '">' +
            '<div class="tl-time">' + ltr(m.time) + '</div><div class="tl-rail"><span class="tl-dot"></span></div>' +
            '<div class="tl-body"><button type="button" class="meal-card panel ' + (bad ? 'bad' : '') + '" onclick="openMealDetail(\'' + m.id + '\')">' +
                '<div class="main"><div class="top"><span class="type">' + escapeHtml(m.mealType) + '</span>' +
                    (blind ? '' : '<span class="kcal">' + fmt0(n.cal) + ' קק״ל</span>') + '</div>' +
                    '<div class="items">' + escapeHtml(items) + '</div>' +
                    (chips.length ? '<div class="chips">' + chips.join('') + '</div>' : '') +
                '</div>' +
                (m.photo ? '<img class="meal-thumb" src="' + m.photo + '" alt="">' : '') +
            '</button></div></div>';
    }).join('');
}

// "גבינת קוטג' 5% שומן, תנובה" → "גבינת קוטג' 5% שומן"
function shortName(name) { return String(name).split(',')[0]; }

function sumNutrition(meals) {
    const t = {}; NUT_KEYS.forEach(function (k) { t[k] = 0; });
    const missing = {};
    meals.forEach(function (m) {
        NUT_KEYS.forEach(function (k) { t[k] += (m.nutrition && m.nutrition[k]) || 0; });
        (m.missingNutrients || []).forEach(function (k) { missing[k] = true; });
    });
    return { totals: t, missing: missing };
}

// =============================================================================
// 8. MENU, INFO SHEETS, MEAL DETAIL
// =============================================================================
function toggleMenu(force) {
    const m = $('menu');
    const show = typeof force === 'boolean' ? force : m.classList.contains('hidden');
    m.classList.toggle('hidden', !show);
}

function openInfoSheet(title, bodyHtml, footHtml) {
    $('info-title').textContent = title;
    $('info-body').innerHTML = bodyHtml;
    $('info-foot').innerHTML = footHtml || '';
    $('info-foot').classList.toggle('hidden', !footHtml);
    const wasOpen = !$('info-sheet-root').classList.contains('hidden');
    $('info-sheet-root').classList.remove('hidden');
    $('info-body').scrollTop = 0;
    document.body.style.overflow = 'hidden';
    // Updating an open sheet adds no back-step; a sheet opened straight from the scanner takes over its step.
    if (!wasOpen) {
        if (history.state && history.state.sheet === 'scanner') history.replaceState({ sheet: 'info' }, '');
        else history.pushState({ sheet: 'info' }, '');
    }
}

function closeInfoSheet(fromPop) {
    if ($('info-sheet-root').classList.contains('hidden')) return;
    $('info-sheet-root').classList.add('hidden');
    if ($('meal-sheet-root').classList.contains('hidden')) document.body.style.overflow = '';
    if (!fromPop && history.state && history.state.sheet) programmaticBack();
}

function openMealDetail(mealId) {
    const m = appState.meals.find(function (x) { return x.id === mealId; });
    if (!m) return;
    const blind = isRtBlinded();
    const ings = (m.ingredients || []).map(function (i) {
        const qty = fmt1(i.quantity) + ' ' + i.unitName + (i.grams !== null && i.unitName !== 'גרם' ? ' (' + fmt0(i.grams) + ' ג׳)' : '');
        return '<div><div><div class="dn">' + escapeHtml(i.name) + '</div><div class="dq">' + escapeHtml(qty) + '</div></div>' +
            (blind ? '' : '<div class="dv">' + fmt0(i.net.cal) + ' קק״ל<br>' + fmt1(i.net.pro) + ' ג׳ חלבון</div>') + '</div>';
    }).join('');
    const body =
        (m.photo ? '<img class="detail-photo" src="' + m.photo + '" alt="תמונת הארוחה">' : '') +
        '<div><div class="kicker">התיאור שלך</div><div style="margin-top:4px;">' + escapeHtml(m.description) + '</div></div>' +
        '<div><div class="kicker">רכיבים</div><div class="detail-list">' + ings + '</div></div>' +
        (!m.finished ? '<div><span class="chip warn">נשאר ' + m.leftoverPct + '% בצלחת — חושב ' + (100 - m.leftoverPct) + '% שנאכל</span></div>' : '') +
        (blind ? '' : '<div class="totals">' + CORE_KEYS.map(function (k) {
            const v = m.nutrition ? m.nutrition[k] : null;
            return '<div>' + NUT_SHORT[k] + '<b>' + ((k === 'cal' || k === 'calc' || k === 'sod') ? fmt0(v) : fmt1(v)) + ((m.missingNutrients || []).indexOf(k) !== -1 ? '*' : '') + '</b></div>';
        }).join('') + '</div>') +
        '<div class="tiny muted">נרשם ב-' + escapeHtml(new Date(m.enteredAt).toLocaleString('he-IL')) +
            (cloudEnabled() ? ' · ' + (m.syncStatus === 'synced' ? 'נשמר בענן ✓' : m.syncStatus === 'rejected' ? 'לא הועלה (' + escapeHtml(m.syncError || '') + ')' : 'ממתין להעלאה') : '') + '</div>';
    openInfoSheet(m.mealType + ' · ' + m.time, body,
        '<button type="button" class="btn danger" style="flex:1;" onclick="deleteMeal(\'' + m.id + '\')">מחיקת הארוחה</button>' +
        '<button type="button" class="btn" style="flex:1;" onclick="closeInfoSheet()">סגירה</button>');
}

function showAbout() {
    const meta = FoodDB.meta || {};
    openInfoSheet('על היומן ומקור הנתונים',
        '<p style="line-height:1.6;">הערכים התזונתיים מחושבים לפי <b>מאגר צמרת</b> — מאגר הנתונים התזונתי הלאומי של משרד הבריאות' +
        (meta.dataLastUpdated ? ' (עדכון נתונים: ' + formatDisplayDate(meta.dataLastUpdated) + ')' : '') +
        '. מוצרים שהוזנו מתווית אריזה מחושבים לפי הערכים שהוקלדו. מוצרים ארוזים שנסרקו בברקוד מגיעים מ-<b>Open Food Facts</b>, ' +
        'ומשמשים רק אחרי אישור שהם תואמים לתווית.</p>' +
        '<div class="detail-list">' +
        '<div><span>קוד נחקר</span><span class="dv">' + ltr(appState.participantCode) + '</span></div>' +
        '<div><span>קבוצה</span><span class="dv">' + ltr(appState.group) + '</span></div>' +
        '<div><span>סנכרון אחרון</span><span class="dv">' + (appState.sync.lastSyncAt ? new Date(appState.sync.lastSyncAt).toLocaleString('he-IL') : '—') + '</span></div>' +
        '<div><span>ממתינות להעלאה</span><span class="dv">' + pendingCount() + '</span></div>' +
        (rejectedCount() ? '<div><span>לא הועלו (פנו לצוות)</span><span class="dv">' + rejectedCount() + '</span></div>' : '') +
        '<div><span>גרסה</span><span class="dv">' + APP_VERSION + '</span></div></div>' +
        '<p class="tiny muted">מעבדת גפנר · מדעי הבריאות והספורט · <a href="https://data.gov.il/dataset/nutrition-database" target="_blank" rel="noopener">data.gov.il</a></p>');
}

function renderSourceFooter() {
    const meta = FoodDB.meta;
    $('source-footer').innerHTML = 'ערכים תזונתיים: מאגר צמרת, משרד הבריאות' +
        (meta && meta.dataLastUpdated ? ' (' + formatDisplayDate(meta.dataLastUpdated) + ')' : '') + ' · גרסה ' + APP_VERSION;
}

// =============================================================================
// 9. ADD-MEAL SHEET (3 steps)
// =============================================================================
function defaultMealType(now) {
    const h = now.getHours();
    if (h < 11) return 'בוקר';
    if (h < 16) return 'צהריים';
    return 'ערב';
}

function openMealSheet() {
    const now = new Date();
    appState.step = 1;
    appState.draft = {
        type: defaultMealType(now),
        time: String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'),
        desc: ''
    };
    appState.activeIngredients = [];
    appState.scan = null;
    appState.leftoverPct = 25;
    clearSelectedPhoto();
    $('meal-time-input').value = appState.draft.time;
    $('meal-desc-input').value = '';
    $('food-search').value = '';
    $('search-results').innerHTML = '';
    $('search-hint').classList.remove('hidden');
    $('meal-date-label').textContent = '(יום ' + appState.selectedDayName + ' ' + formatDisplayDate(appState.selectedDate) + ')';
    switchSource('tz');
    renderTypeChips();
    setFinishedState(true);
    renderSheetStep();
    $('meal-sheet-root').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    history.pushState({ sheet: 'meal' }, '');
}

function draftHasContent() {
    return !!(appState.draft.desc.trim() || appState.activeIngredients.length || appState.currentPhotoDataUrl);
}

function closeMealSheet(fromPop) {
    if (draftHasContent() && !confirm('לבטל את הארוחה? מה שהוזן לא יישמר.')) {
        if (fromPop) history.pushState({ sheet: 'meal' }, '');
        return;
    }
    hideMealSheet(fromPop);
}

function hideMealSheet(fromPop) {
    $('meal-sheet-root').classList.add('hidden');
    document.body.style.overflow = '';
    if (!fromPop && history.state && history.state.sheet) programmaticBack();
}

function renderTypeChips() {
    document.querySelectorAll('#meal-type-chips button').forEach(function (b) {
        b.classList.toggle('on', b.dataset.type === appState.draft.type);
    });
}

function renderSheetStep() {
    const s = appState.step;
    [1, 2, 3].forEach(function (i) { $('step-' + i).classList.toggle('hidden', i !== s); });
    document.querySelectorAll('#steps .step').forEach(function (el) {
        const n = Number(el.dataset.step);
        el.className = 'step' + (n < s ? ' done' : n === s ? ' on' : '');
    });
    $('sheet-title').textContent = s === 1 ? 'ארוחה חדשה' : (appState.draft.type + ' · ' + appState.draft.time);
    $('sheet-back').textContent = s === 1 ? 'ביטול' : 'חזרה';
    renderNextLabel();
    if (s === 2) renderSelectedIngredients();
    if (s === 3) renderStep3();
    $('sheet-body').scrollTop = 0;
}

function renderNextLabel() {
    const s = appState.step, n = appState.activeIngredients.length;
    $('sheet-next').textContent = s === 3 ? 'שמירת הארוחה' : (s === 2 && n ? 'המשך (' + n + (n === 1 ? ' רכיב)' : ' רכיבים)') : 'המשך');
}

function sheetBack() {
    if (appState.step === 1) { closeMealSheet(); return; }
    appState.step--;
    renderSheetStep();
}

function sheetNext() {
    if (appState.step === 1) {
        appState.draft.time = $('meal-time-input').value;
        appState.draft.desc = $('meal-desc-input').value;
        if (!appState.draft.type) { showToast('בחרו סוג ארוחה', 'error'); return; }
        if (!appState.draft.time) { showToast('נא להזין שעת אכילה', 'error'); $('meal-time-input').focus(); return; }
        if (!appState.draft.desc.trim()) { showToast('נא לתאר במילים מה אכלת', 'error'); $('meal-desc-input').focus(); return; }
        if (appState.selectedDate === formatIsoDate(new Date())) {
            const now = new Date();
            if (timeToMinutes(appState.draft.time) > now.getHours() * 60 + now.getMinutes() + 10 &&
                !confirm('השעה שהוזנה (' + appState.draft.time + ') מאוחרת מהשעה הנוכחית. להמשיך?')) return;
        }
    } else if (appState.step === 2) {
        if (!appState.activeIngredients.length) { showToast('הוסיפו לפחות רכיב אחד מהמאגר או מתווית אריזה', 'error'); return; }
        if (appState.activeIngredients.some(function (i) { return i.kind === 'tz' && i.unitCode === null; })) {
            showToast('בחרו גודל מנה לכל רכיב', 'error');
            const el = document.querySelector('.ing.needs-unit');
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }
    } else {
        handleAddMeal();
        return;
    }
    appState.step++;
    renderSheetStep();
}

function switchSource(src) {
    document.querySelectorAll('#source-seg button').forEach(function (b) { b.classList.toggle('on', b.dataset.src === src); });
    $('src-tz').classList.toggle('hidden', src !== 'tz');
    $('src-label').classList.toggle('hidden', src !== 'label');
    if (src === 'label') renderSavedCustomProducts();
    else clearLabelBarcode();
}

// ---- Search
function renderSearchResults() {
    const q = $('food-search').value.trim();
    const box = $('search-results');
    $('search-hint').classList.toggle('hidden', !!q);
    if (!q || !FoodDB.loaded) { box.innerHTML = ''; return; }
    const blind = isRtBlinded();
    const qn = normalizeText(q);
    const saved = appState.savedCustomProducts.filter(function (cp) { return normalizeText(cp.name).indexOf(qn) !== -1; }).slice(0, 4);
    const digits = normalizeBarcode(q);
    if (/^\d{8,14}$/.test(q.replace(/[\s-]/g, '')) && isValidGtin(digits)) {   // a barcode number typed into search
        box.innerHTML = '<div class="results"><button type="button" class="result" onclick="lookupBarcode(\'' + digits + '\')">' +
            '<span class="rn"><b>חיפוש לפי ברקוד</b><span>' + ltr(digits) + '</span></span><span class="add">' + SCAN_ICON + '</span></button></div>';
        return;
    }
    const foods = searchFoods(q, 25);
    if (!saved.length && !foods.length) {
        box.innerHTML = '<div class="results"><div class="scan-cta">' +
            '<div class="results-empty">לא נמצא במאגר צמרת.<br>אם זה מוצר ארוז — סרקו את הברקוד שעל האריזה.</div>' +
            '<button type="button" class="scan-btn" onclick="openScanner()">' + SCAN_ICON + 'סריקת ברקוד</button>' +
            '<div class="or-line">אין ברקוד? <button type="button" class="link-btn" onclick="switchSource(\'label\')">הזנה ידנית מתווית האריזה</button></div>' +
            '</div></div>';
        return;
    }
    box.innerHTML = '<div class="results">' +
        saved.map(function (cp) {
            return '<button type="button" class="result" onclick="addSavedCustomToMeal(\'' + cp.id + '\')">' +
                '<span class="rn"><b>' + escapeHtml(cp.name) + '</b><span>מהמוצרים השמורים שלי</span></span><span class="add">+</span></button>';
        }).join('') +
        foods.map(function (f) {
            return '<button type="button" class="result" onclick="addTzameretIngredient(' + f.code + ')">' +
                '<span class="rn"><b>' + escapeHtml(f.name) + '</b>' +
                (blind ? '' : '<span>' + fmt0(f.n.cal) + ' קק״ל · ' + fmt1(f.n.pro) + ' ג׳ חלבון ל-100 ג׳</span>') +
                '</span><span class="add">+</span></button>';
        }).join('') + '</div>';
}

function afterIngredientAdded(name) {
    $('food-search').value = '';
    $('search-results').innerHTML = '';
    $('search-hint').classList.remove('hidden');
    $('food-search').blur();
    renderSelectedIngredients();
    renderNextLabel();
    $('sheet-body').scrollTop = 0;
    showToast('נוסף: ' + shortName(name), 'success');
}

function addTzameretIngredient(code) {
    const f = FoodDB.byCode[code];
    if (!f) return;
    // No default portion: the participant must pick one (Tzameret's first unit can be e.g. a whole loaf).
    appState.activeIngredients.push({ uid: newId('ing'), kind: 'tz', code: code, unitCode: f.units.length ? null : GRAM_UNIT, quantity: f.units.length ? 1 : 100 });
    afterIngredientAdded(f.name);
}

// ---- Selected ingredient cards
function renderSelectedIngredients() {
    const box = $('selected-ings');
    if (!appState.activeIngredients.length) {
        box.innerHTML = '<div class="tiny muted">חפשו כל רכיב בנפרד והוסיפו אותו. לכל רכיב אפשר לבחור מנה וכמות.</div>';
        return;
    }
    const blind = isRtBlinded();
    box.innerHTML = '<div class="kicker">רכיבי הארוחה</div>' + appState.activeIngredients.map(function (item) {
        const rec = computeIngredient(item);
        if (!rec) return '';
        const needsUnit = item.kind === 'tz' && item.unitCode === null;
        let portion = '';
        if (item.kind === 'tz') {
            const f = FoodDB.byCode[item.code];
            portion = (needsUnit ? '<div class="pick-unit">בחרו גודל מנה:</div>' : '') + '<div class="portion-chips">' + unitsForFood(f).map(function (u) {
                const label = u[0] === GRAM_UNIT ? 'גרם' : unitName(u[0]) + ' · ' + fmt0(u[1]) + ' ג׳';
                return '<button type="button" class="chip selectable' + (u[0] === item.unitCode ? ' on' : '') + '" onclick="updateIngredientUnit(\'' + item.uid + '\',' + u[0] + ')">' + escapeHtml(label) + '</button>';
            }).join('') + '</div>';
        }
        const qty = item.kind === 'label' ? item.amount : item.quantity;
        const unitLbl = item.kind === 'label' ? (item.basis === '100g' ? (item.unitLabel || 'גרם / מ"ל') : 'יחידות') : (item.unitCode === GRAM_UNIT ? 'גרם' : unitName(item.unitCode));
        const calc = (rec.grams !== null && unitLbl !== 'גרם' ? '= <b>' + fmt0(rec.grams) + ' ג׳</b>' : '') +
            (blind ? '' : (rec.grams !== null && unitLbl !== 'גרם' ? ' · ' : '') + '<b>' + fmt0(rec.values.cal) + '</b> קק״ל');
        const badge = item.kind === 'label' ? (item.badge || 'תווית') : 'צמרת';
        const large = rec.grams !== null && rec.grams > LARGE_PORTION_G
            ? '<div class="chip warn sm">כמות גדולה (' + fmt0(rec.grams) + ' ג׳) — בדקו שהמנה והכמות נכונות</div>' : '';
        return '<div class="ing panel' + (needsUnit ? ' needs-unit' : '') + '">' +
            '<div class="ing-top"><div class="ing-name"><span class="src' + (item.barcode ? ' off' : '') + '">' + escapeHtml(badge) + '</span>' + escapeHtml(rec.name) + '</div>' +
            '<button type="button" class="ing-x" aria-label="הסרה" onclick="removeIngredient(\'' + item.uid + '\')">✕</button></div>' +
            portion +
            (needsUnit ? '' : '<div class="ing-bottom"><div class="stepper">' +
                '<button type="button" aria-label="הוספה" onclick="updateIngredientQuantity(\'' + item.uid + '\', 1, false)">+</button>' +
                '<input type="number" inputmode="decimal" step="any" min="0.1" value="' + qty + '" aria-label="כמות" onchange="updateIngredientQuantity(\'' + item.uid + '\', this.value, true)">' +
                '<button type="button" aria-label="הפחתה" onclick="updateIngredientQuantity(\'' + item.uid + '\', -1, false)">−</button>' +
            '</div><span class="ing-calc">' + escapeHtml(unitLbl) + ' ' + calc + '</span></div>') +
            large +
        '</div>';
    }).join('');
}

function removeIngredient(uid) {
    appState.activeIngredients = appState.activeIngredients.filter(function (it) { return it.uid !== uid; });
    renderSelectedIngredients();
    renderNextLabel();
}

function updateIngredientQuantity(uid, deltaOrExact, isExact) {
    const item = appState.activeIngredients.find(function (i) { return i.uid === uid; });
    if (!item) return;
    const field = item.kind === 'label' ? 'amount' : 'quantity';
    const isGrams = item.kind === 'label' ? item.basis === '100g' && !(item.unitGrams > 1) : item.unitCode === GRAM_UNIT;
    const step = isGrams ? 10 : 0.5;
    if (isExact) {
        const parsed = parseFloat(deltaOrExact);
        item[field] = (!isNaN(parsed) && parsed > 0) ? parsed : step;
    } else {
        const next = Math.round((item[field] + deltaOrExact * step) * 100) / 100;
        item[field] = next > 0 ? next : step;
    }
    renderSelectedIngredients();
}

function updateIngredientUnit(uid, unitCode) {
    const item = appState.activeIngredients.find(function (i) { return i.uid === uid; });
    if (!item || item.kind !== 'tz') return;
    const first = item.unitCode === null;
    item.unitCode = Number(unitCode);
    if (first) item.quantity = item.unitCode === GRAM_UNIT ? 100 : 1;
    else if (item.unitCode === GRAM_UNIT && item.quantity < 10) item.quantity = 100;
    else if (item.unitCode !== GRAM_UNIT && item.quantity >= 20) item.quantity = 1;
    renderSelectedIngredients();
}

// ---- Package label
function updateLabelBasisLabels() {
    const basis = $('lbl-basis').value;
    $('lbl-eaten-label').textContent = basis === '100g' ? 'כמה נאכל בפועל (גרם / מ"ל)' : 'כמה יחידות / מנות נאכלו';
    $('lbl-eaten-amount').value = basis === '100g' ? '100' : '1';
}

function readOptionalNumber(id) {
    const raw = $(id).value.trim();
    if (raw === '') return null;
    const v = parseFloat(raw);
    return isNaN(v) ? null : v;
}

function handleAddCustomLabelProduct() {
    const name = $('lbl-name').value.trim();
    const basis = $('lbl-basis').value;
    const per = {
        cal: readOptionalNumber('lbl-cal'), pro: readOptionalNumber('lbl-pro'),
        carb: readOptionalNumber('lbl-carb'), fat: readOptionalNumber('lbl-fat'),
        calc: readOptionalNumber('lbl-calc'), sod: readOptionalNumber('lbl-sod')
    };
    const eaten = parseFloat($('lbl-eaten-amount').value);
    if (!name) { showToast('נא להזין שם מוצר', 'error'); $('lbl-name').focus(); return; }
    if (per.cal === null || per.pro === null || per.carb === null || per.fat === null) {
        showToast('נא להזין קלוריות, חלבון, פחמימות ושומן מהתווית', 'error');
        return;
    }
    if (isNaN(eaten) || eaten <= 0) { showToast('נא להזין כמות שנאכלה', 'error'); return; }

    const bc = appState.labelBarcode;   // set when the form was opened from a barcode scan
    const extra = bc ? { source: bc.source, barcode: bc.barcode, offPer100: bc.offPer100, offLastModified: bc.offLastModified } : { source: 'label' };
    if ($('lbl-save-personal').checked) {
        saveCustomProduct(Object.assign({ name: name, basis: basis, per: per }, extra));
    }
    appState.activeIngredients.push(Object.assign({ uid: newId('ing'), kind: 'label', name: name, basis: basis, per: per, amount: eaten, badge: bc ? 'ברקוד' : 'תווית' }, extra));
    ['lbl-name', 'lbl-cal', 'lbl-pro', 'lbl-carb', 'lbl-fat', 'lbl-calc', 'lbl-sod'].forEach(function (id) { $(id).value = ''; });
    $('lbl-eaten-amount').value = basis === '100g' ? '100' : '1';
    switchSource('tz');
    afterIngredientAdded(name);
}

// Saves to "My products". A product with a barcode replaces any earlier one with the same barcode or name.
function saveCustomProduct(p) {
    appState.savedCustomProducts = appState.savedCustomProducts.filter(function (x) {
        return normalizeText(x.name) !== normalizeText(p.name) && !(p.barcode && x.barcode === p.barcode);
    });
    const rec = { id: newId('cp'), name: p.name, basis: p.basis, per: p.per };
    ['source', 'barcode', 'offPer100', 'offLastModified', 'servingGrams', 'packageGrams', 'brand'].forEach(function (k) {
        if (p[k] !== undefined && p[k] !== null) rec[k] = p[k];
    });
    appState.savedCustomProducts.unshift(rec);
    savePersistedState();
    return rec;
}

function savedProductPer(cp) {
    return cp.per || { cal: cp.cal, pro: cp.pro, carb: cp.carb, fat: cp.fat, calc: cp.calc, sod: cp.sod };
}

function addSavedCustomToMeal(customId) {
    const cp = appState.savedCustomProducts.find(function (p) { return p.id === customId; });
    if (!cp) return;
    const item = {
        uid: newId('ing'), kind: 'label', name: cp.name, basis: cp.basis, per: savedProductPer(cp),
        amount: cp.basis === '100g' ? 100 : 1, badge: cp.barcode ? 'ברקוד' : 'שמור',
        source: cp.source || 'label', barcode: cp.barcode || null,
        offPer100: cp.offPer100 || null, offLastModified: cp.offLastModified || null
    };
    if (cp.basis === '100g' && cp.servingGrams > 1) {   // scanned product: count in servings
        item.amount = 1;
        item.unitGrams = cp.servingGrams;
        item.unitLabel = portionLabel({ label: 'מנה', grams: cp.servingGrams });
    }
    appState.activeIngredients.push(item);
    switchSource('tz');
    afterIngredientAdded(cp.name);
}

function renderSavedCustomProducts() {
    const items = appState.savedCustomProducts || [];
    $('saved-custom-wrapper').classList.toggle('hidden', !items.length);
    $('saved-custom-list').innerHTML = items.map(function (cp) {
        return '<button type="button" class="chip accent" onclick="addSavedCustomToMeal(\'' + cp.id + '\')">+ ' + escapeHtml(cp.name) + '</button>';
    }).join('');
}

// =============================================================================
// 9b. BARCODE SCAN → Open Food Facts (packaged products that are not in Tzameret)
// =============================================================================
// Values from Open Food Facts are crowd-sourced, so they are only used after the
// participant confirms they match the label in their hand; otherwise the label
// form opens pre-filled for correction. Every item keeps its barcode, its source
// and the values as fetched, so the research team can audit it later.
const OFF_PRODUCT_URL = 'https://world.openfoodfacts.org/api/v2/product/';
const OFF_FIELDS = 'code,product_name,product_name_he,brands,quantity,product_quantity,serving_quantity,image_front_small_url,last_modified_t,nutriments';
const OFF_TIMEOUT_MS = 12000;
const ZXING_SRC = 'vendor/zxing-library-0.21.3.min.js';
const SCAN_INTERVAL_MS = 180;
const SOURCE_LABELS = {
    tzameret: 'צמרת',
    label: 'תווית אריזה',
    openfoodfacts: 'ברקוד — Open Food Facts (אושר מול התווית)',
    openfoodfacts_corrected: 'ברקוד — ערכים תוקנו/הושלמו לפי התווית'
};
const SCAN_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
    '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8v8M10 8v8M13 8v8M16 8v8"/></svg>';
// Open Food Facts field per 100 g → our key, with the factor to our unit (OFF stores minerals in grams).
const OFF_NUTRIENTS = {
    pro: ['proteins_100g', 1], carb: ['carbohydrates_100g', 1], fat: ['fat_100g', 1],
    calc: ['calcium_100g', 1000], sod: ['sodium_100g', 1000], fiber: ['fiber_100g', 1], sugar: ['sugars_100g', 1],
    satfat: ['saturated-fat_100g', 1], iron: ['iron_100g', 1000], chol: ['cholesterol_100g', 1000]
};
const BARCODE_NOTES = {
    not_found: 'המוצר עדיין לא קיים במאגר הברקודים. הקלידו את הערכים מהתווית — זה לוקח פחות מדקה.',
    incomplete: 'המוצר נמצא, אבל חלק מהערכים חסרים או לא סבירים. השלימו ובדקו אותם מול התווית.',
    corrected: 'תקנו את הערכים כך שיהיו זהים לתווית שעל האריזה.',
    offline: 'אין חיבור לאינטרנט, לכן אי אפשר לחפש את הברקוד. הקלידו את הערכים מהתווית — הברקוד יישמר.',
    error: 'מאגר הברקודים לא זמין כרגע. הקלידו את הערכים מהתווית — הברקוד יישמר.'
};

function normalizeBarcode(raw) { return String(raw === null || raw === undefined ? '' : raw).replace(/\D/g, ''); }

// GTIN-8/12/13/14 check digit (EAN / UPC).
function isValidGtin(code) {
    if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(code)) return false;
    const d = code.split('').map(Number);
    const check = d.pop();
    let sum = 0;
    d.reverse().forEach(function (x, i) { sum += x * (i % 2 === 0 ? 3 : 1); });
    return (10 - (sum % 10)) % 10 === check;
}

function offNumber(v) {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return typeof n === 'number' && isFinite(n) && n >= 0 ? n : null;
}

// Pure: Open Food Facts API response → product (values per 100 g in our units), or null.
function parseOffProduct(json, code) {
    if (!json || json.status !== 1 || !json.product) return null;
    const p = json.product, n = p.nutriments || {};
    const per = {};
    let kcal = offNumber(n['energy-kcal_100g']);
    if (kcal === null) { const kj = offNumber(n['energy-kj_100g']); if (kj !== null) kcal = kj / 4.184; }
    per.cal = round2(kcal);
    Object.keys(OFF_NUTRIENTS).forEach(function (k) {
        const v = offNumber(n[OFF_NUTRIENTS[k][0]]);
        per[k] = v === null ? null : round2(v * OFF_NUTRIENTS[k][1]);
    });
    const grams = function (v) { const x = offNumber(v); return x && x > 0 && x <= 5000 ? round2(x) : null; };
    // Prefer the short product name when it is already Hebrew (product_name_he is sometimes a long description).
    const main = String(p.product_name || '').trim(), he = String(p.product_name_he || '').trim();
    const name = /[\u0590-\u05FF]/.test(main) ? main : (he || main);
    const hasCore = ['cal', 'pro', 'carb', 'fat'].every(function (k) { return per[k] !== null; });
    return {
        barcode: code,
        name: name,
        brand: String(p.brands || '').split(',')[0].trim(),
        quantityText: String(p.quantity || '').trim(),
        packageGrams: grams(p.product_quantity),
        servingGrams: grams(p.serving_quantity),
        image: /^https:\/\//.test(p.image_front_small_url || '') ? p.image_front_small_url : '',
        lastModified: p.last_modified_t ? new Date(p.last_modified_t * 1000).toISOString() : null,
        per: per,
        complete: !!name && hasCore && offValuesPlausible(per)
    };
}

// Catches gross data-entry errors (kJ typed as kcal, values per package instead of per 100 g).
// Generous on purpose: fibre, polyols and alcohol make real labels differ from 4/4/9.
function offValuesPlausible(per) {
    if (per.cal > 950 || per.pro + per.carb + per.fat > 105) return false;
    const atwater = 4 * per.pro + 4 * per.carb + 9 * per.fat;
    return Math.abs(atwater - per.cal) <= 50 + 0.3 * Math.max(per.cal, atwater);
}

async function fetchOffProduct(code) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, OFF_TIMEOUT_MS) : null;
    try {
        const resp = await fetch(OFF_PRODUCT_URL + encodeURIComponent(code) + '.json?fields=' + OFF_FIELDS,
            { signal: ctrl ? ctrl.signal : undefined, headers: { Accept: 'application/json' } });
        if (resp.status === 404) return { status: 'not_found' };
        if (!resp.ok) return { status: 'error' };
        const product = parseOffProduct(await resp.json(), code);
        return product ? { status: 'found', product: product } : { status: 'not_found' };
    } catch (e) {
        return { status: 'error' };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// The scanner's history entry is handed to the next sheet, or released when nothing opens.
function releaseScannerHistory() {
    if (history.state && history.state.sheet === 'scanner') programmaticBack();
}

let lookupSeq = 0;
async function lookupBarcode(rawCode) {
    const code = normalizeBarcode(rawCode);
    if (!code) { releaseScannerHistory(); return; }
    const saved = appState.savedCustomProducts.find(function (p) { return p.barcode === code; });
    if (saved) {   // scanned before: instant, works offline
        closeInfoSheet();
        releaseScannerHistory();
        addSavedCustomToMeal(saved.id);
        return;
    }
    if (navigator.onLine === false) { openLabelFormForBarcode(code, null, 'offline'); return; }
    const seq = ++lookupSeq;
    openInfoSheet('מחפש את המוצר…', '<div class="scan-loading"><span class="spinner" aria-hidden="true"></span>בודק את הברקוד ' + ltr(code) + ' במאגר המוצרים…</div>');
    const res = await fetchOffProduct(code);
    if (seq !== lookupSeq || $('info-sheet-root').classList.contains('hidden')) return;   // participant cancelled
    if (res.status === 'found' && res.product.complete) showBarcodeFound(res.product);
    else if (res.status === 'found') openLabelFormForBarcode(code, res.product, 'incomplete');
    else openLabelFormForBarcode(code, null, res.status === 'error' ? 'error' : 'not_found');
}

function barcodePortions(p) {
    const list = [];
    if (p.servingGrams) list.push({ key: 'serving', label: 'מנה', grams: p.servingGrams });
    if (p.packageGrams && p.packageGrams <= 1000 && p.packageGrams !== p.servingGrams) list.push({ key: 'package', label: 'אריזה שלמה', grams: p.packageGrams });
    list.push({ key: 'grams', label: 'גרם / מ"ל', grams: 1 });
    return list;
}

function portionLabel(portion) { return portion.grams === 1 ? portion.label : portion.label + ' (' + fmt0(portion.grams) + ' ג׳)'; }

function showBarcodeFound(p) {
    const portions = barcodePortions(p);
    // Default: one serving; a whole package only if it is small; otherwise grams.
    let def = portions[0];
    if (def.key === 'package' && def.grams > 250) def = portions[portions.length - 1];
    appState.scan = { product: p, confirmed: null, portion: def, qty: def.grams === 1 ? 100 : 1 };
    renderBarcodeFound();
}

function renderBarcodeFound() {
    const s = appState.scan;
    if (!s) return;
    const p = s.product;
    const grams = s.qty * s.portion.grams;
    const cell = function (k) {
        const v = p.per[k];
        const shown = v === null ? 'לא צוין' : (k === 'cal' || k === 'calc' || k === 'sod') ? fmt0(v) : fmt1(v);
        return '<div' + (v === null ? ' class="na"' : '') + '><b>' + shown + '</b>' + NUT_SHORT[k] + (k === 'cal' ? '' : ' (' + NUT_UNIT[k] + ')') + '</div>';
    };
    const meta = [p.brand, p.quantityText].filter(Boolean).map(escapeHtml).join(' · ');
    const kcal = p.per.cal === null ? null : p.per.cal * grams / 100;
    const pro = p.per.pro === null ? null : p.per.pro * grams / 100;
    const body =
        '<div class="found panel">' +
            '<div class="found-head">' +
                (p.image ? '<img class="found-img" src="' + escapeHtml(p.image) + '" alt="" referrerpolicy="no-referrer" onerror="this.removeAttribute(\'src\')">' : '<div class="found-img ph" aria-hidden="true">' + SCAN_ICON + '</div>') +
                '<div style="min-width:0;"><div class="found-name">' + escapeHtml(p.name) + '</div>' +
                '<div class="found-meta">' + (meta ? meta + ' · ' : '') + '<span class="barcode-pill">' + escapeHtml(p.barcode) + '</span></div></div>' +
            '</div>' +
            '<div class="kicker">ערכים תזונתיים ל-100 גרם / 100 מ"ל</div>' +
            '<div class="ntable">' + CORE_KEYS.map(cell).join('') + '</div>' +
            '<div class="tiny muted">מקור: Open Food Facts' + (p.lastModified ? ' · עודכן ' + formatDisplayDate(p.lastModified.slice(0, 10)) : '') + '</div>' +
        '</div>' +
        '<div><div class="q">האם הערכים זהים לתווית שעל האריזה?</div>' +
            '<div class="yesno" style="margin-top:8px;">' +
                '<button type="button" id="scan-yes" class="' + (s.confirmed === true ? 'on-yes' : '') + '" onclick="answerBarcodeMatch(true)">כן, זהים</button>' +
                '<button type="button" id="scan-no" onclick="answerBarcodeMatch(false)">לא — אתקן</button>' +
            '</div></div>' +
        '<div><span class="field-label">כמה אכלת?</span>' +
            '<div class="portion-chips">' + barcodePortions(p).map(function (po) {
                return '<button type="button" class="chip selectable' + (po.key === s.portion.key ? ' on' : '') + '" onclick="setScanPortion(\'' + po.key + '\')">' + escapeHtml(portionLabel(po)) + '</button>';
            }).join('') + '</div>' +
            '<div class="ing-bottom" style="margin-top:10px;"><div class="stepper">' +
                '<button type="button" aria-label="הוספה" onclick="setScanQty(1, false)">+</button>' +
                '<input type="number" id="scan-qty" inputmode="decimal" step="any" min="0.1" value="' + s.qty + '" aria-label="כמות" onchange="setScanQty(this.value, true)">' +
                '<button type="button" aria-label="הפחתה" onclick="setScanQty(-1, false)">−</button>' +
            '</div><span class="ing-calc">' + (s.portion.grams === 1 ? 'גרם' : '= <b>' + fmt0(grams) + ' ג׳</b> ·') + ' <b>' + fmt0(kcal) + '</b> קק״ל · ' + fmt1(pro) + ' ג׳ חלבון</span></div>' +
        '</div>';
    const foot = '<button type="button" class="btn" style="flex:1;" onclick="closeInfoSheet()">ביטול</button>' +
        '<button type="button" class="btn primary" style="flex:2;" id="scan-add" onclick="addScannedProduct()"' + (s.confirmed === true ? '' : ' aria-disabled="true"') + '>הוספה לארוחה</button>';
    const keep = $('info-sheet-root').classList.contains('hidden') ? 0 : $('info-body').scrollTop;
    openInfoSheet('המוצר נמצא', body, foot);
    $('info-body').scrollTop = keep;
}

function answerBarcodeMatch(yes) {
    const s = appState.scan;
    if (!s) return;
    if (yes) { s.confirmed = true; renderBarcodeFound(); return; }
    openLabelFormForBarcode(s.product.barcode, s.product, 'corrected');
}

function setScanPortion(key) {
    const s = appState.scan;
    if (!s) return;
    const po = barcodePortions(s.product).find(function (x) { return x.key === key; });
    if (!po || po.key === s.portion.key) return;
    s.portion = po;
    s.qty = po.grams === 1 ? 100 : 1;
    renderBarcodeFound();
}

function setScanQty(deltaOrExact, isExact) {
    const s = appState.scan;
    if (!s) return;
    const step = s.portion.grams === 1 ? 10 : 0.5;
    if (isExact) {
        const v = parseFloat(deltaOrExact);
        s.qty = !isNaN(v) && v > 0 ? v : step;
    } else {
        const next = Math.round((s.qty + deltaOrExact * step) * 100) / 100;
        s.qty = next > 0 ? next : step;
    }
    renderBarcodeFound();
}

function addScannedProduct() {
    const s = appState.scan;
    if (!s) return;
    if (s.confirmed !== true) { showToast('ענו קודם: האם הערכים זהים לתווית?', 'error'); return; }
    const p = s.product;
    const per = Object.assign({}, p.per);
    const item = {
        uid: newId('ing'), kind: 'label', name: p.name, basis: '100g', per: per, amount: s.qty, badge: 'ברקוד',
        source: 'openfoodfacts', barcode: p.barcode, offPer100: Object.assign({}, p.per), offLastModified: p.lastModified
    };
    if (s.portion.grams > 1) { item.unitGrams = s.portion.grams; item.unitLabel = portionLabel(s.portion); }
    saveCustomProduct({
        name: p.name, basis: '100g', per: per, source: 'openfoodfacts', barcode: p.barcode, offPer100: item.offPer100,
        offLastModified: p.lastModified, servingGrams: p.servingGrams, packageGrams: p.packageGrams, brand: p.brand
    });
    appState.activeIngredients.push(item);
    appState.scan = null;
    closeInfoSheet();
    switchSource('tz');
    afterIngredientAdded(p.name);
}

// Opens the existing label form with the barcode attached (and Open Food Facts values, if any, to check).
function openLabelFormForBarcode(code, product, reason) {
    closeInfoSheet();
    releaseScannerHistory();
    appState.scan = null;
    switchSource('label');
    appState.labelBarcode = {
        barcode: code,
        source: product ? 'openfoodfacts_corrected' : 'label',
        offPer100: product ? Object.assign({}, product.per) : null,
        offLastModified: product ? product.lastModified : null
    };
    $('lbl-barcode-wrap').classList.remove('hidden');
    $('lbl-scan-btn').classList.add('hidden');
    $('lbl-barcode').value = code;
    $('lbl-barcode-note').textContent = BARCODE_NOTES[reason] || BARCODE_NOTES.not_found;
    $('lbl-basis').value = '100g';
    updateLabelBasisLabels();
    $('lbl-name').value = product ? product.name : '';
    const ids = { cal: 'lbl-cal', pro: 'lbl-pro', carb: 'lbl-carb', fat: 'lbl-fat', calc: 'lbl-calc', sod: 'lbl-sod' };
    Object.keys(ids).forEach(function (k) {
        $(ids[k]).value = product && product.per[k] !== null && product.per[k] !== undefined ? String(product.per[k]) : '';
    });
    if (product && product.servingGrams) $('lbl-eaten-amount').value = String(product.servingGrams);
    $('lbl-save-personal').checked = true;
    $('src-label').scrollIntoView({ block: 'start' });
}

function clearLabelBarcode() {
    appState.labelBarcode = null;
    $('lbl-barcode-wrap').classList.add('hidden');
    $('lbl-scan-btn').classList.remove('hidden');
    $('lbl-barcode').value = '';
}

function openManualBarcode() {
    openInfoSheet('הקלדת מספר הברקוד',
        '<p class="small muted">המספר מופיע מתחת לפסים של הברקוד — בדרך כלל 13 ספרות (במוצרים ישראליים מתחיל ב-729).</p>' +
        '<input id="manual-barcode" class="input barcode-input" type="text" inputmode="numeric" autocomplete="off" maxlength="18" placeholder="7290000000000" aria-label="מספר הברקוד" onkeydown="if(event.key===\'Enter\')submitManualBarcode()" oninput="$(\'manual-barcode-err\').classList.add(\'hidden\')">' +
        '<div id="manual-barcode-err" class="error-box hidden" style="margin:0;"></div>',
        '<button type="button" class="btn" style="flex:1;" onclick="closeInfoSheet()">ביטול</button>' +
        '<button type="button" class="btn primary" style="flex:2;" onclick="submitManualBarcode()">חיפוש המוצר</button>');
}

function submitManualBarcode() {
    const code = normalizeBarcode($('manual-barcode').value);
    if (!isValidGtin(code)) {
        $('manual-barcode-err').textContent = code.length < 8
            ? 'המספר קצר מדי — בדקו שהקלדתם את כל הספרות שמתחת לברקוד.'
            : 'מספר הברקוד לא תקין — בדקו את הספרות שוב.';
        $('manual-barcode-err').classList.remove('hidden');
        return;
    }
    lookupBarcode(code);
}

// ---- Camera scanner. Android Chrome has a built-in barcode reader; iPhone Safari does
// not, so there the bundled open-source ZXing library (Apache-2.0) is loaded on first use.
const scanner = { running: false, stream: null, timer: null, detector: null, zxing: null, canvas: null, last: '' };
let zxingLoad = null;

function loadZxing() {
    if (window.ZXing) return Promise.resolve(window.ZXing);
    if (!zxingLoad) {
        zxingLoad = new Promise(function (resolve, reject) {
            const s = document.createElement('script');
            s.src = ZXING_SRC;
            s.async = true;
            s.onload = function () { if (window.ZXing) resolve(window.ZXing); else reject(new Error('ZXing missing')); };
            s.onerror = function () { zxingLoad = null; reject(new Error('ZXing failed to load')); };
            document.head.appendChild(s);
        });
    }
    return zxingLoad;
}

async function prepareDecoder() {
    if (scanner.detector || scanner.zxing) return;
    if ('BarcodeDetector' in window) {
        try {
            const supported = await window.BarcodeDetector.getSupportedFormats();
            if (supported.indexOf('ean_13') !== -1) {
                scanner.detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'].filter(function (f) { return supported.indexOf(f) !== -1; }) });
                return;
            }
        } catch (e) { /* fall back to ZXing */ }
    }
    const Z = await loadZxing();
    const hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    const reader = new Z.MultiFormatReader();
    reader.setHints(hints);
    scanner.zxing = { Z: Z, reader: reader };
    scanner.canvas = document.createElement('canvas');
}

async function openScanner() {
    const md = navigator.mediaDevices;
    if (!md || typeof md.getUserMedia !== 'function') {
        showToast('המצלמה לא זמינה כאן — אפשר להקליד את מספר הברקוד', 'error');
        openManualBarcode();
        return;
    }
    $('food-search').blur();
    scanner.running = true;
    scanner.last = '';
    $('scan-hint').textContent = 'פותח את המצלמה…';
    $('scanner-root').classList.remove('hidden');
    history.pushState({ sheet: 'scanner' }, '');
    try {
        const decoderReady = prepareDecoder();   // loads while the participant answers the camera prompt
        decoderReady.catch(function () { /* reported below if the camera opens */ });
        const stream = await md.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
        if (!scanner.running) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
        scanner.stream = stream;
        const v = $('scan-video');
        v.muted = true;
        v.setAttribute('playsinline', '');
        v.srcObject = stream;
        await v.play();
        await decoderReady;
        if (!scanner.running) return;
        $('scan-hint').textContent = 'כוונו את הברקוד לתוך המסגרת';
        scanTick();
    } catch (err) {
        console.warn('Scanner failed', err);
        if (!scanner.running) return;
        const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
        closeScanner(false, true);
        showToast(denied ? 'אין הרשאה למצלמה. אפשר לאשר אותה בהגדרות הטלפון, או להקליד את מספר הברקוד.'
            : 'לא הצלחנו לפתוח את המצלמה. אפשר להקליד את מספר הברקוד.', 'error');
        openManualBarcode();
    }
}

async function scanTick() {
    if (!scanner.running) return;
    const v = $('scan-video');
    let code = '';
    try {
        if (v.readyState >= 2 && v.videoWidth) {
            if (scanner.detector) {
                const found = await scanner.detector.detect(v);
                if (found && found.length) code = found[0].rawValue;
            } else if (scanner.zxing) {
                code = decodeFrameZxing(v);
            }
        }
    } catch (e) { /* nothing readable in this frame */ }
    if (!scanner.running) return;
    code = normalizeBarcode(code);
    if (/^\d{8,14}$/.test(code)) {
        if (code === scanner.last) { onBarcodeDetected(code); return; }   // same code in two frames in a row
        scanner.last = code;
    }
    scanner.timer = setTimeout(scanTick, SCAN_INTERVAL_MS);
}

function decodeFrameZxing(v) {
    const Z = scanner.zxing.Z, c = scanner.canvas;
    // Read the middle band of the picture (where the on-screen frame is), scaled down for speed.
    const sw = Math.round(v.videoWidth * 0.86), sh = Math.round(v.videoHeight * 0.5);
    const sx = Math.round((v.videoWidth - sw) / 2), sy = Math.round((v.videoHeight - sh) / 2);
    const scale = Math.min(1, 900 / sw);
    c.width = Math.round(sw * scale);
    c.height = Math.round(sh * scale);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, sx, sy, sw, sh, 0, 0, c.width, c.height);
    try {
        const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(c)));
        return scanner.zxing.reader.decodeWithState(bmp).getText();
    } catch (e) {
        return '';
    }
}

function onBarcodeDetected(code) {
    try { if (navigator.vibrate) navigator.vibrate(40); } catch (e) { /* not supported */ }
    closeScanner(false, true);
    lookupBarcode(code);
}

function scannerManualEntry() {
    closeScanner(false, true);
    openManualBarcode();
}

// handoff: keep the history entry for the sheet that opens next (it replaces it).
function closeScanner(fromPop, handoff) {
    scanner.running = false;
    clearTimeout(scanner.timer);
    if (scanner.stream) { scanner.stream.getTracks().forEach(function (t) { t.stop(); }); scanner.stream = null; }
    const v = $('scan-video');
    try { v.pause(); } catch (e) { /* not playing */ }
    v.srcObject = null;
    if ($('scanner-root').classList.contains('hidden')) return;
    $('scanner-root').classList.add('hidden');
    if (!fromPop && !handoff) releaseScannerHistory();
}

// ---- Step 3
function setFinishedState(isFinished) {
    appState.finishedFood = isFinished;
    $('btn-finished-yes').className = isFinished ? 'on-yes' : '';
    $('btn-finished-no').className = isFinished ? '' : 'on-no';
    $('leftovers-section').classList.toggle('hidden', isFinished);
    setLeftoverPct(appState.leftoverPct);
}

function setLeftoverPct(pct) {
    let v = parseInt(pct, 10);
    if (isNaN(v)) return;
    v = Math.max(1, Math.min(95, v));
    appState.leftoverPct = v;
    $('leftover-slider').value = v;
    $('consumed-pct-label').textContent = 'כמה נשאר בצלחת? ' + v + '% (יחושב ' + (100 - v) + '% שנאכל)';
    if (appState.step === 3) renderStep3();
}

function consumedRatio() { return appState.finishedFood ? 1 : (100 - (appState.leftoverPct || 0)) / 100; }

function renderStep3() {
    const ratio = consumedRatio();
    const tot = {}; CORE_KEYS.forEach(function (k) { tot[k] = 0; });
    const missing = {};
    const lines = [];
    appState.activeIngredients.forEach(function (item) {
        const rec = computeIngredient(item);
        if (!rec) return;
        CORE_KEYS.forEach(function (k) { if (rec.values[k] !== null) tot[k] += rec.values[k] * ratio; });
        rec.missing.forEach(function (k) { missing[k] = true; });
        lines.push('<div><div><div class="dn">' + escapeHtml(shortName(rec.name)) + '</div><div class="dq">' +
            escapeHtml(fmt1(rec.quantity) + ' ' + rec.unitName + (rec.grams !== null && rec.unitName !== 'גרם' ? ' (' + fmt0(rec.grams) + ' ג׳)' : '')) + '</div></div></div>');
    });
    const blind = isRtBlinded();
    $('meal-totals-wrap').classList.toggle('hidden', blind);
    $('meal-totals').innerHTML = CORE_KEYS.map(function (k) {
        return '<div>' + NUT_SHORT[k] + '<b>' + ((k === 'cal' || k === 'calc' || k === 'sod') ? fmt0(tot[k]) : fmt1(tot[k])) + (missing[k] ? '*' : '') + '</b></div>';
    }).join('');
    const miss = Object.keys(missing);
    $('meal-missing-note').textContent = '* חסר נתון במאגר לחלק מהרכיבים (' + miss.map(function (k) { return NUT_SHORT[k]; }).join(', ') + ') — הסכום חלקי.';
    $('meal-missing-note').classList.toggle('hidden', !miss.length);
    $('meal-review').innerHTML = '<div class="kicker">בדיקה אחרונה</div><div style="margin:4px 0 6px;">' + escapeHtml(appState.draft.desc) + '</div><div class="detail-list">' + lines.join('') + '</div>';
}

function resizeImage(dataUrl, maxDim, quality) {
    return new Promise(function (resolve, reject) {
        const img = new Image();
        img.onload = function () {
            const r = Math.min(1, maxDim / Math.max(img.width, img.height));
            const c = document.createElement('canvas');
            c.width = Math.round(img.width * r);
            c.height = Math.round(img.height * r);
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            resolve(c.toDataURL('image/jpeg', quality));
        };
        img.onerror = reject;
        img.src = dataUrl;
    });
}

function handlePhotoSelect(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (ev) {
        resizeImage(ev.target.result, 1280, 0.8).then(function (url) {
            appState.currentPhotoDataUrl = url;
            $('photo-preview-img').src = url;
            $('photo-preview-box').classList.remove('hidden');
            $('photo-upload-text').textContent = 'החלפת תמונה';
        }).catch(function () { showToast('לא ניתן לקרוא את התמונה', 'error'); });
    };
    reader.readAsDataURL(file);
}

function clearSelectedPhoto() {
    appState.currentPhotoDataUrl = null;
    $('meal-photo-input').value = '';
    $('photo-preview-box').classList.add('hidden');
    $('photo-upload-text').textContent = 'צילום או בחירת תמונה';
}

// =============================================================================
// 10. NUTRITION COMPUTATION
// =============================================================================
function computeIngredient(item) {
    if (item.kind === 'label') {
        // Per-100g products may be counted in portions (e.g. 1 bar = 40 g): unitGrams > 1.
        const per100 = item.basis === '100g';
        const unitG = per100 ? (item.unitGrams > 0 ? item.unitGrams : 1) : null;
        const grams = per100 ? item.amount * unitG : null;
        const ratio = per100 ? grams / 100 : item.amount;
        const values = {}, missing = [];
        NUT_KEYS.forEach(function (k) {
            const v = item.per[k];
            if (v === null || v === undefined) { values[k] = null; if (CORE_KEYS.indexOf(k) !== -1) missing.push(k); }
            else values[k] = v * ratio;
        });
        return {
            source: item.source || 'label', code: null, sml: null, name: item.name,
            unitName: per100 ? (item.unitLabel || 'גרם/מ"ל') : 'יחידה/מנה (לפי התווית)',
            unitGrams: unitG, quantity: item.amount, grams: grams,
            labelBasis: item.basis, labelValues: item.per,
            barcode: item.barcode || null, offPer100: item.offPer100 || null, offLastModified: item.offLastModified || null,
            values: values, missing: missing
        };
    }
    const f = FoodDB.byCode[item.code];
    if (!f) return null;
    if (item.unitCode === null) {   // portion not chosen yet
        const blank = {}; NUT_KEYS.forEach(function (k) { blank[k] = null; });
        return { source: 'tzameret', code: f.code, sml: f.sml, name: f.name, unitName: '', unitGrams: null, quantity: item.quantity, grams: null, per100: f.n, values: blank, missing: [] };
    }
    const unit = unitsForFood(f).find(function (u) { return u[0] === item.unitCode; }) || [GRAM_UNIT, 1];
    const grams = item.quantity * unit[1];
    const values = {}, missing = [];
    NUT_KEYS.forEach(function (k) {
        const v = f.n[k];
        if (v === null || v === undefined) { values[k] = null; if (CORE_KEYS.indexOf(k) !== -1) missing.push(k); }
        else values[k] = v * grams / 100;
    });
    return {
        source: 'tzameret', code: f.code, sml: f.sml, name: f.name,
        unitName: unitName(unit[0]), unitGrams: unit[1], quantity: item.quantity,
        grams: grams, per100: f.n, values: values, missing: missing
    };
}

// =============================================================================
// 11. SAVE & DELETE
// =============================================================================
// Pure: turns the chosen ingredients into the meal record that is saved and uploaded.
// Returns null when no ingredient could be computed.
function buildMeal(d) {
    const leftover = d.finished ? 0 : d.leftoverPct;
    const ratio = (100 - leftover) / 100;
    const ingredients = [];
    const net = {}; NUT_KEYS.forEach(function (k) { net[k] = null; });  // null = no ingredient has data
    const missing = {};

    d.ingredients.forEach(function (item) {
        const rec = computeIngredient(item);
        if (!rec || rec.grams === null && rec.source === 'tzameret') return;
        const netValues = {};
        NUT_KEYS.forEach(function (k) {
            netValues[k] = rec.values[k] === null ? null : round2(rec.values[k] * ratio);
            if (netValues[k] !== null) net[k] = (net[k] || 0) + netValues[k];
            else missing[k] = true;
        });
        ingredients.push({
            source: rec.source, tzameretCode: rec.code, smlmitzrach: rec.sml, name: rec.name,
            quantity: rec.quantity, unitName: rec.unitName, unitGrams: rec.unitGrams,
            grams: rec.grams === null ? null : round2(rec.grams),
            per100: rec.per100 || null, labelBasis: rec.labelBasis || null, labelValues: rec.labelValues || null,
            barcode: rec.barcode || null, offPer100: rec.offPer100 || null, offLastModified: rec.offLastModified || null,
            gross: roundObj(rec.values), net: netValues
        });
    });
    if (!ingredients.length) return null;

    const nowIso = (d.now || new Date()).toISOString();
    return {
        id: newId('meal'),
        participantCode: d.participantCode,
        group: d.group,
        date: d.date,
        dayName: dayNameForIso(d.date),
        mealType: d.type,
        time: d.time,
        description: String(d.desc || '').trim(),
        finished: !!d.finished,
        leftoverPct: leftover,
        ingredients: ingredients,
        nutrition: roundObj(net),
        missingNutrients: Object.keys(missing),
        preciseSummary: ingredients.map(function (i) {
            return i.name + ' (' + i.quantity + ' ' + i.unitName + (i.grams !== null && i.unitName !== 'גרם' ? ', ' + fmt0(i.grams) + 'ג׳' : '') + ')';
        }).join(' • '),
        photo: d.photo || null,
        photoUploaded: false,
        dbVersion: FoodDB.meta ? FoodDB.meta.dataLastUpdated : '',
        appVersion: APP_VERSION,
        enteredAt: nowIso,
        updatedAt: nowIso,
        deleted: false,
        syncStatus: 'pending'
    };
}

function handleAddMeal() {
    if ($('meal-sheet-root').classList.contains('hidden')) return;   // second tap after the sheet closed
    const meal = buildMeal({
        ingredients: appState.activeIngredients,
        finished: appState.finishedFood,
        leftoverPct: appState.leftoverPct,
        participantCode: appState.participantCode,
        group: appState.group,
        date: appState.selectedDate,
        type: appState.draft.type,
        time: appState.draft.time,
        desc: appState.draft.desc,
        photo: appState.currentPhotoDataUrl
    });
    if (!meal) { showToast('לא נבחרו רכיבים', 'error'); return; }

    appState.meals.push(meal);
    savePersistedState();
    appState.activeIngredients = [];
    appState.draft = { type: '', time: '', desc: '' };
    appState.currentPhotoDataUrl = null;
    hideMealSheet();
    renderDiary();
    showToast('הארוחה נשמרה ✓', 'success');
    syncNow(false);
}

function deleteMeal(mealId) {
    const m = appState.meals.find(function (x) { return x.id === mealId; });
    if (!m) return;
    if (!confirm('למחוק את הארוחה מהיומן?')) return;
    m.deleted = true;                  // soft delete: synced and kept for audit
    m.updatedAt = new Date().toISOString();
    m.syncStatus = 'pending';
    savePersistedState();
    closeInfoSheet();
    renderDiary();
    showToast('הארוחה נמחקה');
    syncNow(false);
}

// =============================================================================
// 12. CLOUD SYNC (Google Apps Script web app → Google Drive / Sheets)
// =============================================================================
const API_TIMEOUT_MS = 45000;   // a hung request must never freeze the upload queue

async function apiCall(action, payload) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, API_TIMEOUT_MS) : null;
    try {
        // text/plain avoids a CORS preflight, which Apps Script does not answer.
        const resp = await fetch(CFG.BACKEND_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(Object.assign({ action: action, studyKey: CFG.STUDY_KEY }, payload)),
            redirect: 'follow',
            signal: ctrl ? ctrl.signal : undefined
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return await resp.json();
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// Server answers that will never succeed on retry: flag the meal and move on, so one bad
// meal can't block every later upload. Anything else (no internet, busy) is retried later.
const PERMANENT_SYNC_ERRORS = ['code_mismatch', 'missing_meal', 'bad_code_format', 'bad_json', 'unknown_action'];

function pendingCount() { return appState.meals.filter(function (m) { return m.syncStatus === 'pending'; }).length; }
function rejectedCount() { return appState.meals.filter(function (m) { return m.syncStatus === 'rejected'; }).length; }

function mealPayload(m) {
    const copy = Object.assign({}, m);
    delete copy.photo;
    delete copy.syncStatus;
    return copy;
}

async function syncNow(manual) {
    if (!cloudEnabled() || !appState.isLocked) { renderSyncStatus(); return; }
    if (appState.sync.inFlight) return;
    const queue = appState.meals.filter(function (m) { return m.syncStatus === 'pending'; });
    if (!queue.length) {
        if (manual) showToast('כל הארוחות כבר שמורות בענן', 'success');
        renderSyncStatus();
        return;
    }
    appState.sync.inFlight = true;
    appState.sync.lastError = '';
    renderSyncStatus();
    let okCount = 0;
    for (let i = 0; i < queue.length; i++) {
        const m = queue[i];
        try {
            const sendPhoto = !!m.photo && !m.photoUploaded && !m.deleted;
            const res = await apiCall('upsertMeal', {
                participantCode: appState.participantCode,
                meal: mealPayload(m),
                photoBase64: sendPhoto ? m.photo.split(',')[1] : null
            });
            if (!res.ok) {
                if (PERMANENT_SYNC_ERRORS.indexOf(res.error) !== -1) {
                    m.syncStatus = 'rejected';
                    m.syncError = res.error;
                    continue;
                }
                throw new Error(res.error || 'server error');
            }
            if (sendPhoto) {
                m.photoUploaded = true;
                m.photo = await resizeImage(m.photo, 240, 0.7);   // full photo is in Drive; keep a thumbnail
            }
            m.syncStatus = 'synced';
            okCount++;
        } catch (err) {
            appState.sync.lastError = String(err.message || err);
            break;
        }
    }
    appState.meals = appState.meals.filter(function (m) { return !(m.deleted && m.syncStatus === 'synced'); });
    if (okCount) appState.sync.lastSyncAt = new Date().toISOString();
    appState.sync.inFlight = false;
    savePersistedState();
    renderSyncStatus();
    renderDiary();
    if (manual) {
        showToast(appState.sync.lastError ? 'אין חיבור — ננסה שוב אוטומטית' : 'הנתונים נשמרו בענן', appState.sync.lastError ? 'error' : 'success');
    }
}

function renderSyncStatus() {
    const el = $('sync-chip');
    if (!cloudEnabled()) { el.className = 'chip muted'; el.textContent = 'מצב הדגמה'; return; }
    const n = pendingCount(), bad = rejectedCount();
    if (appState.sync.inFlight) { el.className = 'chip'; el.textContent = '⟳ שומר...'; }
    else if (n) { el.className = 'chip warn'; el.textContent = n + ' ממתינות'; }
    else if (bad) { el.className = 'chip danger'; el.textContent = '⚠ ' + bad + ' לא הועלו'; }
    else { el.className = 'chip ok'; el.textContent = '✓ נשמר בענן'; }
}

// =============================================================================
// 13. TRE 8-HOUR WINDOW
// =============================================================================
function timeToMinutes(hhmm) {
    const p = (hhmm || '00:00').split(':');
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
}

function minutesToTime(mins) {
    const w = ((mins % 1440) + 1440) % 1440;
    return String(Math.floor(w / 60)).padStart(2, '0') + ':' + String(w % 60).padStart(2, '0');
}

function evaluateMealsForDay(dayMeals) {
    const sorted = dayMeals.slice().sort(function (a, b) { return timeToMinutes(a.time) - timeToMinutes(b.time); });
    if (!sorted.length) return { sorted: [], firstTime: null, lastTime: null, windowEnd: null, spanMinutes: 0, violationCount: 0, hasViolation: false };
    const first = timeToMinutes(sorted[0].time);
    const last = timeToMinutes(sorted[sorted.length - 1].time);
    const limit = first + 480;
    let violations = 0;
    const enriched = sorted.map(function (m) {
        const outside = timeToMinutes(m.time) > limit;
        if (outside) violations++;
        return Object.assign({}, m, { isOutsideTreWindow: outside });
    });
    return {
        sorted: enriched, firstTime: sorted[0].time, lastTime: sorted[sorted.length - 1].time,
        windowEnd: minutesToTime(limit), spanMinutes: Math.max(0, last - first),
        violationCount: violations, hasViolation: violations > 0
    };
}

function toggleRtResearcherSummary() {
    if (!appState.rtSummaryRevealed && !CFG.RESEARCHER_PIN) return;   // no PIN set → never unblind on the phone
    if (!appState.rtSummaryRevealed) {
        const pin = prompt('קוד חוקר:');
        if (pin === null) return;
        if (pin !== CFG.RESEARCHER_PIN) { showToast('קוד חוקר שגוי', 'error'); return; }
    }
    appState.rtSummaryRevealed = !appState.rtSummaryRevealed;
    $('menu-researcher').textContent = appState.rtSummaryRevealed ? '🔒 סגירת תצוגת חוקר' : '🔑 תצוגת חוקר';
    renderDiary();
}

// =============================================================================
// 14. EXCEL EXPORT (backup copy)
// =============================================================================
function buildExportRows() {
    const meals = visibleMeals();
    const byDate = {};
    meals.forEach(function (m) { (byDate[m.date] = byDate[m.date] || []).push(m); });
    const mealRows = [], ingRows = [], dayRows = [];
    const missName = function (k) { return NUT_SHORT[k] || NUT_LABELS[k] || k; };

    Object.keys(byDate).sort().forEach(function (d) {
        const ev = evaluateMealsForDay(byDate[d]);
        const s = sumNutrition(ev.sorted);
        ev.sorted.forEach(function (m) {
            const row = {
                'קוד נחקר': m.participantCode, 'קבוצת מחקר': m.group, 'מזהה ארוחה': m.id,
                'תאריך': m.date, 'יום בשבוע': m.dayName, 'סוג ארוחה': m.mealType, 'שעת אכילה': m.time,
                'זמן הזנה': m.enteredAt || '',
                'סטטוס חלון TRE': m.group === 'TRE' ? (m.isOutsideTreWindow ? 'חריגה מחלון 8 השעות' : 'תקין') : '-',
                'תיאור הארוחה': m.description, 'רכיבים וכמויות': m.preciseSummary || '',
                'אחוז שאריות בצלחת (%)': m.leftoverPct || 0
            };
            NUT_KEYS.forEach(function (k) { row[NUT_LABELS[k] + ' נטו'] = m.nutrition && m.nutrition[k] !== null ? m.nutrition[k] : ''; });
            row['רכיבים עם נתון חסר'] = (m.missingNutrients || []).map(missName).join(', ');
            mealRows.push(row);
            (m.ingredients || []).forEach(function (ing, idx) {
                const r = {
                    'קוד נחקר': m.participantCode, 'מזהה ארוחה': m.id, 'תאריך': m.date, 'שעת אכילה': m.time,
                    'מס׳ רכיב': idx + 1, 'מקור נתונים': SOURCE_LABELS[ing.source] || ing.source,
                    'קוד צמרת': ing.tzameretCode || '', 'סמל מצרך': ing.smlmitzrach || '', 'ברקוד': ing.barcode || '', 'שם מזון': ing.name,
                    'כמות': ing.quantity, 'יחידה': ing.unitName, 'משקל יחידה (גרם)': ing.unitGrams === null ? '' : ing.unitGrams,
                    'משקל כולל (גרם)': ing.grams === null ? '' : ing.grams, 'אחוז שאריות (%)': m.leftoverPct || 0
                };
                NUT_KEYS.forEach(function (k) { r[NUT_LABELS[k] + ' נטו'] = ing.net[k] === null ? '' : ing.net[k]; });
                ingRows.push(r);
            });
        });
        const dr = {
            'קוד נחקר': appState.participantCode, 'קבוצת מחקר': appState.group, 'תאריך': d,
            'יום בשבוע': ev.sorted[0] ? ev.sorted[0].dayName : '', 'מספר ארוחות': ev.sorted.length,
            'ארוחה ראשונה': ev.firstTime || '-', 'ארוחה אחרונה': ev.lastTime || '-',
            'משך חלון אכילה (דקות)': ev.spanMinutes,
            'חריגות TRE מחוץ לחלון': appState.group === 'TRE' ? ev.violationCount : ''
        };
        NUT_KEYS.forEach(function (k) { dr['סה"כ ' + NUT_LABELS[k]] = round2(s.totals[k]); });
        dr['רכיבים עם נתון חסר'] = Object.keys(s.missing).map(missName).join(', ');
        dayRows.push(dr);
    });

    const metaRows = [
        { 'שדה': 'מקור ערכים תזונתיים', 'ערך': FoodDB.meta ? FoodDB.meta.source : 'Tzameret' },
        { 'שדה': 'תאריך עדכון המאגר', 'ערך': FoodDB.meta ? FoodDB.meta.dataLastUpdated : '' },
        { 'שדה': 'קישור למאגר', 'ערך': 'https://data.gov.il/dataset/nutrition-database' },
        { 'שדה': 'מוצרים ארוזים שנסרקו', 'ערך': 'Open Food Facts (openfoodfacts.org, ODbL) — הנחקר אישר או תיקן את הערכים מול התווית' },
        { 'שדה': 'ערכים ל-', 'ערך': '100 גרם חלק אכיל; נטו = אחרי ניכוי שאריות בצלחת' },
        { 'שדה': 'ערך ריק', 'ערך': 'ערך חסר במאגר (לא אפס)' },
        { 'שדה': 'גרסת יישום', 'ערך': APP_VERSION },
        { 'שדה': 'תאריך ייצוא', 'ערך': new Date().toISOString() }
    ];
    return { mealRows: mealRows, ingRows: ingRows, dayRows: dayRows, metaRows: metaRows };
}

function exportToExcel() {
    if (isRtBlinded()) { showToast('הייצוא זמין בתצוגת חוקר בלבד', 'error'); return; }
    const rows = buildExportRows();
    if (!rows.mealRows.length) { showToast('אין ארוחות לייצוא', 'error'); return; }
    if (!(window.XLSX && window.XLSX.utils)) { showToast('רכיב הייצוא נטען — נסו שוב בעוד רגע', 'error'); return; }
    const X = window.XLSX;
    const wb = X.utils.book_new();
    wb.Workbook = { Views: [{ RTL: true }] };
    [['פירוט ארוחות', rows.mealRows], ['פירוט רכיבים', rows.ingRows], ['סיכום יומי', rows.dayRows], ['מקור נתונים', rows.metaRows]].forEach(function (p) {
        const ws = X.utils.json_to_sheet(p[1]);
        ws['!views'] = [{ rightToLeft: true }];
        X.utils.book_append_sheet(wb, ws, p[0]);
    });
    X.writeFile(wb, 'FoodDiary_' + appState.participantCode + '_' + appState.group + '_' + formatIsoDate(new Date()) + '.xlsx');
    showToast('קובץ האקסל נשמר', 'success');
}

// =============================================================================
// 15. HELPERS
// =============================================================================
function round2(v) { return v === null || v === undefined ? null : Math.round(v * 100) / 100; }
function roundObj(o) { const r = {}; Object.keys(o).forEach(function (k) { r[k] = round2(o[k]); }); return r; }
function fmt0(v) { return v === null || v === undefined || isNaN(v) ? '—' : Math.round(v).toLocaleString('he-IL'); }
function fmt1(v) { return v === null || v === undefined || isNaN(v) ? '—' : (Math.round(v * 10) / 10).toLocaleString('he-IL'); }

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

function showToast(msg, type) {
    const c = $('toast-container');
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(function () {
        el.style.opacity = '0';
        el.style.transition = 'opacity 0.25s';
        setTimeout(function () { el.remove(); }, 250);
    }, 3000);
}
