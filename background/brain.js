/* ============================================================
   AutoFill v3 — background/brain.js
   Core Brain Engine (plain script — importScripts compatible)

   Sections:
     1. CONSTANTS & SEED DICTIONARY
     2. NORMALISE + TOKENISE
     3. TF-IDF INDEX  (in-memory, lazy rebuild after SW wake)
     4. LEVENSHTEIN FALLBACK
     5. WRITE QUEUE  (prevents concurrent-write race)
     6. CONFIDENCE SCORER  (lazy decay on read, LRU eviction)
     7. SEMANTIC ROUTER  (alias → concept, URL context)
     8. LEARN / UPDATE PROPOSER
     9. CONCEPT CRUD
    10. EXPORT / IMPORT / RESET
    11. FIRST-INSTALL SEED
   ============================================================ */

'use strict';

/* ════════════════════════════════════════════════════════════
   1. CONSTANTS & SEED DICTIONARY
   ════════════════════════════════════════════════════════════ */

const ALIAS_CAP       = 500;
const CONFIDENCE_CAP  = 500;
const DECAY_RATE      = 0.95;   // 5% decay per week
const WEEK_MS         = 7 * 24 * 3600 * 1000;
const SEED_HITS       = 3;      // phantom hits → confidence ≈ 1.0 from day one

const SEED_ALIASES = {
  // full name ────────────────────────────────────────────────
  'name':                          'full name',
  'your name':                     'full name',
  'full name':                     'full name',
  'student name':                  'full name',
  'applicant name':                'full name',
  'sname':                         'full name',
  'candidate name':                'full name',
  "participant's name":            'full name',
  'enter your name':               'full name',

  // email ────────────────────────────────────────────────────
  'email':                         'email',
  'mail':                          'email',
  'e-mail':                        'email',
  'email id':                      'email',
  'email address':                 'email',
  'email-id':                      'email',
  'your email':                    'email',
  'enter email':                   'email',

  // phone ────────────────────────────────────────────────────
  'phone':                         'phone',
  'mobile':                        'phone',
  'mobile number':                 'phone',
  'phone number':                  'phone',
  'mob':                           'phone',
  'ph':                            'phone',
  'contact number':                'phone',
  'cell':                          'phone',
  'phone no':                      'phone',
  'mobile no':                     'phone',
  'whatsapp number':               'phone',

  // date of birth ────────────────────────────────────────────
  'dob':                           'date of birth',
  'date of birth':                 'date of birth',
  'birth date':                    'date of birth',
  'birthdate':                     'date of birth',
  'd.o.b':                         'date of birth',
  'date of birth (dd/mm/yyyy)':    'date of birth',
  'your date of birth':            'date of birth',

  // address ──────────────────────────────────────────────────
  'address':                       'address',
  'full address':                  'address',
  'addr':                          'address',
  'residential address':           'address',
  'current address':               'address',
  'permanent address':             'address',

  // gender ───────────────────────────────────────────────────
  'gender':                        'gender',
  'sex':                           'gender',

  // college ──────────────────────────────────────────────────
  'college':                       'college',
  'institution':                   'college',
  'institute':                     'college',
  'university':                    'college',
  'college name':                  'college',
  'clg':                           'college',
  'name of the college':           'college',
  'name of institution':           'college',

  // department ───────────────────────────────────────────────
  'department':                    'department',
  'dept':                          'department',
  'branch':                        'department',
  'stream':                        'department',
  'branch/department':             'department',
  'specialization':                'department',
  'specialisation':                'department',

  // year ─────────────────────────────────────────────────────
  'year':                          'year',
  'year of study':                 'year',
  'current year':                  'year',
  'yr':                            'year',
  'year of passing':               'year',
  'yop':                           'year',
  'batch':                         'year',

  // semester ─────────────────────────────────────────────────
  'semester':                      'semester',
  'sem':                           'semester',
  'current semester':              'semester',

  // roll number ──────────────────────────────────────────────
  'roll number':                   'roll number',
  'roll no':                       'roll number',
  'roll':                          'roll number',
  'reg no':                        'roll number',
  'registration number':           'roll number',
  'regd no':                       'roll number',

  // uid ──────────────────────────────────────────────────────
  'uid':                           'uid',
  'university id':                 'uid',
  'student id':                    'uid',
  'enrollment number':             'uid',
  'id number':                     'uid',
  'student id number':             'uid',
  'htno':                          'uid',

  // cgpa ─────────────────────────────────────────────────────
  'cgpa':                          'cgpa',
  'gpa':                           'cgpa',
  'cumulative gpa':                'cgpa',
  'cumulative grade point average': 'cgpa',
  'sgpa':                          'cgpa',

  // linkedin ─────────────────────────────────────────────────
  'linkedin':                      'linkedin',
  'linkedin profile':              'linkedin',
  'linkedin url':                  'linkedin',
  'linkedin id':                   'linkedin',

  // github ───────────────────────────────────────────────────
  'github':                        'github',
  'github profile':                'github',
  'github url':                    'github',
  'github id':                     'github',
};

/* ════════════════════════════════════════════════════════════
   2. NORMALISE + TOKENISE
   ════════════════════════════════════════════════════════════ */

function normalise(str) {
  return (str || '').toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenise(str) {
  return normalise(str).split(' ').filter(Boolean);
}

/* ════════════════════════════════════════════════════════════
   3. TF-IDF INDEX  (lazy — rebuilt on first query after SW wake)
   ════════════════════════════════════════════════════════════ */

let _tfIdx = null;          // { docVectors, idf, aliasKeys, generation }
let _aliasGeneration = 0;   // C2: incremented on every alias write → forces TF-IDF rebuild

function _buildTfIdx(aliases) {
  const docs = Object.keys(aliases);
  const N    = docs.length || 1;

  // document frequency per term
  const df = {};
  docs.forEach(doc => {
    const terms = new Set(tokenise(doc));
    terms.forEach(t => { df[t] = (df[t] || 0) + 1; });
  });

  // inverse document frequency
  const idf = {};
  Object.keys(df).forEach(t => { idf[t] = Math.log((N + 1) / (df[t] + 1)) + 1; });

  // per-document TF-IDF vectors
  const docVectors = {};
  docs.forEach(doc => {
    const tokens = tokenise(doc);
    const tf = {};
    tokens.forEach(t => { tf[t] = (tf[t] || 0) + 1 / tokens.length; });
    const vec = {};
    Object.keys(tf).forEach(t => { vec[t] = tf[t] * (idf[t] || 1); });
    docVectors[doc] = vec;
  });

  _tfIdx = { docVectors, idf, aliasKeys: docs, generation: _aliasGeneration };
}

function _cosineSim(vecA, vecB) {
  let dot = 0, na = 0, nb = 0;
  const allT = new Set([...Object.keys(vecA), ...Object.keys(vecB)]);
  allT.forEach(t => {
    const a = vecA[t] || 0, b = vecB[t] || 0;
    dot += a * b; na += a * a; nb += b * b;
  });
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function tfIdfQuery(queryStr, aliases) {
  // Rebuild index if stale (SW just woke up or aliases changed)
  const aliasKeys = Object.keys(aliases);
  if (!_tfIdx || _tfIdx.generation !== _aliasGeneration) {
    _buildTfIdx(aliases);  // C2: rebuild whenever alias set changes
  }

  const { docVectors, idf } = _tfIdx;
  const tokens = tokenise(queryStr);
  const tf = {};
  tokens.forEach(t => { tf[t] = (tf[t] || 0) + 1 / tokens.length; });
  const qVec = {};
  tokens.forEach(t => { qVec[t] = tf[t] * (idf[t] || 1); });

  let best = null, bestScore = 0;
  aliasKeys.forEach(alias => {
    const score = _cosineSim(qVec, docVectors[alias] || {});
    if (score > bestScore) { bestScore = score; best = alias; }
  });

  return best && bestScore > 0.25
    ? { alias: best, concept: aliases[best], score: bestScore }
    : null;
}

/* ════════════════════════════════════════════════════════════
   4. LEVENSHTEIN FALLBACK
   ════════════════════════════════════════════════════════════ */

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function levenshteinSim(a, b) {
  const maxLen = Math.max(a.length, b.length) || 1;
  return 1 - levenshtein(a, b) / maxLen;
}

function levenshteinFallback(normLabel, aliases) {
  let best = null, bestScore = 0;
  Object.keys(aliases).forEach(alias => {
    const score = levenshteinSim(normLabel, alias);
    if (score > bestScore) { bestScore = score; best = alias; }
  });
  return (best && bestScore > 0.6)
    ? { alias: best, concept: aliases[best], score: bestScore }
    : null;
}

/* ════════════════════════════════════════════════════════════
   5. WRITE QUEUE  (single Promise chain — eliminates race condition)
   ════════════════════════════════════════════════════════════ */

let _writeQueue = Promise.resolve();

function queueWrite(fn) {
  _writeQueue = _writeQueue.then(fn).catch(e =>
    console.error('[AutoFill Brain] Write error:', e));
  return _writeQueue;
}

function _chromeSave(obj) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(obj, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function _chromeGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, data => resolve(data));
  });
}

/* ════════════════════════════════════════════════════════════
   6. CONFIDENCE SCORER
   Lazy decay: score computed at read time, no alarms needed.
   Phantom hits for seeded aliases (SEED_HITS phantom hits → rawScore 1.0 initially).
   ════════════════════════════════════════════════════════════ */

function _computeConfidence(rec) {
  if (!rec) return 0;
  const { hits, misses, lastSeen } = rec;
  const total = hits + misses;
  if (!total) return 0;
  const rawScore    = hits / total;
  const weeksSince  = (Date.now() - lastSeen) / WEEK_MS;
  const decayFactor = Math.pow(DECAY_RATE, weeksSince);
  return rawScore * decayFactor;
}

async function _recordConfidence(alias, isHit) {
  return queueWrite(async () => {
    const data  = await _chromeGet('af_confidence');
    const conf  = data.af_confidence || {};
    const rec   = conf[alias] || { hits: 0, misses: 0, lastSeen: Date.now() };

    if (isHit) rec.hits++;  else rec.misses++;
    rec.lastSeen = Date.now();
    conf[alias]  = rec;

    // LRU eviction if over cap (S4: Math.min prevents under-eviction when seeds dominate)
    const keys = Object.keys(conf);
    if (keys.length > CONFIDENCE_CAP) {
      const nonSeed = keys.filter(k => !SEED_ALIASES.hasOwnProperty(k));
      nonSeed.sort((a, b) => conf[a].lastSeen - conf[b].lastSeen);
      const toEvict = Math.min(keys.length - CONFIDENCE_CAP, nonSeed.length);
      nonSeed.slice(0, toEvict).forEach(k => delete conf[k]);
    }

    await _chromeSave({ af_confidence: conf });
  });
}

async function recordHit(alias)  { return _recordConfidence(alias, true);  }
async function recordMiss(alias) { return _recordConfidence(alias, false); }

/* ════════════════════════════════════════════════════════════
   7. SEMANTIC ROUTER
   Lookup order: exact alias → TF-IDF → Levenshtein fallback
   URL context: check urlOverrides before returning global value
   ════════════════════════════════════════════════════════════ */

async function queryBrain(label, formUrl) {
  const normLabel = normalise(label);
  let data      = await _chromeGet(['af_aliases', 'af_concepts', 'af_confidence']);
  let aliases   = data.af_aliases   || {};

  if (Object.keys(aliases).length === 0) {
    await seedOnInstall();
    data    = await _chromeGet(['af_aliases', 'af_concepts', 'af_confidence']);
    aliases = data.af_aliases || {};
  }

  const concepts  = data.af_concepts  || {};
  const confs     = data.af_confidence || {};

  // 1. Exact alias match ──────────────────────────────────────
  let matchedAlias   = aliases[normLabel] ? normLabel : null;
  let matchedConcept = matchedAlias ? aliases[normLabel] : null;

  // 2. TF-IDF ────────────────────────────────────────────────
  if (!matchedAlias && Object.keys(aliases).length > 0) {
    const r = tfIdfQuery(normLabel, aliases);
    if (r) { matchedAlias = r.alias; matchedConcept = r.concept; }
  }

  // 3. Levenshtein fallback ──────────────────────────────────
  if (!matchedAlias) {
    const r = levenshteinFallback(normLabel, aliases);
    if (r) { matchedAlias = r.alias; matchedConcept = r.concept; }
  }

  if (!matchedAlias || !matchedConcept) {
    return { concept: null, value: null, confidence: 0, manualOnly: false };
  }

  const cData = concepts[matchedConcept];
  if (!cData) return { concept: null, value: null, confidence: 0, manualOnly: false };

  // Compute confidence (lazy decay)
  const confidence = _computeConfidence(confs[matchedAlias]);

  // URL context override
  let value = cData.value;
  if (formUrl && cData.urlOverrides && cData.urlOverrides[formUrl]) {
    value = cData.urlOverrides[formUrl];
  }

  return {
    concept:    matchedConcept,
    alias:      matchedAlias,
    value,
    confidence,
    manualOnly: cData.manualOnly || false,
  };
}

/* ════════════════════════════════════════════════════════════
   8. LEARN / UPDATE PROPOSER
   Called after every fill and after observeUserEdits fires.
   Carries formUrl for URL-contextual override learning.
   ════════════════════════════════════════════════════════════ */

async function learnFromFill({ label, matchedConcept, wasHit, newValue, oldValue, formUrl, senderTabId }) {
  const normLabel = normalise(label);

  // Ensure alias is stored ────────────────────────────────────
  if (matchedConcept) {
    await queueWrite(async () => {
      const data    = await _chromeGet(['af_aliases', 'af_confidence']);
      const aliases = data.af_aliases    || {};
      const confs   = data.af_confidence || {};

      if (!aliases[normLabel]) {
        aliases[normLabel] = matchedConcept;

        // LRU eviction — never evict seeds (S4: correct eviction count)
        const keys = Object.keys(aliases);
        if (keys.length > ALIAS_CAP) {
          const nonSeed = keys.filter(k => !SEED_ALIASES.hasOwnProperty(k));
          nonSeed.sort((a, b) => (confs[a]?.lastSeen || 0) - (confs[b]?.lastSeen || 0));
          const toEvict = Math.min(keys.length - ALIAS_CAP, nonSeed.length);
          nonSeed.slice(0, toEvict).forEach(k => delete aliases[k]);
        }

        await _chromeSave({ af_aliases: aliases });
        _aliasGeneration++;  // C2: invalidate TF-IDF index
      }
    });
  }

  // Record hit / miss ────────────────────────────────────────
  if (wasHit) {
    await recordHit(normLabel);
  } else {
    await recordMiss(normLabel);
  }

  // Update proposer ──────────────────────────────────────────
  // C3 fix: confidence read INSIDE queueWrite → no TOCTOU race between read and decision
  if (!wasHit && newValue && oldValue && newValue !== oldValue && matchedConcept) {
    await queueWrite(async () => {
      const data       = await _chromeGet(['af_confidence', 'af_concepts']);
      const confidence = _computeConfidence((data.af_confidence || {})[normLabel]);
      const concepts   = data.af_concepts || {};
      const cd         = concepts[matchedConcept];
      if (!cd) return;

      if (confidence < 0.6) {
        // Low confidence → silent update
        if (formUrl && cd.urlOverrides && Object.keys(cd.urlOverrides).includes(formUrl)) {
          cd.urlOverrides[formUrl] = newValue;
        } else {
          cd.value     = newValue;
          cd.updatedAt = Date.now();
        }
        concepts[matchedConcept] = cd;
        await _chromeSave({ af_concepts: concepts });
      } else {
        // High confidence → propose update to the user's tab
        if (senderTabId) {
          chrome.tabs.sendMessage(senderTabId, {
            action:    'brain_propose_update',
            concept:   matchedConcept,
            label,
            newValue,
            oldValue,
            formUrl,
          }).catch(() => {});
        }
      }
    });
  }
}

/* ════════════════════════════════════════════════════════════
   8b. PASSIVE LEARN
   Called when the user fills a Google Form manually (without
   clicking "Fill this form"). The brain silently captures
   label→value associations from every field the user touches.

   Fixes applied:
   C1 — Two separate queueWrite blocks merged into one atomic write.
   C5 — URL-override branch simplified; no duplicate or dead conditions.
   C2 — _aliasGeneration++ replaces _tfIdx = null.
   S4 — LRU eviction count capped with Math.min.
   ════════════════════════════════════════════════════════════ */

async function passiveLearn(label, value, formUrl) {
  if (!label || !value) return { ok: false };
  const normLabel = normalise(label);
  const trimVal   = String(value).trim();
  if (!trimVal) return { ok: false };

  // Resolve existing concept for this label
  const match = await queryBrain(label, formUrl);

  if (match.concept) {
    // ── Known concept — single atomic write (C1 fix) ──────────
    const conceptKey = match.concept;

    await queueWrite(async () => {
      const data     = await _chromeGet(['af_concepts', 'af_aliases', 'af_confidence']);
      const concepts = data.af_concepts   || {};
      const aliases  = data.af_aliases    || {};
      const confs    = data.af_confidence || {};

      // Update concept value (C5: simplified URL-override logic)
      let cd = concepts[conceptKey];
      if (!cd) {
        cd = { value: trimVal, updatedAt: Date.now(), urlOverrides: {}, manualOnly: false };
        concepts[conceptKey] = cd;
      } else if (trimVal !== cd.value) {
        if (formUrl) {
          cd.urlOverrides = cd.urlOverrides || {};
          cd.urlOverrides[formUrl] = trimVal;   // store URL-specific override
        } else {
          cd.value     = trimVal;
          cd.updatedAt = Date.now();
        }
        concepts[conceptKey] = cd;
      }

      // Ensure label alias is registered
      if (!aliases[normLabel]) {
        aliases[normLabel] = conceptKey;
        _aliasGeneration++;  // C2: invalidate TF-IDF index

        // LRU eviction — never evict seeds (S4: correct eviction count)
        const aKeys = Object.keys(aliases);
        if (aKeys.length > ALIAS_CAP) {
          const nonSeed = aKeys.filter(k => !SEED_ALIASES.hasOwnProperty(k));
          nonSeed.sort((a, b) => (confs[a]?.lastSeen || 0) - (confs[b]?.lastSeen || 0));
          const toEvict = Math.min(aKeys.length - ALIAS_CAP, nonSeed.length);
          nonSeed.slice(0, toEvict).forEach(k => { delete aliases[k]; delete confs[k]; });
        }
      }

      // Record hit
      const rec = confs[normLabel] || { hits: 0, misses: 0, lastSeen: Date.now() };
      rec.hits++;
      rec.lastSeen = Date.now();
      confs[normLabel] = rec;

      await _chromeSave({ af_concepts: concepts, af_aliases: aliases, af_confidence: confs });
    });

  } else {
    // ── No label match — try value-based alias discovery ──────────────
    // If the user typed a value that is ALREADY stored under a different label
    // (either in Brain or in My Info), register this label as an alias for
    // that concept instead of creating a duplicate.
    const existingConcept = await findConceptByValue(trimVal);
    if (existingConcept) {
      // Register alias + record initial hit in one atomic write
      await queueWrite(async () => {
        const data    = await _chromeGet(['af_aliases', 'af_confidence']);
        const aliases = data.af_aliases    || {};
        const confs   = data.af_confidence || {};
        if (aliases[normLabel]) return;   // alias already known — nothing to do

        aliases[normLabel] = existingConcept;
        _aliasGeneration++;  // C2: invalidate TF-IDF index
        confs[normLabel] = { hits: 1, misses: 0, lastSeen: Date.now() };

        // LRU eviction — never evict seeds
        const aKeys = Object.keys(aliases);
        if (aKeys.length > ALIAS_CAP) {
          const nonSeed = aKeys.filter(k => !SEED_ALIASES.hasOwnProperty(k));
          nonSeed.sort((a, b) => (confs[a]?.lastSeen || 0) - (confs[b]?.lastSeen || 0));
          const toEvict = Math.min(aKeys.length - ALIAS_CAP, nonSeed.length);
          nonSeed.slice(0, toEvict).forEach(k => { delete aliases[k]; delete confs[k]; });
        }

        await _chromeSave({ af_aliases: aliases, af_confidence: confs });
      });
    } else {
      // Truly new label AND new value → create new concept
      await setConcept(normLabel, trimVal);
    }
  }

  return { ok: true };
}

/* ════════════════════════════════════════════════════════════
   8c. VALUE-BASED ALIAS DISCOVERY
   Searches af_concepts (and autofill_fields as fallback) for any
   entry whose stored value matches the given string.
   Returns the concept key if found, null otherwise.
   Used by passiveLearn to prevent duplicate concepts when the user
   types a known value under a previously-unseen label.
   ════════════════════════════════════════════════════════════ */

async function findConceptByValue(value) {
  const normVal = normalise(value);
  if (!normVal) return null;

  const data     = await _chromeGet(['af_concepts', 'autofill_fields']);
  const concepts = data.af_concepts   || {};
  const myInfo   = data.autofill_fields || [];

  // 1. Search brain concepts first (fastest path)
  for (const [key, cd] of Object.entries(concepts)) {
    if (!cd.manualOnly && cd.value && normalise(cd.value) === normVal) {
      return key;
    }
  }

  // 2. Fallback: search My Info fields (handles case where sync hasn't run yet)
  for (const { label, value: fval } of myInfo) {
    if (fval && normalise(fval) === normVal) {
      const normLabel = normalise(label);
      if (normLabel) return normLabel;   // treat the normalised field label as concept key
    }
  }

  return null;
}

/* ════════════════════════════════════════════════════════════
   9. CONCEPT CRUD

   ════════════════════════════════════════════════════════════ */

async function getConcepts() {
  const data     = await _chromeGet(['af_concepts', 'af_aliases', 'af_confidence']);
  const concepts = data.af_concepts   || {};
  const aliases  = data.af_aliases    || {};
  const confs    = data.af_confidence || {};

  // Build concept → aliases reverse map
  const conceptAliases = {};
  Object.entries(aliases).forEach(([alias, concept]) => {
    if (!conceptAliases[concept]) conceptAliases[concept] = [];
    conceptAliases[concept].push(alias);
  });

  return Object.entries(concepts).map(([key, cd]) => {
    const ownAliases = conceptAliases[key] || [];
    const aliasDetails = ownAliases.map(alias => {
      const rec = confs[alias] || { hits: 0, misses: 0, lastSeen: 0 };
      return { alias, hits: rec.hits, misses: rec.misses, confidence: _computeConfidence(rec) };
    });
    // M1 fix: weight by total usage so heavily-used aliases dominate the average
    const totalWeight = aliasDetails.reduce((s, a) => s + a.hits + a.misses, 0);
    const avgConf = aliasDetails.length > 0
      ? (totalWeight > 0
          ? aliasDetails.reduce((s, a) => s + a.confidence * (a.hits + a.misses), 0) / totalWeight
          : aliasDetails.reduce((s, a) => s + a.confidence, 0) / aliasDetails.length)
      : 0;

    return {
      key,
      value:        cd.value,
      updatedAt:    cd.updatedAt,
      manualOnly:   cd.manualOnly  || false,
      urlOverrides: cd.urlOverrides || {},
      aliases:      aliasDetails,
      confidence:   avgConf,
    };
  });
}

async function setConcept(key, value, manualOnly) {
  return queueWrite(async () => {
    const normKey = normalise(key);
    const data    = await _chromeGet(['af_concepts', 'af_aliases', 'af_confidence']);
    const concepts  = data.af_concepts   || {};
    const aliases   = data.af_aliases    || {};
    const confs     = data.af_confidence || {};
    const existing  = concepts[normKey] || { urlOverrides: {}, manualOnly: false };

    concepts[normKey] = {
      ...existing,
      value,
      updatedAt: Date.now(),
      ...(manualOnly !== undefined ? { manualOnly } : {}),
    };

    // Register self-alias (key → key) so exact form label hits always resolve
    if (!aliases[normKey]) {
      aliases[normKey] = normKey;
      // Give it seed-level confidence so brain trusts it immediately
      if (!confs[normKey]) {
        confs[normKey] = { hits: SEED_HITS, misses: 0, lastSeen: Date.now() };
      }
      _aliasGeneration++;   // C2: invalidate TF-IDF index
      await _chromeSave({ af_concepts: concepts, af_aliases: aliases, af_confidence: confs });
    } else {
      await _chromeSave({ af_concepts: concepts });
    }

    return { ok: true };
  });
}


async function setManualOnly(key, manualOnly) {
  return queueWrite(async () => {
    const data     = await _chromeGet('af_concepts');
    const concepts = data.af_concepts || {};
    if (!concepts[key]) return { ok: false, error: 'Concept not found' };
    concepts[key].manualOnly = !!manualOnly;
    await _chromeSave({ af_concepts: concepts });
    return { ok: true };
  });
}

async function deleteConcept(key) {
  return queueWrite(async () => {
    const data     = await _chromeGet(['af_concepts', 'af_aliases', 'af_confidence']);
    const concepts = data.af_concepts   || {};
    const aliases  = data.af_aliases    || {};
    const confs    = data.af_confidence || {};

    delete concepts[key];

    // Remove all aliases + confidence entries for this concept
    Object.keys(aliases).forEach(alias => {
      if (aliases[alias] === key) { delete aliases[alias]; delete confs[alias]; }
    });

    await _chromeSave({ af_concepts: concepts, af_aliases: aliases, af_confidence: confs });
    _aliasGeneration++;  // C2: invalidate TF-IDF index
    return { ok: true };
  });
}

async function deleteUrlOverride(conceptKey, formUrl) {
  return queueWrite(async () => {
    const data     = await _chromeGet('af_concepts');
    const concepts = data.af_concepts || {};
    const cd       = concepts[conceptKey];
    if (!cd?.urlOverrides) return { ok: false };
    delete cd.urlOverrides[formUrl];
    await _chromeSave({ af_concepts: concepts });
    return { ok: true };
  });
}

/* ════════════════════════════════════════════════════════════
   10. EXPORT / IMPORT / RESET
   ════════════════════════════════════════════════════════════ */

async function exportBrain() {
  const data = await _chromeGet(['af_concepts', 'af_aliases', 'af_confidence']);
  return {
    version:    '3.0.0',
    exportedAt: new Date().toISOString(),
    concepts:   data.af_concepts   || {},
    aliases:    data.af_aliases    || {},
    confidence: data.af_confidence || {},
  };
}

/* M6: sanitise all imported data before writing to storage.
   Rejects malformed entries that would crash _computeConfidence. */
function _sanitiseImportData(raw) {
  const safeObj = v => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  const concepts = {};
  Object.entries(safeObj(raw.concepts)).forEach(([k, v]) => {
    if (typeof k !== 'string' || typeof v !== 'object' || !v) return;
    concepts[k.slice(0, 200)] = {
      value:        typeof v.value === 'string'  ? v.value.slice(0, 500)  : '',
      updatedAt:    typeof v.updatedAt === 'number' ? v.updatedAt : Date.now(),
      manualOnly:   !!v.manualOnly,
      urlOverrides: Object.fromEntries(
        Object.entries(safeObj(v.urlOverrides))
          .filter(([uk, uv]) => typeof uk === 'string' && typeof uv === 'string')
          .map(([uk, uv]) => [uk.slice(0, 200), uv.slice(0, 500)])
      ),
    };
  });
  const aliases = {};
  Object.entries(safeObj(raw.aliases)).forEach(([k, v]) => {
    if (typeof k === 'string' && typeof v === 'string')
      aliases[k.slice(0, 200)] = v.slice(0, 200);
  });
  const confidence = {};
  Object.entries(safeObj(raw.confidence)).forEach(([k, v]) => {
    if (typeof k !== 'string' || typeof v !== 'object' || !v) return;
    confidence[k.slice(0, 200)] = {
      hits:     typeof v.hits === 'number'     ? Math.max(0, Math.floor(v.hits))     : 0,
      misses:   typeof v.misses === 'number'   ? Math.max(0, Math.floor(v.misses))   : 0,
      lastSeen: typeof v.lastSeen === 'number' ? v.lastSeen : Date.now(),
    };
  });
  return { concepts, aliases, confidence };
}

async function importBrain(imported, mode = 'merge') {
  return queueWrite(async () => {
    const { concepts, aliases, confidence } = _sanitiseImportData(imported);  // M6

    if (mode === 'replace') {
      await _chromeSave({ af_concepts: concepts, af_aliases: aliases, af_confidence: confidence });
    } else {
      // Merge: union aliases + confidence, concepts: incoming wins on conflict
      const existing = await _chromeGet(['af_concepts', 'af_aliases', 'af_confidence']);
      await _chromeSave({
        af_concepts:   { ...(existing.af_concepts   || {}), ...concepts   },
        af_aliases:    { ...(existing.af_aliases    || {}), ...aliases    },
        af_confidence: { ...(existing.af_confidence || {}), ...confidence },
      });
    }

    _aliasGeneration++;  // C2: invalidate TF-IDF index
    return { ok: true };
  });
}

async function resetBrain() {
  return queueWrite(async () => {
    await new Promise((resolve, reject) => {
      chrome.storage.local.remove(['af_concepts', 'af_aliases', 'af_confidence'], () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
    _tfIdx = null;
    _aliasGeneration = 0;  // full wipe — generation counter resets too
    return { ok: true };
  });
}

async function getStorageUsage() {
  return new Promise(resolve => {
    chrome.storage.local.getBytesInUse(null, bytes => {
      const quota = chrome.storage.local.QUOTA_BYTES || 10 * 1024 * 1024;
      resolve({
        usedBytes:  bytes,
        quotaBytes: quota,
        usedMB:     (bytes / (1024 * 1024)).toFixed(2),
        quotaMB:    (quota / (1024 * 1024)).toFixed(0),
        pct:        Math.round((bytes / quota) * 100),
      });
    });
  });
}

/* ════════════════════════════════════════════════════════════
   11. FIRST-INSTALL SEED
   Pre-populates af_aliases + af_confidence with ~80 entries.
   Skips aliases that already exist (safe to call on every install).
   ════════════════════════════════════════════════════════════ */

async function seedOnInstall() {
  return queueWrite(async () => {
    // S1: read af_concepts too — seeds must populate it so queryBrain can resolve values
    const data     = await _chromeGet(['af_aliases', 'af_confidence', 'af_concepts']);
    const aliases  = data.af_aliases    || {};
    const confs    = data.af_confidence || {};
    const concepts = data.af_concepts   || {};
    let   changed  = false;

    Object.entries(SEED_ALIASES).forEach(([alias, concept]) => {
      if (!aliases[alias]) {
        aliases[alias] = concept;
        confs[alias] = { hits: SEED_HITS, misses: 0, lastSeen: Date.now() };
        changed = true;
      } else if (!confs[alias] || (confs[alias].hits === 0 && confs[alias].misses === 0)) {
        // M2: restore seed confidence if zeroed by a partial reset
        confs[alias] = { hits: SEED_HITS, misses: 0, lastSeen: Date.now() };
        changed = true;
      }

      // S1: ensure concept placeholder exists so brain can resolve to a value
      if (!concepts[concept]) {
        concepts[concept] = {
          value: '', updatedAt: Date.now(), urlOverrides: {}, manualOnly: false,
        };
        changed = true;
      }
    });

    if (changed) {
      await _chromeSave({ af_aliases: aliases, af_confidence: confs, af_concepts: concepts });
      _aliasGeneration++;  // C2: invalidate TF-IDF index
    }
  });
}
