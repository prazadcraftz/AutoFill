/* ============================================================
   AutoFill v3 — background/brain-api.js
   Message router — depends on brain.js being loaded first

   Message actions:
     brain_query          content → bg  → { concept, value, confidence, manualOnly }
     brain_learn          content → bg  → records hit/miss, proposes update to tab
     brain_passive_learn  content → bg  → silently learns label→value from user typing
     brain_get_concepts   dashboard → bg → full concepts + alias + confidence table
     brain_set_concept    dashboard → bg → upsert concept value
     brain_set_manual_only dashboard → bg → toggle manual-only flag
     brain_delete_concept dashboard → bg → remove concept + all its aliases
     brain_delete_url_override dashboard → bg → remove one URL override entry
     brain_export         dashboard → bg → full JSON export
     brain_import         dashboard → bg → merge or replace from JSON
     brain_reset          dashboard → bg → wipe all brain storage
     brain_storage_usage  dashboard → bg → bytes used / quota
   ============================================================ */

'use strict';

/* ════════════════════════════════════════════════════════════
   BIDIRECTIONAL SYNC HELPER
   Brain → My Info: when a concept value is explicitly updated
   (e.g. via Brain tab inline save or accepted update proposal),
   propagate that value back to the matching autofill_fields entry.

   The fromMyInfo flag prevents a sync loop:
   My Info save → brain_set_concept(fromMyInfo:true) → Brain
                                                        (no reverse sync)
   Brain tab save → brain_set_concept() → Brain → _syncConceptToMyInfo()
   ════════════════════════════════════════════════════════════ */
function _syncConceptToMyInfo(conceptKey, newValue) {
  chrome.storage.local.get('autofill_fields', data => {
    const fields = data.autofill_fields || [];
    let changed = false;

    for (const field of fields) {
      // Normalise the stored label the same way brain.js normalise() does
      const normLabel = (field.label || '')
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (normLabel === conceptKey) {
        field.value = newValue;
        changed = true;
        break;   // label keys are unique in My Info
      }
    }

    if (!changed) return;   // concept has no matching My Info entry — that's fine

    chrome.storage.local.set({ autofill_fields: fields }, () => {
      if (chrome.runtime.lastError)
        console.warn('[AutoFill Brain] My Info reverse-sync error:',
          chrome.runtime.lastError.message);
    });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const { action } = msg;

  // ── brain_query ─────────────────────────────────────────────
  if (action === 'brain_query') {
    queryBrain(msg.label, msg.formUrl)
      .then(sendResponse)
      .catch(e => sendResponse({ error: e.message, concept: null, value: null, confidence: 0 }));
    return true;   // async
  }

  // ── brain_learn ─────────────────────────────────────────────
  if (action === 'brain_learn') {
    learnFromFill({
      label:          msg.label,
      matchedConcept: msg.matchedConcept,
      wasHit:         msg.wasHit,
      newValue:       msg.newValue,
      oldValue:       msg.oldValue,
      formUrl:        msg.formUrl,
      senderTabId:    sender.tab?.id || null,
    })
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ── brain_passive_learn ──────────────────────────────────────
  // Fired when the user fills a field manually (no fill flow).
  // Silently learns label → value from every field the user touches.
  if (action === 'brain_passive_learn') {
    passiveLearn(msg.label, msg.value, msg.formUrl)
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ── brain_get_concepts ───────────────────────────────────────
  if (action === 'brain_get_concepts') {
    getConcepts()
      .then(concepts => sendResponse({ ok: true, concepts }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ── brain_set_concept ────────────────────────────────────────
  if (action === 'brain_set_concept') {
    setConcept(msg.key, msg.value, msg.manualOnly)
      .then(res => {
        // Bidirectional sync: propagate the new value back to My Info unless
        // the request originated from My Info itself (breaks the loop).
        if (res?.ok && msg.value !== undefined && !msg.fromMyInfo) {
          _syncConceptToMyInfo(msg.key, msg.value);
        }
        sendResponse(res);
      })
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ── brain_set_manual_only ────────────────────────────────────
  if (action === 'brain_set_manual_only') {
    setManualOnly(msg.key, msg.manualOnly)
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ── brain_delete_concept ─────────────────────────────────────
  if (action === 'brain_delete_concept') {
    deleteConcept(msg.key)
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ── brain_delete_url_override ────────────────────────────────
  if (action === 'brain_delete_url_override') {
    deleteUrlOverride(msg.conceptKey, msg.formUrl)
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ── brain_export ─────────────────────────────────────────────
  if (action === 'brain_export') {
    exportBrain()
      .then(data => sendResponse({ ok: true, data }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ── brain_import ─────────────────────────────────────────────
  if (action === 'brain_import') {
    importBrain(msg.data, msg.mode || 'merge')
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ── brain_reset ──────────────────────────────────────────────
  if (action === 'brain_reset') {
    resetBrain()
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ── brain_storage_usage ──────────────────────────────────────
  if (action === 'brain_storage_usage') {
    getStorageUsage()
      .then(usage => sendResponse({ ok: true, usage }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // ── Passthrough: not a brain action ─────────────────────────
  return false;
});
