/* ============================================================
   AutoFill — popup.js  (Hardened v2)
   Fixes: storage.local, lastError guards, no innerHTML (XSS safe),
   two-phase scan→preview→confirm→fill, default threshold 72%
   ============================================================ */

'use strict';

// ── Default sample data ──────────────────────────────────────
const DEFAULT_FIELDS = [
  { label: 'Full Name',     value: 'Jane Doe'            },
  { label: 'Email',         value: 'jane@example.com'    },
  { label: 'Phone',         value: '+1 555 000 0000'     },
  { label: 'Date of Birth', value: '01/01/2000'          },
  { label: 'Address',       value: '123 Main St, City'   },
  { label: 'Organization',  value: 'Example Corp'        },
];

// ── DOM refs: main view ──────────────────────────────────────
const fieldsContainer  = document.getElementById('fieldsContainer');
const btnAddField      = document.getElementById('btnAddField');
const btnSave          = document.getElementById('btnSave');
const btnFill          = document.getElementById('btnFill');
const statusBanner     = document.getElementById('statusBanner');
const statusIcon       = document.getElementById('statusIcon');
const statusText       = document.getElementById('statusText');
const statusLed        = document.getElementById('statusLed');

// ── DOM refs: settings ───────────────────────────────────────
const settingOverwrite   = document.getElementById('settingOverwrite');
const settingShowScore   = document.getElementById('settingShowScore');
const settingSkipPreview = document.getElementById('settingSkipPreview');
const settingThreshold   = document.getElementById('settingThreshold');
const thresholdVal       = document.getElementById('thresholdVal');
const btnExport          = document.getElementById('btnExport');
const btnImport          = document.getElementById('btnImport');
const importFile         = document.getElementById('importFile');
const btnClearAll        = document.getElementById('btnClearAll');

// ── DOM refs: preview overlay ────────────────────────────────
const previewOverlay    = document.getElementById('previewOverlay');
const previewList       = document.getElementById('previewList');
const previewSubtitle   = document.getElementById('previewSubtitle');
const btnPreviewClose   = document.getElementById('btnPreviewClose');
const btnPreviewCancel  = document.getElementById('btnPreviewCancel');
const btnPreviewConfirm = document.getElementById('btnPreviewConfirm');

// ── State ────────────────────────────────────────────────────
let fields   = [];
let settings = {
  overwrite:    false,
  showScore:    true,
  skipPreview:  false,
  threshold:    72,    // FIX #2: raised from 45 to 72
};

// Holds the scan results between Phase 1 and Phase 2
let currentPreview = [];

// ══════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  await loadAll();
  renderFields();
  applySettings();
  setLed('idle');
});

// ══════════════════════════════════════════════════════════════
//  STORAGE  (FIX #6: chrome.storage.local everywhere)
// ══════════════════════════════════════════════════════════════
async function loadAll() {
  // FIX #6: use .local not .sync — PII stays on-device
  const data = await chrome.storage.local.get(['autofill_fields', 'autofill_settings']);

  if (data.autofill_fields && data.autofill_fields.length > 0) {
    fields = data.autofill_fields;
  } else {
    fields = [...DEFAULT_FIELDS];
    await saveFieldsToStorage();
  }

  if (data.autofill_settings) {
    settings = { ...settings, ...data.autofill_settings };
  }
}

async function saveFieldsToStorage() {
  // FIX #10: always check lastError after storage write
  return new Promise((resolve) => {
    chrome.storage.local.set({ autofill_fields: fields }, () => {
      if (chrome.runtime.lastError) {
        showBanner('error', '✖', 'Save failed: ' + chrome.runtime.lastError.message);
      }
      resolve();
    });
  });
}

async function saveSettingsToStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ autofill_settings: settings }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[AutoFill] Settings save error:', chrome.runtime.lastError.message);
      }
      resolve();
    });
  });
}

// ══════════════════════════════════════════════════════════════
//  RENDER FIELDS
//  FIX #8: No innerHTML — all DOM construction via createElement
//          to prevent XSS from stored label/value strings
// ══════════════════════════════════════════════════════════════
function renderFields() {
  // Safe: remove all children without innerHTML
  while (fieldsContainer.firstChild) {
    fieldsContainer.removeChild(fieldsContainer.firstChild);
  }
  fields.forEach((f, i) => {
    fieldsContainer.appendChild(createRow(f.label, f.value, i));
  });
}

function createRow(label, value, index) {
  const row = document.createElement('div');
  row.className = 'field-row';
  row.dataset.index = String(index);

  // Label input
  const labelWrap  = document.createElement('div');
  labelWrap.className = 'input-label-wrap';
  const labelInput = document.createElement('input');
  labelInput.type        = 'text';
  labelInput.value       = label;   // Safe: .value assignment, not innerHTML
  labelInput.placeholder = 'Field name…';
  labelInput.setAttribute('aria-label', 'Field name');
  labelInput.addEventListener('input', () => syncRow(row));

  // Value input
  const valueWrap  = document.createElement('div');
  valueWrap.className = 'input-value-wrap';
  const valueInput = document.createElement('input');
  valueInput.type        = 'text';
  valueInput.value       = value;   // Safe: .value assignment
  valueInput.placeholder = 'Value…';
  valueInput.setAttribute('aria-label', 'Field value');
  valueInput.addEventListener('input', () => syncRow(row));

  // Delete button — FIX #8: text via textContent
  const delBtn = document.createElement('button');
  delBtn.className   = 'btn-del';
  delBtn.title       = 'Remove this field';
  delBtn.textContent = '✕';        // Safe: textContent
  delBtn.addEventListener('click', () => deleteRow(index));

  labelWrap.appendChild(labelInput);
  valueWrap.appendChild(valueInput);
  row.appendChild(labelWrap);
  row.appendChild(valueWrap);
  row.appendChild(delBtn);

  return row;
}

function syncRow(row) {
  const idx    = parseInt(row.dataset.index, 10);
  const inputs = row.querySelectorAll('input');
  if (fields[idx]) {
    fields[idx].label = inputs[0].value;
    fields[idx].value = inputs[1].value;
  }
}

// ══════════════════════════════════════════════════════════════
//  CRUD
// ══════════════════════════════════════════════════════════════
function addRow() {
  fields.push({ label: '', value: '' });
  const idx = fields.length - 1;
  const row = createRow('', '', idx);
  fieldsContainer.appendChild(row);
  setTimeout(() => { const inp = row.querySelector('input'); if (inp) inp.focus(); }, 50);
}

function deleteRow(index) {
  const rows = fieldsContainer.querySelectorAll('.field-row');
  if (rows[index]) {
    rows[index].style.transition = 'opacity 0.18s, transform 0.18s';
    rows[index].style.opacity   = '0';
    rows[index].style.transform = 'translateX(12px)';
    setTimeout(() => { fields.splice(index, 1); renderFields(); }, 190);
  }
}

function collectFields() {
  const rows = fieldsContainer.querySelectorAll('.field-row');
  const out  = [];
  rows.forEach(row => {
    const inputs = row.querySelectorAll('input');
    const lbl = inputs[0] ? inputs[0].value.trim() : '';
    const val = inputs[1] ? inputs[1].value.trim() : '';
    if (lbl || val) out.push({ label: lbl, value: val });
  });
  return out;
}

// ══════════════════════════════════════════════════════════════
//  SAVE
// ══════════════════════════════════════════════════════════════
btnSave.addEventListener('click', async () => {
  fields = collectFields();
  await saveFieldsToStorage();
  showBanner('success', '✔', 'Data saved successfully!');
  flashButton(btnSave);
  setLed('success');
  setTimeout(() => setLed('idle'), 3000);
});

// ══════════════════════════════════════════════════════════════
//  SCAN FORM (Phase 1) → show preview
// ══════════════════════════════════════════════════════════════
btnFill.addEventListener('click', async () => {
  // Save pending changes first
  fields = collectFields();
  await saveFieldsToStorage();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url || !tab.url.includes('docs.google.com/forms')) {
    showBanner('error', '✖', 'Please open a Google Form first.');
    setLed('error');
    return;
  }

  setLed('partial');
  showBanner('', '⏳', 'Scanning form…');

  try {
    // Ensure content script is present
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/content.js'],
    }).catch(() => {}); // already injected — ignore

    const response = await chrome.tabs.sendMessage(tab.id, {
      action:   'scan',
      settings: settings,
    });

    if (!response) {
      showBanner('error', '✖', 'No response. Try refreshing the form page.');
      setLed('error');
      return;
    }

    if (response.error === 'no_fields') {
      showBanner('error', '✖', 'No stored fields found. Add data in My Info tab.');
      setLed('error');
      return;
    }

    if (response.error === 'no_questions') {
      showBanner('error', '✖', 'No form questions detected on this page.');
      setLed('error');
      return;
    }

    currentPreview = response.preview || [];
    statusBanner.classList.add('hidden');

    // If user opted to skip preview, fill immediately
    if (settings.skipPreview) {
      await runFill(tab.id, currentPreview.map(m => ({ ...m, confirmed: m.matched && !m.alreadyFilled })));
      return;
    }

    // Otherwise, show preview panel (FIX #4)
    showPreviewPanel(currentPreview);

  } catch (err) {
    showBanner('error', '✖', 'Could not reach the page. Refresh and try again.');
    setLed('error');
    console.error('[AutoFill]', err);
  }
});

// ══════════════════════════════════════════════════════════════
//  PREVIEW PANEL — FIX #4
// ══════════════════════════════════════════════════════════════
function showPreviewPanel(preview) {
  // Clear previous items safely (no innerHTML)
  while (previewList.firstChild) previewList.removeChild(previewList.firstChild);

  const matched   = preview.filter(p => p.matched).length;
  const unmatched = preview.filter(p => !p.matched).length;
  const prefilled = preview.filter(p => p.alreadyFilled && p.matched).length;

  // Safe textContent for subtitle
  previewSubtitle.textContent =
    `${matched} match${matched !== 1 ? 'es' : ''} · ${prefilled} pre-filled · ${unmatched} unmatched`;

  preview.forEach(item => {
    const el = buildPreviewItem(item);
    previewList.appendChild(el);
  });

  previewOverlay.classList.remove('hidden');
}

function buildPreviewItem(item) {
  const row = document.createElement('div');

  // Determine row class
  let cls = 'preview-item ';
  if (!item.matched)              cls += 'nomatch';
  else if (item.alreadyFilled)    cls += 'prefilled';
  else                            cls += 'match';
  row.className = cls;

  // Stamp icon
  const stamp = document.createElement('div');
  stamp.className = 'preview-item-stamp';
  stamp.textContent = !item.matched ? '✖' : item.alreadyFilled ? '⏭' : '✔';

  // Info block — FIX #8: textContent throughout, never innerHTML
  const info = document.createElement('div');
  info.className = 'preview-item-info';

  const qLabel = document.createElement('div');
  qLabel.className = 'preview-q-label';
  qLabel.textContent = item.questionLabel;   // Safe

  const matchLine = document.createElement('div');
  matchLine.className = 'preview-match-line';

  if (item.matched) {
    const arrow = document.createElement('span');
    arrow.className = 'preview-arrow';
    arrow.textContent = '→ ';

    const key = document.createElement('strong');
    key.textContent = item.matchedKey;       // Safe

    const colon = document.createTextNode(': ');

    const val = document.createElement('span');
    val.className = 'preview-value';
    val.textContent = item.matchedValue;     // Safe

    matchLine.appendChild(arrow);
    matchLine.appendChild(key);
    matchLine.appendChild(colon);
    matchLine.appendChild(val);

    if (settings.showScore) {
      const score = document.createElement('span');
      score.className = 'preview-score';
      score.textContent = ` (${item.score}%)`;  // Safe
      matchLine.appendChild(score);
    }

    if (item.alreadyFilled) {
      const note = document.createElement('span');
      note.className = 'preview-note';
      note.textContent = ' · already filled';
      matchLine.appendChild(note);
    }
  } else {
    matchLine.className += ' preview-no-match-text';
    matchLine.textContent = 'No matching stored field';
  }

  info.appendChild(qLabel);
  info.appendChild(matchLine);

  // Confirm toggle (only for matched, unfilled items)
  const toggleCell = document.createElement('div');
  toggleCell.className = 'preview-toggle-cell';

  if (item.matched) {
    const lbl = document.createElement('label');
    lbl.className = 'toggle-wrap preview-toggle-wrap';

    const chk = document.createElement('input');
    chk.type    = 'checkbox';
    chk.id      = `previewChk_${item.idx}`;
    chk.dataset.idx = String(item.idx);
    // Default: checked if matched and not already filled
    chk.checked = !item.alreadyFilled;

    const track = document.createElement('div');
    track.className = 'toggle-track';
    const thumb = document.createElement('div');
    thumb.className = 'toggle-thumb';
    track.appendChild(thumb);

    lbl.appendChild(chk);
    lbl.appendChild(track);
    toggleCell.appendChild(lbl);
  }

  row.appendChild(stamp);
  row.appendChild(info);
  row.appendChild(toggleCell);

  return row;
}

// ── Preview close / cancel ────────────────────────────────────
[btnPreviewClose, btnPreviewCancel].forEach(btn => {
  btn.addEventListener('click', () => {
    previewOverlay.classList.add('hidden');
    setLed('idle');
    showBanner('', '⚠', 'Fill cancelled.');
  });
});

// ── Preview confirm → Phase 2: fill ──────────────────────────
btnPreviewConfirm.addEventListener('click', async () => {
  previewOverlay.classList.add('hidden');

  // Build the confirmed matches list from checkbox state
  const confirmedMatches = currentPreview.map(item => {
    const chk = document.getElementById(`previewChk_${item.idx}`);
    return {
      ...item,
      confirmed: !!(chk && chk.checked),
    };
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  showBanner('', '⏳', 'Filling…');
  setLed('partial');

  await runFill(tab.id, confirmedMatches);
});

async function runFill(tabId, confirmedMatches) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action:   'fill',
      matches:  confirmedMatches,
      settings: settings,
    });

    if (!response) {
      showBanner('error', '✖', 'Fill error — try refreshing the page.');
      setLed('error');
      return;
    }

    const { filled, skipped, errors } = response;

    if (filled === 0 && errors === 0) {
      showBanner('partial', '⚠', `Nothing filled. ${skipped} field(s) skipped.`);
      setLed('partial');
    } else if (errors > 0) {
      showBanner('partial', '⚠', `${filled} filled · ${skipped} skipped · ${errors} error(s).`);
      setLed('partial');
    } else {
      showBanner('success', '✔', `${filled} field(s) filled · ${skipped} skipped.`);
      setLed('success');
    }
  } catch (e) {
    showBanner('error', '✖', 'Fill failed. Refresh and try again.');
    setLed('error');
  }

  setTimeout(() => setLed('idle'), 5000);
}

// ══════════════════════════════════════════════════════════════
//  ADD FIELD
// ══════════════════════════════════════════════════════════════
btnAddField.addEventListener('click', addRow);

// ══════════════════════════════════════════════════════════════
//  TAB SWITCHING
// ══════════════════════════════════════════════════════════════
window.switchTab = function(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(p => p.classList.add('hidden'));
  document.getElementById('tab'   + cap(name)).classList.add('active');
  document.getElementById('panel' + cap(name)).classList.remove('hidden');
};

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ══════════════════════════════════════════════════════════════
//  SETTINGS
// ══════════════════════════════════════════════════════════════
function applySettings() {
  settingOverwrite.checked   = settings.overwrite;
  settingShowScore.checked   = settings.showScore;
  settingSkipPreview.checked = settings.skipPreview;
  settingThreshold.value     = settings.threshold;
  thresholdVal.textContent   = settings.threshold + '%';
}

settingThreshold.addEventListener('input', () => {
  settings.threshold = parseInt(settingThreshold.value, 10);
  thresholdVal.textContent = settings.threshold + '%';
  saveSettingsToStorage();
});

[settingOverwrite, settingShowScore, settingSkipPreview].forEach(el => {
  el.addEventListener('change', () => {
    settings.overwrite    = settingOverwrite.checked;
    settings.showScore    = settingShowScore.checked;
    settings.skipPreview  = settingSkipPreview.checked;
    saveSettingsToStorage();
  });
});

// ══════════════════════════════════════════════════════════════
//  EXPORT / IMPORT / CLEAR
// ══════════════════════════════════════════════════════════════
btnExport.addEventListener('click', () => {
  const f    = collectFields();
  const blob = new Blob([JSON.stringify(f, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'autofill-data.json';
  a.click();
  URL.revokeObjectURL(url);
});

btnImport.addEventListener('click', () => importFile.click());

importFile.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text     = await file.text();
    const imported = JSON.parse(text);
    if (!Array.isArray(imported)) throw new Error('Expected an array');
    // Validate each entry has label & value (prevent malformed imports)
    fields = imported
      .filter(f => typeof f.label === 'string' && typeof f.value === 'string')
      .map(f => ({ label: f.label.trim(), value: f.value.trim() }));
    await saveFieldsToStorage();
    renderFields();
    showBanner('success', '✔', `Imported ${fields.length} field(s).`);
    setLed('success');
  } catch {
    showBanner('error', '✖', 'Invalid JSON file. Check format.');
    setLed('error');
  }
  importFile.value = '';
});

btnClearAll.addEventListener('click', async () => {
  if (!confirm('Clear all stored fields? This cannot be undone.')) return;
  fields = [];
  await saveFieldsToStorage();
  renderFields();
  showBanner('partial', '⚠', 'All fields cleared.');
  setLed('partial');
});

// ══════════════════════════════════════════════════════════════
//  UI HELPERS
// ══════════════════════════════════════════════════════════════
function showBanner(type, icon, text) {
  statusBanner.className = 'status-banner';
  if (type) statusBanner.classList.add(type);
  statusBanner.classList.remove('hidden');
  statusIcon.textContent = icon;  // Safe: textContent
  statusText.textContent = text;  // Safe: textContent — FIX #8
}

function setLed(state) {
  statusLed.className = 'led led-' + state;
}

function flashButton(btn) {
  btn.style.transition = 'filter 0.1s';
  btn.style.filter     = 'brightness(1.4)';
  setTimeout(() => { btn.style.filter = ''; }, 180);
}
