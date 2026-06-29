/* ============================================================
   AutoFill v3 — background/brain_worker.js
   Single service-worker entry point.
   Load order matters: brain.js first (defines all functions),
   then brain-api.js (uses those functions), then background.js.
   ============================================================ */

importScripts('brain.js', 'brain-api.js', 'background.js');
