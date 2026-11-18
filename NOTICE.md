# Source and license notice

Translator was started from Wizard App Manager's hello reference template (GPL-3.0-only, matching this repository's
LICENSE; no warranty) and rewritten for translation on 18 November 2026 for Miguel's box.

## Translation engine

Translations are made by **LibreTranslate** (https://github.com/LibreTranslate/LibreTranslate), Copyright (c)
LibreTranslate contributors, licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0). This app runs
the unmodified upstream image `libretranslate/libretranslate:v1.9.6` pinned by digest
(`sha256:1de2d7056bb8ad607a412f4563d9abe324ff632b43b5be9428bcc8e213aebb32`) as a separate container on the app's own
network; it is never published, and only this app talks to it through LibreTranslate's documented HTTP API
(`/languages`, `/translate`). Its source and license are at the link above (the license is also inside the image at
`/app/LICENSE`). LibreTranslate is built on **Argos Translate** (MIT) and its OpenNMT/CTranslate2 language models,
which are downloaded from the Argos package index on first start and keep their own licenses.

The view loads the centrally maintained `/wizard-os-home/core/app-client.js` (shared system functions v1). Python and
base image components retain their upstream licenses. No public app repository or signed publication is created by
the builder helpers.
