/* ============================================================
   AutoFill v3 — content/content.js
   Minimalist overlay (Shadow DOM) + Brain Engine integration

   Sections:
     1. FILL ENGINE   (aliases, fuzzy local fallback, field fillers)
     2. BRAIN BRIDGE  (brain_query, brain_learn, observeUserEdits)
     3. OVERLAY CSS   (conf dots, update proposal toast, drawer)
     4. OVERLAY UI    (Shadow DOM build + event wiring)
     5. FILL FLOW     (scan → brain-first → preview → fill)
     6. INIT          (MutationObserver form detection)
   ============================================================ */

'use strict';

if (!window.__autofillInitialized) {
  window.__autofillInitialized = true;
  main();
}

/* ════════════════════════════════════════════════════════════
   SECTION 1 — LOCAL FILL ENGINE  (fallback when brain misses)
   ════════════════════════════════════════════════════════════ */

// Local alias dictionary (a subset of brain's seed — used when SW is cold)
const LOCAL_ALIASES = {
  'dob':'date of birth','uid':'university id','id':'identity',
  'reg no':'registration number','regd no':'registration number',
  'roll no':'roll number','roll':'roll number',
  'mob':'mobile number','mobile no':'mobile number',
  'phone no':'phone number','ph no':'phone number','ph':'phone',
  'dept':'department','cgpa':'cumulative grade point average',
  'gpa':'grade point average','yop':'year of passing',
  'sname':'student name','fname':'father name','mname':'mother name',
  'addr':'address','yr':'year','sem':'semester','clg':'college',
  'univ':'university','aadhar':'aadhaar number','pan':'permanent account number',
  'stream':'branch','spec':'specialization','specialisation':'specialization',
  'linkedin':'linkedin profile','github':'github profile',
};

function _localNorm(str) {
  return (str || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function _localExpand(s) {
  const n = _localNorm(s);
  return LOCAL_ALIASES[n] ? LOCAL_ALIASES[n]
    : n.split(' ').map(w => LOCAL_ALIASES[w] || w).join(' ');
}

function _levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

/** Local fuzzy match — runs entirely in content script without SW roundtrip */
function localFuzzyMatch(questionLabel, fields, thresholdPct) {
  const thresh  = thresholdPct / 100;
  const normQ   = _localNorm(questionLabel);
  const expandQ = _localExpand(normQ);
  const qWords  = expandQ.split(' ').filter(Boolean);

  // Exact-match fast path
  for (const { label, value } of fields) {
    if (!label) continue;
    const normK = _localNorm(label), expK = _localExpand(normK);
    if (normK === normQ || expK === expandQ) return { key: label, value, score: 1.0 };
  }

  let best = null;
  for (const { label, value } of fields) {
    if (!label) continue;
    const normK  = _localNorm(label), expK = _localExpand(normK);
    const kWords = expK.split(' ').filter(Boolean);
    const maxLen = Math.max(expandQ.length, expK.length) || 1;
    const lev    = 1 - _levenshtein(expandQ, expK) / maxLen;
    const shared = qWords.filter(w => kWords.includes(w)).length;
    const union  = new Set([...qWords, ...kWords]).size;
    const overlap  = union > 0 ? shared / union : 0;
    const contains = (expandQ.includes(expK) || expK.includes(expandQ)) ? 0.12 : 0;
    const score  = lev * 0.35 + overlap * 0.53 + contains * 0.12;
    if (score >= thresh && (!best || score > best.score))
      best = { key: label, value, score };
  }
  return best;
}

// ── Field type detection ──────────────────────────────────────
function detectType(container) {
  // M4 fix: check dropdown before radio — GForms dropdown containers can
  // contain [role="radio"] for the selected-option display element.
  if (container.querySelector('.MocG8c') || container.querySelector('[aria-haspopup="listbox"]'))
    return 'dropdown';
  if (container.querySelector('select'))            return 'dropdown';
  if (container.querySelector('[role="radio"]'))    return 'radio';
  if (container.querySelector('[role="checkbox"]')) return 'checkbox';
  if (container.querySelector('input[aria-label="Day"]') || container.querySelector('input[type="date"]'))
    return 'date';
  if (container.querySelector('textarea'))          return 'paragraph';
  if (container.querySelector('input[type="text"]'))return 'short';
  return null;
}

function extractLabel(container) {
  for (const sel of ['.M7eMe','.freebirdFormviewerComponentsQuestionBaseTitle',
    '.freebirdFormviewerViewItemsItemItemTitle','[role="heading"]','span[dir="auto"]']) {
    const el = container.querySelector(sel);
    if (el && el.textContent.trim()) return el.textContent.trim();
  }
  return container.textContent.slice(0, 80).trim();
}

function getQuestions() {
  for (const sel of ['div[data-params]','div.Qr7Oae',
    'div.freebirdFormviewerViewItemsItemItem','div.freebirdFormviewerComponentsQuestionBaseRoot']) {
    const els = Array.from(document.querySelectorAll(sel));
    if (els.length > 0) return els;
  }
  return [];
}

function isAlreadyFilled(container, type) {
  if (type === 'short' || type === 'paragraph') {
    const el = container.querySelector('input[type="text"], textarea');
    return !!(el && el.value.trim());
  }
  if (type === 'radio')    return !!container.querySelector('[role="radio"][aria-checked="true"]');
  if (type === 'checkbox') return !!container.querySelector('[role="checkbox"][aria-checked="true"]');
  if (type === 'date') {
    const el = container.querySelector('input[aria-label="Day"], input[type="date"]');
    return !!(el && el.value.trim());
  }
  return false;
}

// ── React-safe setter ────────────────────────────────────────
function setNativeValue(el, value) {
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, value); else el.value = value;
  el.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
}

// ── MutationObserver waitFor (dropdown race fix) ────────────
function waitFor(selectorFn, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const el = selectorFn(); if (el) { resolve(el); return; }
    const timer = setTimeout(() => { obs.disconnect(); reject(new Error('timeout')); }, timeout);
    const obs = new MutationObserver(() => {
      const found = selectorFn();
      if (found) { clearTimeout(timer); obs.disconnect(); resolve(found); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  });
}

// ── Field Fillers ─────────────────────────────────────────────
function fillText(container, value, overwrite = false) {
  const input = container.querySelector('input.whsOnd') ||
    container.querySelector('input[type="text"]') ||
    container.querySelector('textarea.KHxj8b') || container.querySelector('textarea');
  if (!input) return false;
  if (!overwrite && input.value.trim()) return 'skipped';
  input.focus(); setNativeValue(input, value); return true;
}

async function fillDropdown(container, value) {
  const normVal = _localNorm(value);
  const nativeSel = container.querySelector('select');
  if (nativeSel) {
    for (const opt of nativeSel.options) {
      if (_localNorm(opt.text).includes(normVal) || normVal.includes(_localNorm(opt.text)))
        { setNativeValue(nativeSel, opt.value); return true; }
    }
    return false;
  }
  const toggle = container.querySelector('[aria-haspopup="listbox"]') || container.querySelector('.MocG8c');
  if (!toggle) return false;
  toggle.click();
  try {
    await waitFor(() => {
      const opts = document.querySelectorAll('[role="option"]:not([aria-hidden="true"])');
      return opts.length > 0 ? opts : null;
    }, 2500);
    for (const opt of document.querySelectorAll('[role="option"]:not([aria-hidden="true"])')) {
      const t = _localNorm(opt.textContent);
      if (t.includes(normVal) || normVal.includes(t)) { opt.click(); return true; }
    }
  } catch (_) {}
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return false;
}

function fillRadio(container, value) {
  const normVal = _localNorm(value);
  for (const opt of container.querySelectorAll('[role="radio"]')) {
    const lbl = _localNorm(opt.getAttribute('data-value') || opt.textContent || '');
    if (lbl === normVal || lbl.includes(normVal) || normVal.includes(lbl))
      { if (opt.getAttribute('aria-checked') !== 'true') opt.click(); return true; }
  }
  return false;
}

function fillCheckbox(container, value) {
  const targets = _localNorm(value).split(/[,;]/).map(s => s.trim()).filter(Boolean);
  let filled = 0;
  for (const box of container.querySelectorAll('[role="checkbox"]')) {
    const lbl = _localNorm(box.getAttribute('data-value') || box.textContent || '');
    if (targets.some(t => lbl === t || lbl.includes(t) || t.includes(lbl)))
      { if (box.getAttribute('aria-checked') !== 'true') { box.click(); filled++; } }
  }
  return filled > 0;
}

function fillDate(container, value) {
  let day, month, year;
  const s = value.split('/'), d = value.split('-'), dot = value.split('.');
  if (s.length === 3)        { [day, month, year] = s.map(Number); }
  else if (d.length === 3)   {
    const [a, b, c] = d.map(Number);
    String(d[0]).length === 4 ? ([year, month, day] = [a, b, c]) : ([day, month, year] = [a, b, c]);
  } else if (dot.length === 3) { [day, month, year] = dot.map(Number); }
  else { const dt = new Date(value); if (isNaN(dt.getTime())) return false; day = dt.getDate(); month = dt.getMonth()+1; year = dt.getFullYear(); }
  if (!day || !month || !year) return false;
  const nd = container.querySelector('input[type="date"]');
  if (nd) { setNativeValue(nd, `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`); return true; }
  let ok = false;
  const dayEl = container.querySelector('input[aria-label="Day"]');
  const monEl = container.querySelector('input[aria-label="Month"]');
  const yrEl  = container.querySelector('input[aria-label="Year"]');
  if (dayEl) { setNativeValue(dayEl, String(day));   ok = true; }
  if (monEl) { setNativeValue(monEl, String(month)); ok = true; }
  if (yrEl)  { setNativeValue(yrEl,  String(year));  ok = true; }
  return ok;
}

async function executeFill(confirmedMatches, settings) {
  _isProgrammaticFilling = true;
  try {
    const { overwrite = false } = settings;
    const questions = getQuestions();
    let filled = 0, skipped = 0, errors = 0;

    for (const match of confirmedMatches) {
      if (!match.confirmed) { skipped++; continue; }
      const container = questions[match.idx];
      if (!container) { errors++; continue; }
      if (!overwrite && match.alreadyFilled) { skipped++; continue; }
      try {
        let result = false;
        const { type, matchedValue } = match;
        if (type === 'short' || type === 'paragraph') result = fillText(container, matchedValue, overwrite);
        else if (type === 'radio')    result = fillRadio(container, matchedValue);
        else if (type === 'checkbox') result = fillCheckbox(container, matchedValue);
        else if (type === 'dropdown') result = await fillDropdown(container, matchedValue);
        else if (type === 'date')     result = fillDate(container, matchedValue);
        else { skipped++; continue; }
        if (result === 'skipped') skipped++; else if (result) filled++; else errors++;
      } catch (e) {
        errors++;
        console.warn('[AutoFill v3]', match.questionLabel, e.message);
      }
    }
    return { filled, skipped, errors };
  } finally {
    _isProgrammaticFilling = false;
  }
}


/* ════════════════════════════════════════════════════════════
   SECTION 2 — BRAIN BRIDGE
   ════════════════════════════════════════════════════════════ */

const FORM_URL = location.hostname + location.pathname;

/** Brain-first query for a single label, falls back to local fuzzy */
async function resolveMatch(questionLabel, storedFields, brainThreshPct, localThreshPct) {
  const brainThresh = (brainThreshPct || 75) / 100;

  // Try brain (background service worker)
  try {
    const r = await chrome.runtime.sendMessage({
      action: 'brain_query',
      label:   questionLabel,
      formUrl: FORM_URL,
    });

    if (r && r.concept && r.value != null) {
      if (r.manualOnly) {
        // Known concept but must not auto-fill
        return {
          matchedKey:   r.concept,
          matchedValue: r.value,
          alias:        r.alias || null,
          confidence:   r.confidence || 0,
          source:       'brain',
          manualOnly:   true,
        };
      }
      if (r.confidence >= brainThresh) {
        return {
          matchedKey:   r.concept,
          matchedValue: r.value,
          alias:        r.alias || null,
          confidence:   r.confidence,
          source:       'brain',
          manualOnly:   false,
        };
      }
    }
  } catch (_) { /* SW cold-start or unavailable — continue to local */ }

  // Local fuzzy fallback
  const local = localFuzzyMatch(questionLabel, storedFields, localThreshPct || brainThreshPct);
  if (local) {
    return {
      matchedKey:   local.key,
      matchedValue: local.value,
      alias:        null,
      confidence:   local.score,
      source:       'local',
      manualOnly:   false,
    };
  }

  return null;
}

/** Send brain_learn for all confirmed fills */
async function sendBrainLearn(confirmedMatches) {
  for (const m of confirmedMatches) {
    if (!m.confirmed || !m.matched) continue;
    try {
      chrome.runtime.sendMessage({
        action:         'brain_learn',
        label:          m.questionLabel,
        matchedConcept: m.matchedKey,
        wasHit:         true,
        formUrl:        FORM_URL,
        brainAlias:     m.alias || null,
      }).catch(() => {});
    } catch (_) {}
  }
}

/** MutationObserver-based edit watcher — debounced 800 ms */
function observeUserEdits(filledMatches) {
  const questions = getQuestions();

  filledMatches.forEach(match => {
    if (!match.confirmed || !match.matched) return;
    const container = questions[match.idx];
    if (!container) return;

    const input = container.querySelector('input[type="text"], textarea');
    if (!input) return;

    const original = match.matchedValue;
    let timer = null;

    const onEdit = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const newVal = input.value.trim();
        if (newVal && newVal !== original) {
          try {
            chrome.runtime.sendMessage({
              action:         'brain_learn',
              label:          match.questionLabel,
              matchedConcept: match.matchedKey,
              wasHit:         false,
              newValue:       newVal,
              oldValue:       original,
              formUrl:        FORM_URL,
            }).catch(() => {});
          } catch (_) {}
        }
      }, 800);
    };

    input.addEventListener('input', onEdit);
    input.addEventListener('change', onEdit);   // S3: backup for React synthetic change events
    // Note: MutationObserver on attribute:value removed — React stores value in fiber state,
    // not in the DOM attribute, so the observer never fires on Google Forms.
  });
}

/* ════════════════════════════════════════════════════════════
   SECTION 2b — PASSIVE LEARNING ENGINE (silently learn as user manually types)
   ════════════════════════════════════════════════════════════ */

let _isProgrammaticFilling = false;
let pendingPassiveUpdates = new Map();
let lastActiveDropdownContainer = null;

function findQuestionContainer(target) {
  const selectors = ['div[data-params]', 'div.Qr7Oae', 'div.freebirdFormviewerViewItemsItemItem', 'div.freebirdFormviewerComponentsQuestionBaseRoot'];
  for (const sel of selectors) {
    const container = target.closest(sel);
    if (container) return container;
  }
  return null;
}

function getPassiveDateValue(container) {
  const nd = container.querySelector('input[type="date"]');
  if (nd && nd.value) return nd.value; // e.g. "YYYY-MM-DD"
  
  const dayEl = container.querySelector('input[aria-label="Day"]');
  const monEl = container.querySelector('input[aria-label="Month"]');
  const yrEl  = container.querySelector('input[aria-label="Year"]');
  
  if (dayEl || monEl || yrEl) {
    const d = dayEl ? dayEl.value.trim() : '';
    const m = monEl ? monEl.value.trim() : '';
    const y = yrEl  ? yrEl.value.trim()  : '';
    if (d && m && y) {
      return `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${y}`;
    }
  }
  return null;
}

function flushAllPassiveUpdates() {
  for (const { timer, execute } of pendingPassiveUpdates.values()) {
    clearTimeout(timer);
    try {
      execute();
    } catch (_) {}
  }
  pendingPassiveUpdates.clear();
}

function handlePassiveInputEvent(inputEl) {
  if (_isProgrammaticFilling) return;
  const container = findQuestionContainer(inputEl);
  if (!container) return;
  
  const label = extractLabel(container);
  if (!label) return;

  const type = detectType(container);

  if (pendingPassiveUpdates.has(label)) {
    clearTimeout(pendingPassiveUpdates.get(label).timer);
  }

  const performUpdate = () => {
    pendingPassiveUpdates.delete(label);
    let value = '';
    if (type === 'date') {
      value = getPassiveDateValue(container);
    } else {
      value = inputEl.value.trim();
    }
    if (!value) return;

    chrome.runtime.sendMessage({
      action: 'brain_passive_learn',
      label: label,
      value: value,
      formUrl: FORM_URL
    }).catch(() => {});
  };

  const timer = setTimeout(performUpdate, 1000);

  pendingPassiveUpdates.set(label, {
    timer,
    execute: performUpdate
  });
}


function handlePassiveRadioClick(radioEl) {
  if (_isProgrammaticFilling) return;
  const container = findQuestionContainer(radioEl);
  if (!container) return;

  const label = extractLabel(container);
  if (!label) return;

  setTimeout(() => {
    const checkedRadio = container.querySelector('[role="radio"][aria-checked="true"]');
    if (!checkedRadio) return;
    const value = (checkedRadio.getAttribute('data-value') || checkedRadio.textContent || '').trim();
    if (!value) return;

    chrome.runtime.sendMessage({
      action: 'brain_passive_learn',
      label: label,
      value: value,
      formUrl: FORM_URL
    }).catch(() => {});
  }, 150);
}

function handlePassiveCheckboxClick(checkboxEl) {
  if (_isProgrammaticFilling) return;
  const container = findQuestionContainer(checkboxEl);
  if (!container) return;

  const label = extractLabel(container);
  if (!label) return;

  setTimeout(() => {
    const checkedBoxes = Array.from(container.querySelectorAll('[role="checkbox"][aria-checked="true"]'));
    const checkedValues = checkedBoxes
      .map(box => box.getAttribute('data-value') || box.textContent || '')
      .map(s => s.trim())
      .filter(Boolean);
    if (!checkedValues.length) return;

    const value = checkedValues.join(', ');

    chrome.runtime.sendMessage({
      action: 'brain_passive_learn',
      label: label,
      value: value,
      formUrl: FORM_URL
    }).catch(() => {});
  }, 150);
}

function handlePassiveOptionClick(optionEl) {
  if (_isProgrammaticFilling) return;
  const container = lastActiveDropdownContainer;
  if (!container) return;

  const label = extractLabel(container);
  if (!label) return;

  const value = optionEl.textContent.trim();
  if (!value) return;

  chrome.runtime.sendMessage({
    action: 'brain_passive_learn',
    label: label,
    value: value,
    formUrl: FORM_URL
  }).catch(() => {});
}

function handlePassiveSelectChange(selectEl) {
  if (_isProgrammaticFilling) return;
  const container = findQuestionContainer(selectEl);
  if (!container) return;

  const label = extractLabel(container);
  if (!label) return;

  const value = selectEl.value.trim();
  if (!value) return;

  chrome.runtime.sendMessage({
    action: 'brain_passive_learn',
    label: label,
    value: value,
    formUrl: FORM_URL
  }).catch(() => {});
}

function observeAllFieldsPassively() {
  document.addEventListener('submit', flushAllPassiveUpdates);

  document.addEventListener('input', (e) => {
    const target = e.target;
    if (!target) return;
    
    const isText = target.tagName === 'INPUT' && !['radio', 'checkbox', 'submit', 'button', 'image', 'hidden', 'file'].includes(target.type);
    const isTextArea = target.tagName === 'TEXTAREA';
    const isDate = target.tagName === 'INPUT' && target.type === 'date';
    
    if (isText || isTextArea || isDate) {
      handlePassiveInputEvent(target);
    }
  });

  document.addEventListener('change', (e) => {
    const target = e.target;
    if (!target) return;
    
    if (target.tagName === 'SELECT') {
      handlePassiveSelectChange(target);
    } else if (target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && !['radio', 'checkbox', 'submit', 'button', 'image', 'hidden', 'file'].includes(target.type))) {
      handlePassiveInputEvent(target);
    }
  });

  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!target) return;

    // Flush immediately if submitting or navigating
    const submitBtn = target.closest('button, [role="button"], input[type="submit"]');
    if (submitBtn) {
      const text = (submitBtn.textContent || '').trim().toLowerCase();
      if (text.includes('submit') || text.includes('next') || text.includes('send') || text.includes('next page')) {
        flushAllPassiveUpdates();
      }
    }

    const radio = target.closest('[role="radio"]');
    if (radio) {
      handlePassiveRadioClick(radio);
      return;
    }

    const checkbox = target.closest('[role="checkbox"]');
    if (checkbox) {
      handlePassiveCheckboxClick(checkbox);
      return;
    }

    const dropdownToggle = target.closest('[aria-haspopup="listbox"], .MocG8c');
    if (dropdownToggle) {
      lastActiveDropdownContainer = findQuestionContainer(dropdownToggle);
      return;
    }

    const option = target.closest('[role="option"]');
    if (option) {
      handlePassiveOptionClick(option);
      return;
    }
  });
  // S7: update lastActiveDropdownContainer on keyboard focus so keyboard-selected
  // options are attributed to the correct question container.
  document.addEventListener('focusin', (e) => {
    const dropdownToggle = e.target.closest('[aria-haspopup="listbox"], .MocG8c');
    if (dropdownToggle) {
      lastActiveDropdownContainer = findQuestionContainer(dropdownToggle);
    }
  });
}

/* ════════════════════════════════════════════════════════════
   SECTION 3 — OVERLAY CSS (Shadow DOM isolated styles)
   ════════════════════════════════════════════════════════════ */

const OVERLAY_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :host {
    --bg:      #FFFFFF;
    --border:  #E5E5E5;
    --border-s:#D4D4D4;
    --text-p:  #0A0A0A;
    --text-s:  #525252;
    --text-t:  #A3A3A3;
    --accent:  #000000;
    --success: #16A34A;
    --error:   #DC2626;
    --warn:    #CA8A04;
    --font:    'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    --radius:  8px;
    --shadow:  0 4px 24px rgba(0,0,0,0.10), 0 1px 4px rgba(0,0,0,0.06);
  }

  /* ── Detection Toast ───────────────────────────────────── */
  .toast {
    position: fixed; top: 72px; right: 16px; width: 320px;
    background: var(--bg); border: 1px solid var(--border);
    border-radius: var(--radius); box-shadow: var(--shadow);
    font-family: var(--font); animation: slideInR 0.22s cubic-bezier(.22,1,.36,1);
    overflow: hidden; display: none; z-index: 9997;
  }
  .toast.visible { display: block; }
  @keyframes slideInR { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }

  .toast-inner { padding: 16px; display: flex; gap: 12px; align-items: flex-start; }
  .toast-icon-wrap {
    width: 36px; height: 36px; background: #F5F5F5; border-radius: 6px;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 18px;
  }
  .toast-body { flex: 1; }
  .toast-label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: var(--text-t); margin-bottom: 2px; }
  .toast-title { font-size: 14px; font-weight: 600; color: var(--text-p); line-height: 1.3; }
  .toast-desc  { font-size: 12px; color: var(--text-s); margin-top: 3px; line-height: 1.4; }
  .toast-close {
    width: 24px; height: 24px; border: none; background: transparent; cursor: pointer;
    color: var(--text-t); font-size: 16px; display: flex; align-items: center; justify-content: center;
    border-radius: 4px; transition: background .15s, color .15s; flex-shrink: 0; padding: 0;
    font-family: var(--font);
  }
  .toast-close:hover { background: #F5F5F5; color: var(--text-p); }
  .toast-actions {
    display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); background: #FAFAFA;
  }
  .toast-scanning {
    display: none; align-items: center; gap: 8px; padding: 10px 16px;
    border-top: 1px solid var(--border); font-family: var(--font); font-size: 12px; color: var(--text-s); background: #FAFAFA;
  }
  .toast-scanning.visible { display: flex; }
  .spinner {
    width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent);
    border-radius: 50%; animation: spin .7s linear infinite; flex-shrink: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Buttons ───────────────────────────────────────────── */
  .btn-ghost {
    flex: 1; padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); font-family: var(--font); font-size: 13px; font-weight: 500;
    color: var(--text-s); cursor: pointer; transition: all .15s; white-space: nowrap;
  }
  .btn-ghost:hover { border-color: var(--border-s); color: var(--text-p); background: #F5F5F5; }
  .btn-primary {
    flex: 2; padding: 8px 12px; border: 1px solid var(--accent); border-radius: 6px;
    background: var(--accent); font-family: var(--font); font-size: 13px; font-weight: 500;
    color: #FFF; cursor: pointer; transition: all .15s; white-space: nowrap;
    display: flex; align-items: center; justify-content: center; gap: 6px;
  }
  .btn-primary:hover { background: #171717; border-color: #171717; }
  .btn-primary:active { transform: scale(.98); }
  .btn-sm {
    padding: 5px 10px; border: 1px solid var(--border); border-radius: 5px;
    background: var(--bg); font-family: var(--font); font-size: 12px; font-weight: 500;
    color: var(--text-p); cursor: pointer; transition: all .15s;
  }
  .btn-sm:hover { background: #F5F5F5; border-color: var(--border-s); }
  .btn-sm.danger { color: var(--error); }
  .btn-sm.danger:hover { background: #FEF2F2; border-color: #FECACA; }

  /* ── Backdrop ──────────────────────────────────────────── */
  .backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,0.32); display: none; z-index: 9998;
    animation: fadein .2s ease;
  }
  .backdrop.visible { display: block; }
  @keyframes fadein { from { opacity: 0; } to { opacity: 1; } }

  /* ── Preview Drawer ────────────────────────────────────── */
  .drawer {
    position: fixed; top: 0; right: -420px; width: 400px; height: 100vh;
    background: var(--bg); border-left: 1px solid var(--border); z-index: 9999;
    display: flex; flex-direction: column; font-family: var(--font);
    transition: right .28s cubic-bezier(.22,1,.36,1);
  }
  .drawer.open { right: 0; }
  .drawer-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 20px 20px 16px; border-bottom: 1px solid var(--border); flex-shrink: 0;
  }
  .drawer-title    { font-size: 16px; font-weight: 600; color: var(--text-p); }
  .drawer-subtitle { font-size: 12px; color: var(--text-t); margin-top: 2px; }
  .drawer-close {
    width: 32px; height: 32px; border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); cursor: pointer; font-size: 16px; color: var(--text-s);
    display: flex; align-items: center; justify-content: center; transition: all .15s;
    flex-shrink: 0; padding: 0; font-family: var(--font);
  }
  .drawer-close:hover { background: #F5F5F5; color: var(--text-p); }

  /* Legend */
  .drawer-legend {
    display: flex; gap: 6px; padding: 10px 20px; border-bottom: 1px solid var(--border);
    flex-shrink: 0; background: #FAFAFA; flex-wrap: wrap;
  }
  .legend-chip {
    display: flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 500;
    padding: 2px 8px; border-radius: 100px; border: 1px solid;
  }
  .legend-chip.brain   { color: #1D4ED8; border-color: #BFDBFE; background: #EFF6FF; }
  .legend-chip.local   { color: #525252; border-color: var(--border); background: #F9F9F9; }
  .legend-chip.prefill { color: #92400E; border-color: #FDE68A; background: #FFFBEB; }
  .legend-chip.nomatch { color: var(--text-t); border-color: var(--border); background: #F9F9F9; }
  .legend-chip.manual  { color: #5B21B6; border-color: #DDD6FE; background: #F5F3FF; }
  .legend-chip-dot { width: 6px; height: 6px; border-radius: 50%; }
  .brain   .legend-chip-dot { background: #3B82F6; }
  .local   .legend-chip-dot { background: #94A3B8; }
  .prefill .legend-chip-dot { background: #F59E0B; }
  .nomatch .legend-chip-dot { background: #D4D4D4; }
  .manual  .legend-chip-dot { background: #7C3AED; }

  /* Drawer list */
  .drawer-list { flex: 1; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
  .drawer-list::-webkit-scrollbar { width: 4px; }
  .drawer-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  /* Drawer items */
  .drawer-item {
    display: flex; align-items: center; gap: 12px; padding: 12px 20px;
    border-bottom: 1px solid var(--border); transition: background .12s;
  }
  .drawer-item:hover { background: #FAFAFA; }
  .item-bar { width: 3px; align-self: stretch; border-radius: 2px; flex-shrink: 0; }
  .drawer-item.brain   .item-bar { background: #3B82F6; }
  .drawer-item.local   .item-bar { background: #94A3B8; }
  .drawer-item.prefill .item-bar { background: #F59E0B; }
  .drawer-item.nomatch .item-bar { background: #E5E5E5; }
  .drawer-item.manual  .item-bar { background: #7C3AED; }

  .item-info { flex: 1; min-width: 0; }
  .item-question {
    font-size: 13px; font-weight: 500; color: var(--text-p);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .item-match {
    font-size: 12px; color: var(--text-s); margin-top: 2px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    display: flex; align-items: center; gap: 4px;
  }
  .item-match .arrow  { color: var(--text-t); }
  .item-match .key    { font-weight: 500; color: var(--text-p); }
  .item-match .val    { color: #15803D; }
  .item-match .score  { color: var(--text-t); font-size: 11px; margin-left: 2px; }
  .item-match .note   { color: var(--warn); font-size: 11px; margin-left: 4px; }
  .item-nomatch-text  { color: var(--text-t); font-size: 12px; margin-top: 2px; font-style: italic; }

  /* ── Confidence dot ────────────────────────────────────── */
  .conf-dot {
    width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
    display: inline-block; vertical-align: middle; margin-right: 4px;
  }
  .conf-dot.high   { background: #22C55E; }
  .conf-dot.medium { background: #F59E0B; }
  .conf-dot.low    { background: #EF4444; }
  .conf-dot.manual { background: #7C3AED; }
  .conf-dot.local  { background: #94A3B8; }

  /* Per-item toggle */
  .item-toggle { flex-shrink: 0; }
  .toggle-label { display: flex; align-items: center; cursor: pointer; }
  .toggle-input { position: absolute; opacity: 0; width: 0; height: 0; }
  .toggle-track { width: 36px; height: 20px; background: #E5E5E5; border-radius: 10px; position: relative; transition: background .2s; }
  .toggle-input:checked + .toggle-track { background: var(--accent); }
  .toggle-thumb { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: white; box-shadow: 0 1px 3px rgba(0,0,0,.2); transition: left .2s cubic-bezier(.22,1,.36,1); }
  .toggle-input:checked + .toggle-track .toggle-thumb { left: 18px; }

  /* Drawer footer */
  .drawer-footer {
    display: flex; gap: 8px; padding: 16px 20px; border-top: 1px solid var(--border);
    flex-shrink: 0; background: #FAFAFA;
  }

  /* ── Update Proposal Toast ─────────────────────────────── */
  .update-toast {
    position: fixed; top: 16px; left: 50%; transform: translateX(-50%) translateY(-8px);
    min-width: 320px; max-width: 400px; background: var(--bg); border: 1px solid var(--border);
    border-radius: var(--radius); box-shadow: var(--shadow); padding: 14px 16px;
    font-family: var(--font); display: none; z-index: 10000;
    animation: slideDown .22s ease forwards;
  }
  .update-toast.visible { display: block; }
  @keyframes slideDown {
    from { transform: translateX(-50%) translateY(-8px); opacity: 0; }
    to   { transform: translateX(-50%) translateY(0);    opacity: 1; }
  }
  .update-toast-label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: var(--text-t); margin-bottom: 4px; }
  .update-toast-title { font-size: 13px; font-weight: 600; color: var(--text-p); }
  .update-toast-sub   { font-size: 12px; color: var(--text-s); margin-top: 2px; }
  .update-toast-vals  { display: flex; gap: 8px; align-items: center; margin: 8px 0; font-size: 12px; }
  .update-val-old { color: var(--error); text-decoration: line-through; }
  .update-val-arr { color: var(--text-t); }
  .update-val-new { color: var(--success); font-weight: 500; }
  .update-toast-actions { display: flex; gap: 8px; margin-top: 10px; }

  /* ── Result Toast ──────────────────────────────────────── */
  .result-toast {
    position: fixed; top: 72px; right: 16px; background: var(--bg);
    border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow);
    padding: 12px 16px; display: none; align-items: center; gap: 10px;
    font-family: var(--font); font-size: 13px; font-weight: 500; color: var(--text-p);
    animation: slideInR .22s cubic-bezier(.22,1,.36,1); z-index: 10000; min-width: 220px;
  }
  .result-toast.visible { display: flex; }
  .result-icon { font-size: 16px; }
  .result-sub  { font-size: 12px; font-weight: 400; color: var(--text-s); margin-top: 1px; }
`;

/* ════════════════════════════════════════════════════════════
   SECTION 4 — OVERLAY UI  (Shadow DOM)
   ════════════════════════════════════════════════════════════ */

let shadowRoot   = null;
let currentPreview = [];
let settings     = { overwrite: false, skipPreview: false, showScore: true, threshold: 72, brainThreshold: 75 };

// pending update proposal from brain
let _pendingUpdate = null;

function getOrCreateShadow() {
  if (shadowRoot) return shadowRoot;
  const host = document.createElement('div');
  host.id = 'autofill-shadow-host';
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none;';
  document.documentElement.appendChild(host);
  shadowRoot = host.attachShadow({ mode: 'open' });

  const fontLink = document.createElement('link');
  fontLink.rel  = 'stylesheet';
  fontLink.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap';
  shadowRoot.appendChild(fontLink);

  const style = document.createElement('style');
  style.textContent = OVERLAY_CSS;
  shadowRoot.appendChild(style);

  return shadowRoot;
}

function buildOverlay() {
  if (shadowRoot?.getElementById('af-toast')) return; // already built
  const sr = getOrCreateShadow();

  // Restore pointer-events on host (needed for interactive elements)
  const host = document.getElementById('autofill-shadow-host');
  if (host) host.style.pointerEvents = 'none';

  // ── Detection Toast ────────────────────────────────────────
  const toast = document.createElement('div');
  toast.className = 'toast'; toast.id = 'af-toast';
  toast.style.pointerEvents = 'auto';

  const inner = document.createElement('div'); inner.className = 'toast-inner';
  const iconWrap = document.createElement('div'); iconWrap.className = 'toast-icon-wrap'; iconWrap.textContent = '📋';
  const body   = document.createElement('div'); body.className = 'toast-body';
  const lbl    = document.createElement('div'); lbl.className = 'toast-label';   lbl.textContent = 'AutoFill';
  const title  = document.createElement('div'); title.className = 'toast-title'; title.textContent = 'Google Form detected';
  const desc   = document.createElement('div'); desc.className = 'toast-desc';   desc.textContent = 'AutoFill can fill this form with your stored information.';
  const closeBtn = document.createElement('button'); closeBtn.className = 'toast-close'; closeBtn.id = 'af-toast-close'; closeBtn.title = 'Dismiss'; closeBtn.textContent = '✕';
  body.appendChild(lbl); body.appendChild(title); body.appendChild(desc);
  inner.appendChild(iconWrap); inner.appendChild(body); inner.appendChild(closeBtn);

  const scanning = document.createElement('div'); scanning.className = 'toast-scanning'; scanning.id = 'af-scanning';
  const spinner  = document.createElement('div'); spinner.className = 'spinner';
  const scanText = document.createTextNode('Scanning form fields…');
  scanning.appendChild(spinner); scanning.appendChild(scanText);

  const actions = document.createElement('div'); actions.className = 'toast-actions'; actions.id = 'af-toast-actions';
  const btnSkip = document.createElement('button'); btnSkip.className = 'btn-ghost'; btnSkip.id = 'af-btn-dismiss'; btnSkip.textContent = 'Skip';
  const btnFill = document.createElement('button'); btnFill.className = 'btn-primary'; btnFill.id = 'af-btn-fill';   btnFill.textContent = 'Fill this form →';
  actions.appendChild(btnSkip); actions.appendChild(btnFill);

  toast.appendChild(inner); toast.appendChild(scanning); toast.appendChild(actions);
  sr.appendChild(toast);

  // ── Backdrop ───────────────────────────────────────────────
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop'; backdrop.id = 'af-backdrop'; backdrop.style.pointerEvents = 'auto';
  sr.appendChild(backdrop);

  // ── Preview Drawer ─────────────────────────────────────────
  const drawer = document.createElement('div');
  drawer.className = 'drawer'; drawer.id = 'af-drawer'; drawer.style.pointerEvents = 'auto';

  const dHeader = document.createElement('div'); dHeader.className = 'drawer-header';
  const dInfo   = document.createElement('div');
  const dTitle  = document.createElement('div'); dTitle.className = 'drawer-title';    dTitle.textContent = 'Fill Preview';
  const dSub    = document.createElement('div'); dSub.className = 'drawer-subtitle';   dSub.id = 'af-drawer-subtitle'; dSub.textContent = 'Reviewing matches…';
  const dClose  = document.createElement('button'); dClose.className = 'drawer-close'; dClose.id = 'af-drawer-close'; dClose.textContent = '✕';
  dInfo.appendChild(dTitle); dInfo.appendChild(dSub);
  dHeader.appendChild(dInfo); dHeader.appendChild(dClose);

  // Legend
  const legend = document.createElement('div'); legend.className = 'drawer-legend';
  const chips = [
    { cls: 'brain',   dot: true, text: 'Brain match'    },
    { cls: 'local',   dot: true, text: 'Local match'    },
    { cls: 'prefill', dot: true, text: 'Pre-filled'     },
    { cls: 'manual',  dot: true, text: 'Manual only'    },
    { cls: 'nomatch', dot: true, text: 'No match'       },
  ];
  chips.forEach(({ cls, text }) => {
    const chip = document.createElement('div'); chip.className = `legend-chip ${cls}`;
    const dot  = document.createElement('div'); dot.className  = 'legend-chip-dot';
    const t    = document.createTextNode(' ' + text);
    chip.appendChild(dot); chip.appendChild(t);
    legend.appendChild(chip);
  });

  const dList   = document.createElement('div'); dList.className = 'drawer-list'; dList.id = 'af-drawer-list';

  const dFooter = document.createElement('div'); dFooter.className = 'drawer-footer';
  const dCancel = document.createElement('button'); dCancel.className = 'btn-ghost';    dCancel.id = 'af-drawer-cancel';  dCancel.textContent = 'Cancel';
  const dConfirm= document.createElement('button'); dConfirm.className = 'btn-primary'; dConfirm.id = 'af-drawer-confirm'; dConfirm.textContent = 'Confirm & Fill';
  dFooter.appendChild(dCancel); dFooter.appendChild(dConfirm);

  drawer.appendChild(dHeader); drawer.appendChild(legend); drawer.appendChild(dList); drawer.appendChild(dFooter);
  sr.appendChild(drawer);

  // ── Update Proposal Toast ──────────────────────────────────
  const updateToast = document.createElement('div');
  updateToast.className = 'update-toast'; updateToast.id = 'af-update-toast'; updateToast.style.pointerEvents = 'auto';
  const uLbl   = document.createElement('div'); uLbl.className = 'update-toast-label'; uLbl.textContent = 'Brain learned';
  const uTitle = document.createElement('div'); uTitle.className = 'update-toast-title'; uTitle.id = 'af-update-title'; uTitle.textContent = '';
  const uSub   = document.createElement('div'); uSub.className = 'update-toast-sub'; uSub.textContent = 'Should AutoFill save this new value?';
  const uVals  = document.createElement('div'); uVals.className = 'update-toast-vals'; uVals.id = 'af-update-vals';
  const uActs  = document.createElement('div'); uActs.className = 'update-toast-actions';
  const uIgnore= document.createElement('button'); uIgnore.className = 'btn-sm'; uIgnore.id = 'af-update-ignore'; uIgnore.textContent = 'Ignore';
  const uSave  = document.createElement('button'); uSave.className = 'btn-sm'; uSave.id = 'af-update-save'; uSave.textContent = 'Save new value';
  uActs.appendChild(uIgnore); uActs.appendChild(uSave);
  updateToast.appendChild(uLbl); updateToast.appendChild(uTitle); updateToast.appendChild(uSub);
  updateToast.appendChild(uVals); updateToast.appendChild(uActs);
  sr.appendChild(updateToast);

  // ── Result Toast ───────────────────────────────────────────
  const resultToast = document.createElement('div');
  resultToast.className = 'result-toast'; resultToast.id = 'af-result'; resultToast.style.pointerEvents = 'auto';
  const rIcon = document.createElement('span'); rIcon.className = 'result-icon'; rIcon.id = 'af-result-icon'; rIcon.textContent = '✓';
  const rBody = document.createElement('div');
  const rText = document.createElement('div'); rText.id = 'af-result-text'; rText.textContent = 'Done';
  const rSub  = document.createElement('div'); rSub.className = 'result-sub'; rSub.id = 'af-result-sub';
  rBody.appendChild(rText); rBody.appendChild(rSub);
  resultToast.appendChild(rIcon); resultToast.appendChild(rBody);
  sr.appendChild(resultToast);

  // ── Wire events ────────────────────────────────────────────
  sr.getElementById('af-toast-close').addEventListener('click', dismissToast);
  sr.getElementById('af-btn-dismiss').addEventListener('click', dismissToast);
  sr.getElementById('af-btn-fill').addEventListener('click', startFill);
  sr.getElementById('af-drawer-close').addEventListener('click', closeDrawer);
  sr.getElementById('af-drawer-cancel').addEventListener('click', closeDrawer);
  sr.getElementById('af-backdrop').addEventListener('click', closeDrawer);
  sr.getElementById('af-drawer-confirm').addEventListener('click', confirmFill);
  sr.getElementById('af-update-ignore').addEventListener('click', dismissUpdateToast);
  sr.getElementById('af-update-save').addEventListener('click', acceptUpdate);
}

// ── Toast helpers ─────────────────────────────────────────────
function showDetectionToast() {
  buildOverlay();
  shadowRoot?.getElementById('af-toast')?.classList.add('visible');
}
function dismissToast() {
  shadowRoot?.getElementById('af-toast')?.classList.remove('visible');
}
function showScanning() {
  const sr = shadowRoot; if (!sr) return;
  sr.getElementById('af-toast-actions').style.display = 'none';
  sr.getElementById('af-scanning').classList.add('visible');
}
function hideScanning() {
  const sr = shadowRoot; if (!sr) return;
  sr.getElementById('af-toast-actions').style.display = '';
  sr.getElementById('af-scanning').classList.remove('visible');
}

// ── Drawer helpers ────────────────────────────────────────────
function closeDrawer() {
  const sr = shadowRoot; if (!sr) return;
  sr.getElementById('af-drawer').classList.remove('open');
  sr.getElementById('af-backdrop').classList.remove('visible');
}

// M3 fix: accept caller-supplied high/medium thresholds so the dot colour
// tracks the user's Brain confidence slider rather than hardcoded constants.
function _confDotClass(source, confidence, manualOnly, high = 0.75, medium = 0.50) {
  if (manualOnly) return 'manual';
  if (source === 'brain') {
    if (confidence >= high)   return 'high';
    if (confidence >= medium) return 'medium';
    return 'low';
  }
  return 'local';
}

function showDrawer(preview) {
  const sr = shadowRoot; if (!sr) return;
  const list = sr.getElementById('af-drawer-list');
  while (list.firstChild) list.removeChild(list.firstChild);

  const matched   = preview.filter(p => p.matched && !p.manualOnly).length;
  const unmatched = preview.filter(p => !p.matched).length;
  const prefilled = preview.filter(p => p.alreadyFilled && p.matched).length;
  const manual    = preview.filter(p => p.manualOnly).length;
  // M3: derive dot thresholds from the user's saved brain threshold
  const highT = (settings.brainThreshold || 75) / 100;
  const medT  = highT * 0.667;
  sr.getElementById('af-drawer-subtitle').textContent =
    `${matched} match${matched !== 1 ? 'es' : ''} · ${prefilled} pre-filled · ${unmatched} unmatched${manual > 0 ? ` · ${manual} manual-only` : ''}`;

  preview.forEach(item => {
    const row = document.createElement('div');
    let rowClass = 'drawer-item ';
    if (item.manualOnly)        rowClass += 'manual';
    else if (!item.matched)     rowClass += 'nomatch';
    else if (item.alreadyFilled)rowClass += 'prefill';
    else                        rowClass += (item.source || 'local');
    row.className = rowClass;

    const bar  = document.createElement('div'); bar.className = 'item-bar';
    const info = document.createElement('div'); info.className = 'item-info';
    const q    = document.createElement('div'); q.className = 'item-question'; q.textContent = item.questionLabel;

    const m = document.createElement('div');
    if (item.matched) {
      m.className = 'item-match';

      // Confidence dot
      const dot = document.createElement('span');
      dot.className = 'conf-dot ' + _confDotClass(item.source, item.confidence, item.manualOnly, highT, medT);
      m.appendChild(dot);

      const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '→';
      const key   = document.createElement('span'); key.className = 'key';   key.textContent = item.matchedKey;
      const colon = document.createTextNode(': ');
      const val   = document.createElement('span'); val.className = 'val';   val.textContent = item.matchedValue;
      m.appendChild(arrow); m.appendChild(key); m.appendChild(colon); m.appendChild(val);

      if (item.score > 0 && settings.showScore !== false) {
        const score = document.createElement('span'); score.className = 'score'; score.textContent = `${item.score}%`;
        m.appendChild(score);
      }
      if (item.alreadyFilled) {
        const note = document.createElement('span'); note.className = 'note'; note.textContent = '· already filled';
        m.appendChild(note);
      }
      if (item.manualOnly) {
        const note = document.createElement('span'); note.className = 'note'; note.textContent = '· manual only';
        m.appendChild(note);
      }
    } else {
      m.className = 'item-nomatch-text';
      m.textContent = 'No matching stored field';
    }

    info.appendChild(q); info.appendChild(m);

    const toggleCell = document.createElement('div'); toggleCell.className = 'item-toggle';
    if (item.matched) {
      const lbl = document.createElement('label'); lbl.className = 'toggle-label';
      const chk = document.createElement('input'); chk.type = 'checkbox'; chk.className = 'toggle-input';
      chk.id = `af-chk-${item.idx}`; chk.dataset.idx = String(item.idx);
      chk.checked = !item.alreadyFilled && !item.manualOnly;
      if (item.manualOnly) chk.disabled = true;
      const track = document.createElement('div'); track.className = 'toggle-track';
      const thumb = document.createElement('div'); thumb.className = 'toggle-thumb';
      track.appendChild(thumb); lbl.appendChild(chk); lbl.appendChild(track);
      toggleCell.appendChild(lbl);
    }

    row.appendChild(bar); row.appendChild(info); row.appendChild(toggleCell);
    list.appendChild(row);
  });

  sr.getElementById('af-backdrop').classList.add('visible');
  sr.getElementById('af-drawer').classList.add('open');
}

function showUpdateToast(concept, label, oldValue, newValue) {
  const sr = shadowRoot; if (!sr) return;
  const toast = sr.getElementById('af-update-toast');
  sr.getElementById('af-update-title').textContent = `"${concept}" changed on this form`;

  const vals = sr.getElementById('af-update-vals');
  while (vals.firstChild) vals.removeChild(vals.firstChild);
  const old = document.createElement('span'); old.className = 'update-val-old'; old.textContent = oldValue;
  const arr = document.createElement('span'); arr.className = 'update-val-arr'; arr.textContent = '→';
  const nw  = document.createElement('span'); nw.className  = 'update-val-new'; nw.textContent = newValue;
  vals.appendChild(old); vals.appendChild(arr); vals.appendChild(nw);

  toast.classList.add('visible');
}

function dismissUpdateToast() {
  shadowRoot?.getElementById('af-update-toast')?.classList.remove('visible');
  _pendingUpdate = null;
}

async function acceptUpdate() {
  if (!_pendingUpdate) { dismissUpdateToast(); return; }
  try {
    await chrome.runtime.sendMessage({
      action: 'brain_set_concept',
      key:    _pendingUpdate.concept,
      value:  _pendingUpdate.newValue,
    });
  } catch (_) {}
  dismissUpdateToast();
}

function showResult(filled, skipped, errors) {
  const sr = shadowRoot; if (!sr) return;
  const rt = sr.getElementById('af-result');
  sr.getElementById('af-result-icon').textContent = errors > 0 ? '⚠' : '✓';
  sr.getElementById('af-result-text').textContent =
    errors > 0 ? `${filled} filled, ${errors} error(s)` : `${filled} field${filled !== 1 ? 's' : ''} filled`;
  sr.getElementById('af-result-sub').textContent = skipped > 0 ? `${skipped} skipped` : '';
  rt.classList.add('visible');
  setTimeout(() => rt.classList.remove('visible'), 4500);
}

/* ════════════════════════════════════════════════════════════
   SECTION 5 — FILL FLOW
   ════════════════════════════════════════════════════════════ */

async function loadSettings() {
  const data = await chrome.storage.local.get('autofill_settings');
  return { ...settings, ...(data.autofill_settings || {}) };
}

async function scanPreview(s) {
  const thresh      = s.threshold    || 72;
  const brainThresh = s.brainThreshold || 75;

  // Load stored fields (for local fallback)
  const raw    = await chrome.storage.local.get('autofill_fields');
  const fields = raw.autofill_fields || [];

  const questions = getQuestions();
  if (!questions.length) return { error: 'no_questions', preview: [] };

  // Brain + local parallel resolution
  const items = await Promise.all(questions.map(async (container, idx) => {
    const label = extractLabel(container);
    if (!label) return null;

    const type         = detectType(container);
    const alreadyFilled = type ? isAlreadyFilled(container, type) : false;

    const resolved = await resolveMatch(label, fields, brainThresh, thresh);

    return {
      idx,
      questionLabel: label,
      type:          type || 'unknown',
      alreadyFilled,
      matched:       !!resolved,
      matchedKey:    resolved?.matchedKey   || null,
      matchedValue:  resolved?.matchedValue || null,
      alias:         resolved?.alias        || null,
      score:         resolved ? Math.round(resolved.confidence * 100) : 0,
      confidence:    resolved?.confidence   || 0,
      source:        resolved?.source       || 'local',
      manualOnly:    resolved?.manualOnly   || false,
    };
  }));

  return { error: null, preview: items.filter(Boolean) };
}

async function startFill() {
  showScanning();
  const s        = await loadSettings();
  const response = await scanPreview(s);
  hideScanning();
  dismissToast();

  if (response.error || !response.preview.length) { showResult(0, 0, 1); return; }

  currentPreview = response.preview;

  if (s.skipPreview) {
    const confirmed = currentPreview.map(m => ({ ...m, confirmed: m.matched && !m.alreadyFilled && !m.manualOnly }));
    const res = await executeFill(confirmed, s);
    await sendBrainLearn(confirmed);
    observeUserEdits(confirmed.filter(m => m.confirmed));
    showResult(res.filled, res.skipped, res.errors);
  } else {
    showDrawer(currentPreview);
  }
}

async function confirmFill() {
  closeDrawer();
  const sr = shadowRoot;
  const s  = await loadSettings();

  const confirmed = currentPreview.map(item => {
    const chk = sr?.getElementById(`af-chk-${item.idx}`);
    return { ...item, confirmed: !!(chk && chk.checked) };
  });

  const res = await executeFill(confirmed, s);
  await sendBrainLearn(confirmed);
  observeUserEdits(confirmed.filter(m => m.confirmed && m.matched));
  showResult(res.filled, res.skipped, res.errors);
}

/* ════════════════════════════════════════════════════════════
   SECTION 6 — INIT + MESSAGE LISTENER
   ════════════════════════════════════════════════════════════ */

function waitForFormToRender() {
  return new Promise(resolve => {
    const selectors = ['[data-params]','.freebirdFormviewerViewItemList','.Qr7Oae',
      '.freebirdFormviewerComponentsQuestionBaseRoot'];
    const isForm = () => selectors.some(s => document.querySelector(s));

    if (isForm()) { resolve(true); return; }

    const obs = new MutationObserver(() => { if (isForm()) { obs.disconnect(); resolve(true); } });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); resolve(false); }, 12000);
  });
}

async function main() {
  observeAllFieldsPassively();
  const found = await waitForFormToRender();
  if (found) showDetectionToast();


  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'show_prompt') {
      showDetectionToast();
      sendResponse({ ok: true });
      return true;
    }

    // Brain proposes an update (user edited a filled field)
    if (msg.action === 'brain_propose_update') {
      _pendingUpdate = msg;
      showUpdateToast(msg.concept, msg.label, msg.oldValue, msg.newValue);
      sendResponse({ ok: true });
      return true;
    }
  });
}
