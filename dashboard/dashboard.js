/* ============================================================
   AutoFill — dashboard.js
   Full-page dashboard: CRUD, settings, export/import, tab nav
   FIX #6: chrome.storage.local
   FIX #8: createElement / textContent only (no innerHTML)
   FIX #10: lastError checks on every write
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

// ── State ────────────────────────────────────────────────────
let fields   = [];
let settings = { overwrite: false, skipPreview: false, showScore: true, threshold: 72 };

// ── DOM refs: fields tab ─────────────────────────────────────
const fieldsBody     = document.getElementById('fieldsBody');
const tableEmpty     = document.getElementById('tableEmpty');
const fieldCount     = document.getElementById('fieldCount');
const btnAddField    = document.getElementById('btnAddField');
const btnAddFieldEmpty = document.getElementById('btnAddFieldEmpty');
const btnSave        = document.getElementById('btnSave');
const statusBar      = document.getElementById('statusBar');
const statusDot      = document.getElementById('statusDot');
const statusMsg      = document.getElementById('statusMsg');

// ── DOM refs: settings tab ───────────────────────────────────
const sOverwrite    = document.getElementById('sOverwrite');
const sSkipPreview  = document.getElementById('sSkipPreview');
const sShowScore    = document.getElementById('sShowScore');
const sThreshold    = document.getElementById('sThreshold');
const thresholdDisp = document.getElementById('thresholdDisplay');
const btnExport     = document.getElementById('btnExport');
const btnImport     = document.getElementById('btnImport');
const importFile    = document.getElementById('importFile');
const btnClear      = document.getElementById('btnClear');

// ══════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  await loadAll();
  renderFields();
  applySettings();
  wireNavigation();
  wireSettings();
  wireDataManagement();
  // Sync existing My Info fields to Brain engine on startup
  // (covers users who saved fields before v3 Brain engine was added)
  _syncFieldsToBrain(fields).catch(() => {});
});

// ══════════════════════════════════════════════════════════════
//  STORAGE — chrome.storage.local (FIX #6)
// ══════════════════════════════════════════════════════════════
async function loadAll() {
  const data = await chrome.storage.local.get(['autofill_fields', 'autofill_settings']);

  if (data.autofill_fields && data.autofill_fields.length > 0) {
    fields = data.autofill_fields;
  } else {
    fields = [...DEFAULT_FIELDS];
    await saveFields(true); // silent first-time save
  }

  if (data.autofill_settings) {
    settings = { ...settings, ...data.autofill_settings };
  }
}

// FIX #10: always check lastError
async function saveFields(silent = false) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ autofill_fields: fields }, () => {
      if (chrome.runtime.lastError) {
        showStatus('error', 'Save failed: ' + chrome.runtime.lastError.message);
        resolve();
      } else {
        if (!silent) showStatus('success', 'Changes saved');
        // Sync to Brain engine — makes aliases actually resolve
        _syncFieldsToBrain(fields).then(resolve);
      }
    });
  });
}

/**
 * Syncs every My Info field into af_concepts so the Brain's seeded
 * alias dictionary can resolve them.
 *
 * e.g. "Full Name" → concept key "full name" → af_concepts["full name"] = {value: <user value>}
 * e.g. "Phone"     → concept key "phone"     → af_concepts["phone"]     = {value: <user value>}
 *
 * The Brain seed already maps:
 *   "name"           → "full name"   concept  ✓
 *   "contact number" → "phone"       concept  ✓
 *   etc.
 *
 * Without this sync af_concepts is empty and the brain always returns null.
 */
async function _syncFieldsToBrain(fieldList) {
  if (!fieldList || !fieldList.length) return;
  for (const { label, value } of fieldList) {
    if (!label || !value) continue;
    // Normalise label → concept key (same as brain.js normalise())
    const key = label.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!key) continue;
    try {
      await chrome.runtime.sendMessage({
        action: 'brain_set_concept',
        key,
        value,
        fromMyInfo: true,   // tells brain-api NOT to reverse-sync back to My Info
      });
    } catch (_) {
      // Service worker may be cold-starting; retry once after 500ms
      await new Promise(r => setTimeout(r, 500));
      try {
        await chrome.runtime.sendMessage({
          action: 'brain_set_concept',
          key,
          value,
          fromMyInfo: true,
        });
      } catch (_) { /* give up gracefully */ }
    }
  }
}


async function saveSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ autofill_settings: settings }, () => {
      if (chrome.runtime.lastError)
        console.warn('[AutoFill] Settings save error:', chrome.runtime.lastError.message);
      resolve();
    });
  });
}

// ══════════════════════════════════════════════════════════════
//  RENDER FIELDS — FIX #8: createElement + textContent only
// ══════════════════════════════════════════════════════════════
function renderFields() {
  // Safe clear (no innerHTML)
  while (fieldsBody.firstChild) fieldsBody.removeChild(fieldsBody.firstChild);

  if (fields.length === 0) {
    tableEmpty.classList.remove('hidden');
    document.getElementById('fieldTable').querySelector('thead').style.display = 'none';
  } else {
    tableEmpty.classList.add('hidden');
    document.getElementById('fieldTable').querySelector('thead').style.display = '';
    fields.forEach((f, i) => fieldsBody.appendChild(createRow(f.label, f.value, i)));
  }

  // Update counter
  fieldCount.textContent = `${fields.length} field${fields.length !== 1 ? 's' : ''}`;
}

// FIX #8: All DOM via createElement + .textContent
function createRow(label, value, index) {
  const tr = document.createElement('tr');
  tr.className = 'field-row';
  tr.dataset.index = String(index);

  // Label cell
  const tdLabel = document.createElement('td');
  const inputLabel = document.createElement('input');
  inputLabel.type        = 'text';
  inputLabel.className   = 'field-input';
  inputLabel.value       = label;         // .value — not innerHTML
  inputLabel.placeholder = 'Field name…';
  inputLabel.setAttribute('aria-label', 'Field name');
  inputLabel.addEventListener('input', () => syncRow(tr));
  tdLabel.appendChild(inputLabel);

  // Value cell
  const tdValue = document.createElement('td');
  const inputValue = document.createElement('input');
  inputValue.type        = 'text';
  inputValue.className   = 'field-input';
  inputValue.value       = value;         // .value — not innerHTML
  inputValue.placeholder = 'Value…';
  inputValue.setAttribute('aria-label', 'Field value');
  inputValue.addEventListener('input', () => syncRow(tr));
  tdValue.appendChild(inputValue);

  // Actions cell
  const tdActions = document.createElement('td');
  const actionsWrap = document.createElement('div');
  actionsWrap.className = 'row-actions';
  const delBtn = document.createElement('button');
  delBtn.className   = 'btn-row-del';
  delBtn.title       = 'Delete this field';
  delBtn.textContent = '×';              // textContent — not innerHTML
  delBtn.addEventListener('click', () => deleteRow(index));
  actionsWrap.appendChild(delBtn);
  tdActions.appendChild(actionsWrap);

  tr.appendChild(tdLabel);
  tr.appendChild(tdValue);
  tr.appendChild(tdActions);
  return tr;
}

function syncRow(tr) {
  const idx    = parseInt(tr.dataset.index, 10);
  const inputs = tr.querySelectorAll('input');
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
  renderFields();
  // Focus the label input of the new row
  const rows = fieldsBody.querySelectorAll('.field-row');
  const lastRow = rows[rows.length - 1];
  if (lastRow) {
    const input = lastRow.querySelector('input');
    if (input) { input.focus(); input.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  }
}

function deleteRow(index) {
  const rows = fieldsBody.querySelectorAll('.field-row');
  const row = rows[index];
  if (row) {
    row.style.transition = 'opacity 0.16s, transform 0.16s';
    row.style.opacity    = '0';
    row.style.transform  = 'translateX(8px)';
    setTimeout(() => {
      fields.splice(index, 1);
      renderFields();
    }, 160);
  }
}

function collectFields() {
  const rows = fieldsBody.querySelectorAll('.field-row');
  const out  = [];
  rows.forEach(row => {
    const inputs = row.querySelectorAll('input');
    const lbl = inputs[0]?.value.trim() || '';
    const val = inputs[1]?.value.trim() || '';
    if (lbl || val) out.push({ label: lbl, value: val });
  });
  return out;
}

// ── Save button ───────────────────────────────────────────────
btnSave.addEventListener('click', async () => {
  fields = collectFields();
  await saveFields();
});

// ── Add field buttons ─────────────────────────────────────────
btnAddField.addEventListener('click', addRow);
btnAddFieldEmpty.addEventListener('click', addRow);

// ══════════════════════════════════════════════════════════════
//  TAB NAVIGATION
// ══════════════════════════════════════════════════════════════
function wireNavigation() {
  let brainTabInit = false;

  document.querySelectorAll('.nav-item').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      const tab = link.dataset.tab;
      if (!tab) return;

      // Update nav active state
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      link.classList.add('active');

      // Switch pane
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      const pane = document.getElementById('pane' + capitalise(tab));
      if (pane) pane.classList.add('active');

      // Lazy-init Brain tab on first visit
      if (tab === 'brain' && !brainTabInit && typeof initBrainTab === 'function') {
        brainTabInit = true;
        initBrainTab();
      }
    });
  });
}


function capitalise(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ══════════════════════════════════════════════════════════════
//  SETTINGS
// ══════════════════════════════════════════════════════════════
function applySettings() {
  sOverwrite.checked   = settings.overwrite;
  sSkipPreview.checked = settings.skipPreview;
  sShowScore.checked   = settings.showScore;
  sThreshold.value     = settings.threshold;
  thresholdDisp.textContent = settings.threshold + '%';
}

function wireSettings() {
  sThreshold.addEventListener('input', () => {
    settings.threshold = parseInt(sThreshold.value, 10);
    thresholdDisp.textContent = settings.threshold + '%';
    saveSettings();
  });

  [sOverwrite, sSkipPreview, sShowScore].forEach(el => {
    el.addEventListener('change', () => {
      settings.overwrite    = sOverwrite.checked;
      settings.skipPreview  = sSkipPreview.checked;
      settings.showScore    = sShowScore.checked;
      saveSettings();
    });
  });
}

// ══════════════════════════════════════════════════════════════
//  DATA MANAGEMENT
// ══════════════════════════════════════════════════════════════
function wireDataManagement() {
  // Export
  btnExport.addEventListener('click', () => {
    const data = collectFields();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'autofill-data.json'; a.click();
    URL.revokeObjectURL(url);
  });

  // Import
  btnImport.addEventListener('click', () => importFile.click());

  importFile.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const imported = JSON.parse(text);
      if (!Array.isArray(imported)) throw new Error('Expected JSON array');
      // Validate each entry — prevent malformed or XSS payloads
      fields = imported
        .filter(f => typeof f.label === 'string' && typeof f.value === 'string')
        .map(f => ({ label: f.label.slice(0, 200).trim(), value: f.value.slice(0, 500).trim() }));
      await saveFields(true);
      renderFields();
      showStatus('success', `Imported ${fields.length} field(s)`);
    } catch {
      showStatus('error', 'Invalid JSON file. Check format.');
    }
    importFile.value = '';
  });

  // Clear all
  btnClear.addEventListener('click', async () => {
    if (!confirm('Clear all stored fields? This cannot be undone.')) return;
    fields = [];
    await saveFields(true);
    renderFields();
    showStatus('error', 'All fields cleared');
  });
}

// ══════════════════════════════════════════════════════════════
//  STATUS BAR
// ══════════════════════════════════════════════════════════════
let statusTimer = null;

function showStatus(type, message) {
  statusBar.className = 'status-bar ' + type;
  statusMsg.textContent = message;    // textContent — FIX #8
  statusBar.classList.remove('hidden');

  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusBar.classList.add('hidden');
  }, 3500);
}
