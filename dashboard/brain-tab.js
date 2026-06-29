/* ============================================================
   AutoFill v3 — dashboard/brain-tab.js
   Brain tab controller — plain global script (no ES modules).
   Loaded via <script src="brain-tab.js"> after dashboard.js.
   Entry: initBrainTab() is called lazily by wireNavigation()
          on first click of the Brain nav item.

   Responsibilities:
     - Render concepts table (createElement/textContent only)
     - Expandable alias chips + URL override rows per concept
     - Confidence bar (green ≥75 / yellow 50–75 / red <50)
     - Manual-only toggle per concept row
     - Inline value edit (Edit → editable input → Save)
     - Delete concept with confirmation
     - Status bar: concept count · alias count · storage MB
     - Confidence threshold slider → autofill_settings.brainThreshold
     - Auto-update toggle → autofill_settings.brainAutoUpdate
     - Export Brain JSON / Import Brain JSON (merge mode)
     - Reset Brain with confirmation
   ============================================================ */

'use strict';

/* ── State ─────────────────────────────────────────────────── */
let _brainConcepts  = [];   // last loaded concept list
let _brainAliasCount = 0;   // total aliases across all concepts

/* ── Entry point ───────────────────────────────────────────── */
function initBrainTab() {
  _wireBrainSettings();
  _wireBrainDataActions();
  _loadAndRenderBrain();
}

/* ════════════════════════════════════════════════════════════
   LOAD & RENDER
   ════════════════════════════════════════════════════════════ */

async function _loadAndRenderBrain() {
  try {
    const res = await chrome.runtime.sendMessage({ action: 'brain_get_concepts' });
    if (!res || !res.ok) { _showBrainError('Failed to load brain data'); return; }
    _brainConcepts = res.concepts || [];
    _brainAliasCount = _brainConcepts.reduce((s, c) => s + (c.aliases?.length || 0), 0);
    renderConceptsTable(_brainConcepts);
    _updateStatusBar();
  } catch (e) {
    _showBrainError('Brain engine unavailable: ' + e.message);
  }
}

function renderConceptsTable(concepts) {
  const body  = document.getElementById('brainTableBody');
  const empty = document.getElementById('brainEmpty');
  if (!body || !empty) return;

  // Safe DOM clear
  while (body.firstChild) body.removeChild(body.firstChild);

  if (!concepts || concepts.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  concepts.forEach(concept => {
    // ── Main row ──────────────────────────────────────────────
    const row = document.createElement('div');
    row.className = 'brain-concept-row';
    row.dataset.key = concept.key;

    // Expand panel (hidden by default, toggled on row click)
    const expandPanel = document.createElement('div');
    expandPanel.className = 'brain-expand-panel';
    expandPanel.id = 'brain-expand-' + _safeId(concept.key);

    // Row inner
    const inner = document.createElement('div');
    inner.className = 'brain-row-inner';

    // ── Concept key cell ──────────────────────────────────────
    const keyCell = document.createElement('div');
    keyCell.className = 'brain-td brain-td-concept';
    const keyText = document.createElement('span');
    keyText.className = 'brain-concept-key';
    keyText.textContent = concept.key;
    const expandCaret = document.createElement('span');
    expandCaret.className = 'brain-caret';
    expandCaret.textContent = '›';
    keyCell.appendChild(expandCaret);
    keyCell.appendChild(keyText);

    // ── Value cell ────────────────────────────────────────────
    const valCell = document.createElement('div');
    valCell.className = 'brain-td brain-td-value';
    const valDisplay = document.createElement('span');
    valDisplay.className = 'brain-value-display';
    valDisplay.textContent = concept.value || '—';
    const valInput = document.createElement('input');
    valInput.type = 'text';
    valInput.className = 'brain-value-input hidden';
    valInput.value = concept.value || '';
    valInput.placeholder = 'Enter value…';
    valCell.appendChild(valDisplay);
    valCell.appendChild(valInput);

    // ── Confidence bar cell ───────────────────────────────────
    const confCell = document.createElement('div');
    confCell.className = 'brain-td brain-td-conf';
    const confPct = Math.round((concept.confidence || 0) * 100);
    const confBarWrap = document.createElement('div');
    confBarWrap.className = 'brain-conf-bar-wrap';
    const confBar = document.createElement('div');
    confBar.className = 'brain-conf-bar ' + _confClass(confPct);
    confBar.style.width = confPct + '%';
    confBar.title = confPct + '% confidence';
    confBarWrap.appendChild(confBar);
    const confLabel = document.createElement('span');
    confLabel.className = 'brain-conf-label';
    confLabel.textContent = confPct + '%';
    confCell.appendChild(confBarWrap);
    confCell.appendChild(confLabel);

    // ── Manual-only toggle cell ───────────────────────────────
    const manualCell = document.createElement('div');
    manualCell.className = 'brain-td brain-td-manual';
    const manualLabel = document.createElement('label');
    manualLabel.className = 'toggle';
    const manualChk = document.createElement('input');
    manualChk.type = 'checkbox';
    manualChk.checked = !!concept.manualOnly;
    manualChk.addEventListener('change', () => _setManualOnly(concept.key, manualChk.checked));
    const manualTrack = document.createElement('div');
    manualTrack.className = 'toggle-track';
    const manualThumb = document.createElement('div');
    manualThumb.className = 'toggle-thumb';
    manualTrack.appendChild(manualThumb);
    manualLabel.appendChild(manualChk);
    manualLabel.appendChild(manualTrack);
    manualCell.appendChild(manualLabel);

    // ── Actions cell ──────────────────────────────────────────
    const actCell = document.createElement('div');
    actCell.className = 'brain-td brain-td-actions';

    // Edit / Save toggle button
    const editBtn = document.createElement('button');
    editBtn.className = 'btn-sm brain-edit-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isEditing = !valInput.classList.contains('hidden');
      if (isEditing) {
        // Save
        const newVal = valInput.value.trim();
        if (newVal) {
          _saveConcept(concept.key, newVal, undefined, valDisplay, editBtn);
        }
        valDisplay.classList.remove('hidden');
        valInput.classList.add('hidden');
        editBtn.textContent = 'Edit';
      } else {
        // Enter edit mode
        valDisplay.classList.add('hidden');
        valInput.classList.remove('hidden');
        valInput.focus();
        valInput.select();
        editBtn.textContent = 'Save';
      }
    });

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'btn-sm danger brain-del-btn';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _deleteConcept(concept.key, row, expandPanel);
    });

    actCell.appendChild(editBtn);
    actCell.appendChild(delBtn);

    // ── Assemble row inner ────────────────────────────────────
    inner.appendChild(keyCell);
    inner.appendChild(valCell);
    inner.appendChild(confCell);
    inner.appendChild(manualCell);
    inner.appendChild(actCell);

    // ── Click row to expand ───────────────────────────────────
    inner.addEventListener('click', () => {
      const isOpen = expandPanel.classList.contains('visible');
      if (isOpen) {
        expandPanel.classList.remove('visible');
        expandCaret.classList.remove('open');
      } else {
        expandPanel.classList.add('visible');
        expandCaret.classList.add('open');
        // S2 fix: always rebuild for fresh data (catches post-save staleness).
        // concept object is shared by reference with _brainConcepts so it reflects
        // any _saveConcept mutations without needing a full table re-render.
        _buildExpandPanel(expandPanel, concept);
      }
    });

    row.appendChild(inner);
    row.appendChild(expandPanel);
    body.appendChild(row);
  });
}

/* ════════════════════════════════════════════════════════════
   EXPAND PANEL  (aliases + URL overrides)
   ════════════════════════════════════════════════════════════ */

function _buildExpandPanel(panel, concept) {
  // Clear existing content safely
  while (panel.firstChild) panel.removeChild(panel.firstChild);

  // ── Aliases section ───────────────────────────────────────
  const aliasTitle = document.createElement('div');
  aliasTitle.className = 'brain-expand-section-title';
  aliasTitle.textContent = 'Aliases';
  panel.appendChild(aliasTitle);

  const aliases = concept.aliases || [];
  if (aliases.length === 0) {
    const noAlias = document.createElement('p');
    noAlias.className = 'brain-expand-empty';
    noAlias.textContent = 'No aliases learned yet.';
    panel.appendChild(noAlias);
  } else {
    const chipList = document.createElement('div');
    chipList.className = 'brain-alias-list';
    aliases.forEach(a => {
      const chip = document.createElement('div');
      chip.className = 'brain-alias-chip';

      const aliasText = document.createElement('span');
      aliasText.textContent = a.alias;

      const sep = document.createTextNode(' · ');

      const stats = document.createElement('span');
      stats.className = 'brain-alias-stats';
      const confPct = Math.round((a.confidence || 0) * 100);
      stats.textContent = `${a.hits}↑ ${a.misses}↓  ${confPct}%`;

      chip.appendChild(aliasText);
      chip.appendChild(sep);
      chip.appendChild(stats);
      chipList.appendChild(chip);
    });
    panel.appendChild(chipList);
  }

  // ── URL Overrides section ────────────────────────────────
  const urlOverrides = concept.urlOverrides || {};
  const urlKeys = Object.keys(urlOverrides);

  if (urlKeys.length > 0) {
    const urlTitle = document.createElement('div');
    urlTitle.className = 'brain-expand-section-title';
    urlTitle.textContent = 'URL Overrides';
    panel.appendChild(urlTitle);

    urlKeys.forEach(formUrl => {
      const overrideRow = document.createElement('div');
      overrideRow.className = 'brain-url-override';

      const urlSpan = document.createElement('span');
      urlSpan.className = 'brain-url-path';
      urlSpan.textContent = formUrl;

      const arrow = document.createTextNode(' → ');

      const valSpan = document.createElement('span');
      valSpan.className = 'brain-url-val';
      valSpan.textContent = urlOverrides[formUrl];

      const delOverrideBtn = document.createElement('button');
      delOverrideBtn.className = 'btn-sm danger brain-url-del';
      delOverrideBtn.textContent = '×';
      delOverrideBtn.title = 'Remove this URL override';
      delOverrideBtn.addEventListener('click', async () => {
        try {
          await chrome.runtime.sendMessage({
            action:     'brain_delete_url_override',
            conceptKey: concept.key,
            formUrl,
          });
          overrideRow.remove();
        } catch (e) { console.warn('[AutoFill Brain]', e); }
      });

      overrideRow.appendChild(urlSpan);
      overrideRow.appendChild(arrow);
      overrideRow.appendChild(valSpan);
      overrideRow.appendChild(delOverrideBtn);
      panel.appendChild(overrideRow);
    });
  }
}

/* ════════════════════════════════════════════════════════════
   STATUS BAR
   ════════════════════════════════════════════════════════════ */

async function _updateStatusBar() {
  const statusEl = document.getElementById('brainStatusText');
  if (!statusEl) return;

  try {
    const res = await chrome.runtime.sendMessage({ action: 'brain_storage_usage' });
    const usage = res?.usage;
    const conceptCount = _brainConcepts.length;
    const aliasCount   = _brainAliasCount;
    const mb  = usage ? usage.usedMB  : '—';
    const cap = usage ? usage.quotaMB : '10';

    statusEl.textContent =
      `🧠 Brain active · ${conceptCount} concept${conceptCount !== 1 ? 's' : ''} · ${aliasCount} aliases learned · ${mb} MB / ${cap} MB`;
  } catch (_) {
    statusEl.textContent = '🧠 Brain active';
  }
}

/* ════════════════════════════════════════════════════════════
   BRAIN SETTINGS WIRING
   ════════════════════════════════════════════════════════════ */

function _wireBrainSettings() {
  // Load persisted settings first
  chrome.storage.local.get('autofill_settings', data => {
    const s = data.autofill_settings || {};

    const slider  = document.getElementById('brainConfidenceSlider');
    const label   = document.getElementById('brainConfidenceLabel');
    const autoUpd = document.getElementById('brainAutoUpdateToggle');
    const refresh = document.getElementById('brainRefreshBtn');

    if (slider && label) {
      const saved = s.brainThreshold || 75;
      slider.value       = saved;
      label.textContent  = saved + '%';

      slider.addEventListener('input', () => {
        const v = parseInt(slider.value, 10);
        label.textContent = v + '%';
        _saveBrainSetting('brainThreshold', v);
      });
    }

    if (autoUpd) {
      autoUpd.checked = s.brainAutoUpdate !== false; // default true
      autoUpd.addEventListener('change', () => {
        _saveBrainSetting('brainAutoUpdate', autoUpd.checked);
      });
    }

    if (refresh) {
      refresh.addEventListener('click', _loadAndRenderBrain);
    }
  });
}

function _saveBrainSetting(key, value) {
  chrome.storage.local.get('autofill_settings', data => {
    const s = data.autofill_settings || {};
    s[key] = value;
    chrome.storage.local.set({ autofill_settings: s }, () => {
      if (chrome.runtime.lastError)
        console.warn('[AutoFill Brain] Setting save error:', chrome.runtime.lastError.message);
    });
  });
}

/* ════════════════════════════════════════════════════════════
   DATA ACTIONS  (Export / Import / Reset)
   ════════════════════════════════════════════════════════════ */

function _wireBrainDataActions() {
  const exportBtn    = document.getElementById('brainExportBtn');
  const importBtn    = document.getElementById('brainImportBtn');
  const importFile   = document.getElementById('brainImportFile');
  const resetBtn     = document.getElementById('brainResetBtn');

  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      try {
        const res = await chrome.runtime.sendMessage({ action: 'brain_export' });
        if (!res?.ok || !res.data) { alert('Export failed'); return; }
        const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url;
        a.download = `autofill-brain-${new Date().toISOString().slice(0,10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (e) { alert('Export error: ' + e.message); }
    });
  }

  if (importBtn && importFile) {
    importBtn.addEventListener('click', () => importFile.click());

    importFile.addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text     = await file.text();
        const imported = JSON.parse(text);

        // Schema validation — must have concepts, aliases, confidence objects
        if (typeof imported !== 'object' ||
            typeof imported.concepts   !== 'object' ||
            typeof imported.aliases    !== 'object' ||
            typeof imported.confidence !== 'object') {
          alert('Invalid brain export file. Expected {concepts, aliases, confidence} structure.');
          return;
        }

        const mode = confirm(
          'Import mode:\n\nOK → Merge (union with existing data)\nCancel → Replace (overwrite all)'
        ) ? 'merge' : 'replace';

        const res = await chrome.runtime.sendMessage({
          action: 'brain_import',
          data:   imported,
          mode,
        });

        if (res?.ok) {
          await _loadAndRenderBrain();
          _showBrainStatus('success', `Brain imported (${mode} mode)`);
        } else {
          _showBrainStatus('error', 'Import failed: ' + (res?.error || 'unknown error'));
        }
      } catch (err) {
        _showBrainStatus('error', 'Invalid JSON file: ' + err.message);
      }
      importFile.value = '';
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      if (!confirm(
        '⚠ Reset Brain?\n\nThis will permanently delete all learned concepts, aliases, and confidence data.\n\nThis cannot be undone.'
      )) return;

      try {
        const res = await chrome.runtime.sendMessage({ action: 'brain_reset' });
        if (res?.ok) {
          _brainConcepts   = [];
          _brainAliasCount = 0;
          renderConceptsTable([]);
          _updateStatusBar();
          _showBrainStatus('success', 'Brain reset. Seed aliases will repopulate on next form fill.');
        } else {
          _showBrainStatus('error', 'Reset failed: ' + (res?.error || 'unknown'));
        }
      } catch (e) {
        _showBrainStatus('error', 'Reset error: ' + e.message);
      }
    });
  }
}

/* ════════════════════════════════════════════════════════════
   CONCEPT ACTIONS  (inline save / delete)
   ════════════════════════════════════════════════════════════ */

async function _saveConcept(key, newValue, manualOnly, displayEl, btnEl) {
  try {
    const res = await chrome.runtime.sendMessage({
      action:     'brain_set_concept',
      key,
      value:      newValue,
      manualOnly,
    });
    if (res?.ok) {
      if (displayEl) displayEl.textContent = newValue;
      if (btnEl)     btnEl.textContent = 'Edit';
      // Update local cache
      const c = _brainConcepts.find(c => c.key === key);
      if (c) c.value = newValue;
      _showBrainStatus('success', `"${key}" saved`);
    } else {
      _showBrainStatus('error', 'Save failed: ' + (res?.error || 'unknown'));
    }
  } catch (e) {
    _showBrainStatus('error', 'Save error: ' + e.message);
  }
}

async function _setManualOnly(key, manualOnly) {
  try {
    await chrome.runtime.sendMessage({
      action: 'brain_set_manual_only',
      key,
      manualOnly,
    });
    const c = _brainConcepts.find(c => c.key === key);
    if (c) c.manualOnly = manualOnly;
  } catch (e) {
    console.warn('[AutoFill Brain] setManualOnly error:', e.message);
  }
}

async function _deleteConcept(key, rowEl, panelEl) {
  if (!confirm(`Delete concept "${key}"?\n\nThis removes the concept and all its learned aliases.`)) return;
  try {
    const res = await chrome.runtime.sendMessage({ action: 'brain_delete_concept', key });
    if (res?.ok) {
      rowEl?.remove();
      panelEl?.remove();
      _brainConcepts   = _brainConcepts.filter(c => c.key !== key);
      _brainAliasCount = _brainConcepts.reduce((s, c) => s + (c.aliases?.length || 0), 0);
      _updateStatusBar();

      // Show empty state if no concepts remain
      const body  = document.getElementById('brainTableBody');
      const empty = document.getElementById('brainEmpty');
      if (body && !body.firstChild && empty) empty.classList.remove('hidden');
    } else {
      _showBrainStatus('error', 'Delete failed: ' + (res?.error || 'unknown'));
    }
  } catch (e) {
    _showBrainStatus('error', 'Delete error: ' + e.message);
  }
}

/* ════════════════════════════════════════════════════════════
   HELPERS
   ════════════════════════════════════════════════════════════ */

function _confClass(pct) {
  if (pct >= 75) return 'high';
  if (pct >= 50) return 'medium';
  return 'low';
}

function _safeId(str) {
  return (str || '').replace(/[^a-z0-9]/gi, '_');
}

function _showBrainError(msg) {
  const body = document.getElementById('brainTableBody');
  if (!body) return;
  while (body.firstChild) body.removeChild(body.firstChild);
  const err = document.createElement('p');
  err.className = 'brain-expand-empty';
  err.textContent = '⚠ ' + msg;
  body.appendChild(err);
}

// Reuse the main dashboard status bar for brain feedback
function _showBrainStatus(type, message) {
  const bar = document.getElementById('statusBar');
  const msg = document.getElementById('statusMsg');
  if (!bar || !msg) return;

  bar.className = 'status-bar ' + type;
  msg.textContent = message;
  bar.classList.remove('hidden');

  clearTimeout(_showBrainStatus._timer);
  _showBrainStatus._timer = setTimeout(() => bar.classList.add('hidden'), 3500);
}
