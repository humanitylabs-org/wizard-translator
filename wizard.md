---
wizard: 0.2
id: translator
name: Translator
type: service
category: app
version: 0.1.0
summary: Translate text between Thai, English and other languages privately on your own box.
license: GPL-3.0-only
source: https://github.com/owner/translator
runtime:
  kind: runtipi
  config: runtipi/config.json
  compose: runtipi/docker-compose.yml
api:
  port: 8799
  path: /api
  spec: openapi.json
mcp:
  path: /mcp
  port: 8799
  transport: streamable-http
skill: skill/SKILL.md
view:
  path: /
  port: 8799
  source:
    path: web
    build: python3 app/build_view.py
    dist: web
provides:
- translation
system: false
uses: []
needs: []
receives_voice_input: true
health: /healthz
switches:
  contract: wizard.app-switches/1
  path: /api/switches
---

# Translator

A private Google Translate for the box: pick the languages (Detect, Thai, English, Japanese, Chinese, Korean,
Vietnamese, Spanish, French, German, Russian), type or paste, and the translation appears as you type. Swap, copy, and
tap a recent translation to bring it back. Nothing leaves the box.

**Engine.** `translator-engine` is the unmodified LibreTranslate v1.9.6 image (AGPL-3.0, pinned by digest; see
NOTICE.md), a second service in the same Runtipi compose with no published port. It loads ten Argos models
(`LT_LOAD_ONLY`), one gunicorn worker, and keeps the downloaded models in `data/models` (about 2.2 GB; first start
downloads them, then the engine works offline). The app server (`app/server.py`, stdlib) proxies the documented
LibreTranslate API; the view and MCP use the same service layer.

**API.** `POST /api/translate {text, source|auto, target}` · `GET /api/languages` · `GET /api/history` ·
`POST /api/history` (idempotent by id) · `POST /api/history/clear` · `GET/POST /api/prefs`. See `openapi.json`.

**MCP.** `translate(text, source, target)`, `languages()`, `history(limit)`.

**Switches.** `voice-input` (off by default): when on, Wizard voice can send what the owner says into the source box
(shared `WizardApp.voiceInput`); the app builds no recorder of its own.

**Packaging.** `python3 tools/package.py` runs `wam package-inline` and then adds the engine service to
`runtipi/docker-compose.yml` and the developer-proof overlay `stage/stack.compose.yml`. Run it after every source edit.

Appearance decisions: [the canonical Wizard app style guide](https://github.com/humanitylabs-org/wizard-os/blob/main/style/APP-DESIGN-RULES.md).
