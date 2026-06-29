<div align="center">
  <img src="icons/icon128.png" width="80" height="80" alt="AutoFill Logo" />
  <h1>AutoFill — Smart Form Filler</h1>
  <p>A self-learning Chrome & Edge extension that fills Google Forms in one click.</p>

  <p>
    <img src="https://img.shields.io/badge/Manifest-V3-blue?style=flat-square" />
    <img src="https://img.shields.io/badge/Version-3.0.0-green?style=flat-square" />
    <img src="https://img.shields.io/badge/Platform-Chrome%20%7C%20Edge-orange?style=flat-square" />
    <img src="https://img.shields.io/badge/License-MIT-lightgrey?style=flat-square" />
  </p>
</div>

---

## What is AutoFill?

AutoFill saves your personal information once and fills Google Forms automatically. Unlike simple autofill tools, AutoFill has a **Brain engine** — it learns from every form you fill and maps label variations like `"Student Name"`, `"Full name"`, and `"Name of applicant"` all to the same stored value, without any manual setup.

---

## Features

| Feature | Description |
|---------|-------------|
| 🧠 **Brain Engine** | Self-learning alias system that maps field label variants automatically |
| ⚡ **One-Click Fill** | Fills all matched fields in a single click |
| 👁️ **Fill Preview** | Review every match before committing |
| 📊 **Confidence Scores** | See how certain the Brain is for each field |
| 🔒 **Manual-Only Toggle** | Protect sensitive fields (OTPs, passwords) from auto-fill |
| 🌐 **URL Context** | Different answers for different form URLs |
| 📤 **Export / Import** | Backup and restore your Brain data as JSON |
| 🔄 **Passive Learning** | Learns silently even when you fill forms manually |
| 🛡️ **Privacy First** | All data stored locally — nothing ever sent to a server |

---

## How It Works

```
1. Open the extension → Dashboard opens
2. Add your info in "My Info" (name, email, phone, etc.)
3. Open any Google Form
4. Click the AutoFill icon → "Fill This Form"
5. Preview matches → Confirm → Done ✓
```

The Brain engine runs entirely in the background service worker and updates its alias index every time you fill a form.

---

## Architecture

```
AutoFill/
├── manifest.json               # MV3 manifest
├── background/
│   ├── brain_worker.js         # Service worker entry point
│   ├── brain.js                # Core Brain engine (TF-IDF + alias learning)
│   ├── brain-api.js            # Message bus between Brain and UI
│   └── background.js           # Icon click → open dashboard
├── content/
│   └── content.js              # Injected into Google Forms pages
├── dashboard/
│   ├── dashboard.html/js/css   # Full-page dashboard (My Info, Settings, About)
│   ├── brain-tab.html/js/css   # Brain tab (concepts, aliases, confidence)
│   └── fonts/                  # Self-hosted Inter font (no CDN)
├── popup/
│   └── popup.html/js/css       # Compact popup UI
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

### Brain Engine — How It Learns

```
User fills "Student Name" field manually
        ↓
Content script detects the value matches "Full Name" concept
        ↓
Brain adds "student name" as an alias for "full_name" concept
        ↓
Next form with "Student Name" → filled automatically ✓
```

---

## Installation

### From the Store
- **Microsoft Edge** → [Edge Add-ons Store](#) *(under review)*
- **Chrome** → [Chrome Web Store](#) *(under review)*

### Manual (Developer Mode)
```
1. Download or clone this repository
2. Open chrome://extensions  (or  edge://extensions)
3. Enable "Developer mode"
4. Click "Load unpacked"
5. Select the AutoFill folder
```

---

## Permissions

| Permission | Why it's needed |
|------------|----------------|
| `storage` | Save My Info fields and Brain data locally on your device |
| `activeTab` | Detect when you're on a Google Forms page |
| `scripting` | Inject the fill action when you click "Fill This Form" |
| `tabs` | Send fill results back to the dashboard |
| `host: docs.google.com/forms/*` | Run content script on Google Forms pages only |

---

## Privacy

- ✅ All data stored locally via browser's built-in storage API
- ✅ No analytics, telemetry, or crash reporting
- ✅ No external network requests from background or content scripts
- ✅ No `eval()` — fully CSP-compliant
- ✅ Fonts self-hosted (no Google Fonts CDN)

Read the full [Privacy Policy](privacy_policy.html).

---

## Tech Stack

- **Manifest V3** service worker architecture
- **Vanilla JS** — zero dependencies, no build step required
- **TF-IDF + cosine similarity** for semantic label matching
- **chrome.storage.local** for all persistence
- **Self-hosted Inter** font (400 / 500 / 600)

---

## Roadmap

- [ ] Support for other form platforms (Typeform, Microsoft Forms)
- [ ] Cloud sync (opt-in, end-to-end encrypted)
- [ ] Per-field confidence threshold configuration
- [ ] Browser-native autofill integration

---

## License

MIT © 2025 AutoFill

---

<div align="center">
  <sub>Built with ❤️ — works on Chrome & Edge</sub>
</div>
