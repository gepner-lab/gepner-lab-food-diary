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
const APP_VERSION = '2.2.0';

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
    activeIngredients: [],   // { uid, kind:'tz', code, unitCode, quantity } | { uid, kind:'label', name, basis, per, amount, badge }
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
        if (!$('info-sheet-root').classList.contains('hidden')) { closeInfoSheet(true); return; }
        if (!$('meal-sheet-root').classList.contains('hidden')) {
            if (appState.step > 1) { appState.step--; renderSheetStep(); history.pushState({ sheet: 'meal' }, ''); }
            else closeMealSheet(true);
        }
    });

    window.addEventListener('online', function () { syncNow(false); });
    document.addEventListener('visibilitychange', function () {
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
        btn.querySelector('span').textContent = 'מתחבר למערכת המחקר...';
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
    $('menu-researcher').classList.toggle('hidden', appState.group !== 'RT');
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
        if (cloudEnabled() && m.syncStatus !== 'synced') chips.push('<span class="chip muted sm">ממתין להעלאה</span>');
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
    $('info-sheet-root').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    history.pushState({ sheet: 'info' }, '');
}

function closeInfoSheet(fromPop) {
    if ($('info-sheet-root').classList.contains('hidden')) return;
    $('info-sheet-root').classList.add('hidden');
    if ($('meal-sheet-root').classList.contains('hidden')) document.body.style.overflow = '';
    if (!fromPop && history.state && history.state.sheet) history.back();
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
            (cloudEnabled() ? ' · ' + (m.syncStatus === 'synced' ? 'נשמר בענן ✓' : 'ממתין להעלאה') : '') + '</div>';
    openInfoSheet(m.mealType + ' · ' + m.time, body,
        '<button type="button" class="btn danger" style="flex:1;" onclick="deleteMeal(\'' + m.id + '\')">מחיקת הארוחה</button>' +
        '<button type="button" class="btn" style="flex:1;" onclick="closeInfoSheet()">סגירה</button>');
}

function showAbout() {
    const meta = FoodDB.meta || {};
    openInfoSheet('על היומן ומקור הנתונים',
        '<p style="line-height:1.6;">הערכים התזונתיים מחושבים לפי <b>מאגר צמרת</b> — מאגר הנתונים התזונתי הלאומי של משרד הבריאות' +
        (meta.dataLastUpdated ? ' (עדכון נתונים: ' + formatDisplayDate(meta.dataLastUpdated) + ')' : '') +
        '. מוצרים שהוזנו מתווית אריזה מחושבים לפי הערכים שהוקלדו.</p>' +
        '<div class="detail-list">' +
        '<div><span>קוד נחקר</span><span class="dv">' + ltr(appState.participantCode) + '</span></div>' +
        '<div><span>קבוצה</span><span class="dv">' + ltr(appState.group) + '</span></div>' +
        '<div><span>סנכרון אחרון</span><span class="dv">' + (appState.sync.lastSyncAt ? new Date(appState.sync.lastSyncAt).toLocaleString('he-IL') : '—') + '</span></div>' +
        '<div><span>ממתינות להעלאה</span><span class="dv">' + pendingCount() + '</span></div>' +
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
    if (!fromPop && history.state && history.state.sheet) history.back();
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
    const foods = searchFoods(q, 25);
    if (!saved.length && !foods.length) {
        box.innerHTML = '<div class="results"><div class="results-empty">לא נמצא במאגר. נסו מילה אחרת, או <button type="button" class="link-btn" onclick="switchSource(\'label\')">הזינו מתווית אריזה</button>.</div></div>';
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
        const unitLbl = item.kind === 'label' ? (item.basis === '100g' ? 'גרם / מ"ל' : 'יחידות') : (item.unitCode === GRAM_UNIT ? 'גרם' : unitName(item.unitCode));
        const calc = (rec.grams !== null && unitLbl !== 'גרם' ? '= <b>' + fmt0(rec.grams) + ' ג׳</b>' : '') +
            (blind ? '' : (rec.grams !== null && unitLbl !== 'גרם' ? ' · ' : '') + '<b>' + fmt0(rec.values.cal) + '</b> קק״ל');
        const badge = item.kind === 'label' ? (item.badge || 'תווית') : 'צמרת';
        const large = rec.grams !== null && rec.grams > LARGE_PORTION_G
            ? '<div class="chip warn sm">כמות גדולה (' + fmt0(rec.grams) + ' ג׳) — בדקו שהמנה והכמות נכונות</div>' : '';
        return '<div class="ing panel' + (needsUnit ? ' needs-unit' : '') + '">' +
            '<div class="ing-top"><div class="ing-name"><span class="src">' + escapeHtml(badge) + '</span>' + escapeHtml(rec.name) + '</div>' +
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
    const isGrams = item.kind === 'label' ? item.basis === '100g' : item.unitCode === GRAM_UNIT;
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

    if ($('lbl-save-personal').checked) {
        appState.savedCustomProducts = appState.savedCustomProducts.filter(function (p) { return normalizeText(p.name) !== normalizeText(name); });
        appState.savedCustomProducts.unshift({ id: newId('cp'), name: name, basis: basis, per: per });
        savePersistedState();
    }
    appState.activeIngredients.push({ uid: newId('ing'), kind: 'label', name: name, basis: basis, per: per, amount: eaten, badge: 'תווית' });
    ['lbl-name', 'lbl-cal', 'lbl-pro', 'lbl-carb', 'lbl-fat', 'lbl-calc', 'lbl-sod'].forEach(function (id) { $(id).value = ''; });
    $('lbl-eaten-amount').value = basis === '100g' ? '100' : '1';
    switchSource('tz');
    afterIngredientAdded(name);
}

function savedProductPer(cp) {
    return cp.per || { cal: cp.cal, pro: cp.pro, carb: cp.carb, fat: cp.fat, calc: cp.calc, sod: cp.sod };
}

function addSavedCustomToMeal(customId) {
    const cp = appState.savedCustomProducts.find(function (p) { return p.id === customId; });
    if (!cp) return;
    appState.activeIngredients.push({
        uid: newId('ing'), kind: 'label', name: cp.name, basis: cp.basis, per: savedProductPer(cp),
        amount: cp.basis === '100g' ? 100 : 1, badge: 'שמור'
    });
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
        const ratio = item.basis === '100g' ? item.amount / 100 : item.amount;
        const values = {}, missing = [];
        NUT_KEYS.forEach(function (k) {
            const v = item.per[k];
            if (v === null || v === undefined) { values[k] = null; if (CORE_KEYS.indexOf(k) !== -1) missing.push(k); }
            else values[k] = v * ratio;
        });
        return {
            source: 'label', code: null, sml: null, name: item.name,
            unitName: item.basis === '100g' ? 'גרם/מ"ל' : 'יחידה/מנה (לפי התווית)',
            unitGrams: item.basis === '100g' ? 1 : null, quantity: item.amount,
            grams: item.basis === '100g' ? item.amount : null,
            labelBasis: item.basis, labelValues: item.per, values: values, missing: missing
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
function handleAddMeal() {
    const leftover = appState.finishedFood ? 0 : appState.leftoverPct;
    const ratio = (100 - leftover) / 100;
    const ingredients = [];
    const net = {}; NUT_KEYS.forEach(function (k) { net[k] = null; });  // null = no ingredient has data
    const missing = {};

    appState.activeIngredients.forEach(function (item) {
        const rec = computeIngredient(item);
        if (!rec) return;
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
            gross: roundObj(rec.values), net: netValues
        });
    });
    if (!ingredients.length) { showToast('לא נבחרו רכיבים', 'error'); return; }

    const nowIso = new Date().toISOString();
    const meal = {
        id: newId('meal'),
        participantCode: appState.participantCode,
        group: appState.group,
        date: appState.selectedDate,
        dayName: appState.selectedDayName,
        mealType: appState.draft.type,
        time: appState.draft.time,
        description: appState.draft.desc.trim(),
        finished: appState.finishedFood,
        leftoverPct: leftover,
        ingredients: ingredients,
        nutrition: roundObj(net),
        missingNutrients: Object.keys(missing),
        preciseSummary: ingredients.map(function (i) {
            return i.name + ' (' + i.quantity + ' ' + i.unitName + (i.grams !== null && i.unitName !== 'גרם' ? ', ' + fmt0(i.grams) + 'ג׳' : '') + ')';
        }).join(' • '),
        photo: appState.currentPhotoDataUrl,
        photoUploaded: false,
        dbVersion: FoodDB.meta ? FoodDB.meta.dataLastUpdated : '',
        appVersion: APP_VERSION,
        enteredAt: nowIso,
        updatedAt: nowIso,
        deleted: false,
        syncStatus: 'pending'
    };

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
async function apiCall(action, payload) {
    // text/plain avoids a CORS preflight, which Apps Script does not answer.
    const resp = await fetch(CFG.BACKEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action: action, studyKey: CFG.STUDY_KEY }, payload)),
        redirect: 'follow'
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return resp.json();
}

function pendingCount() { return appState.meals.filter(function (m) { return m.syncStatus !== 'synced'; }).length; }

function mealPayload(m) {
    const copy = Object.assign({}, m);
    delete copy.photo;
    delete copy.syncStatus;
    return copy;
}

async function syncNow(manual) {
    if (!cloudEnabled() || !appState.isLocked) { renderSyncStatus(); return; }
    if (appState.sync.inFlight) return;
    const queue = appState.meals.filter(function (m) { return m.syncStatus !== 'synced'; });
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
            if (!res.ok) throw new Error(res.error || 'server error');
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
    const n = pendingCount();
    if (appState.sync.inFlight) { el.className = 'chip'; el.textContent = '⟳ שומר...'; }
    else if (!n) { el.className = 'chip ok'; el.textContent = '✓ נשמר בענן'; }
    else { el.className = 'chip warn'; el.textContent = n + ' ממתינות'; }
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
    if (!appState.rtSummaryRevealed && CFG.RESEARCHER_PIN) {
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
                    'מס׳ רכיב': idx + 1, 'מקור נתונים': ing.source === 'tzameret' ? 'צמרת' : 'תווית אריזה',
                    'קוד צמרת': ing.tzameretCode || '', 'סמל מצרך': ing.smlmitzrach || '', 'שם מזון': ing.name,
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
        { 'שדה': 'ערכים ל-', 'ערך': '100 גרם חלק אכיל; נטו = אחרי ניכוי שאריות בצלחת' },
        { 'שדה': 'ערך ריק', 'ערך': 'ערך חסר במאגר (לא אפס)' },
        { 'שדה': 'גרסת יישום', 'ערך': APP_VERSION },
        { 'שדה': 'תאריך ייצוא', 'ערך': new Date().toISOString() }
    ];
    return { mealRows: mealRows, ingRows: ingRows, dayRows: dayRows, metaRows: metaRows };
}

function exportToExcel() {
    if (isRtBlinded() && CFG.RESEARCHER_PIN) { showToast('הייצוא זמין בתצוגת חוקר בלבד', 'error'); return; }
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
