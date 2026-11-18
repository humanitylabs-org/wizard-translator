# Source and license notice

Translator was started from Wizard App Manager's hello reference template (GPL-3.0-only, matching this repository's
LICENSE; no warranty) and rewritten for translation in November 2026 for Miguel's box.

## Server engine

Translations on the server are made by a private language model (default `gemma4-31b`) served by **Tinfoil**
(https://tinfoil.sh) through the box's Tinfoil app. Translator never holds the Tinfoil API key: it holds a
Translator-only token issued by the Tinfoil app, which can revoke it at any time. Model licenses are those of the models
Tinfoil serves.

## On-device engine

`web/bergamot-translator.js` is Mozilla's **bergamot-translator** JavaScript glue (v0.6.0+eea6e5a8), copied unmodified
from mozilla-firefox/firefox `toolkit/components/translations/bergamot-translator/` at commit
48d55cf7ec80093903e2ef7f58b61a84a22ef716, licensed under the **Mozilla Public License 2.0**
(https://mozilla.org/MPL/2.0/; source: https://github.com/mozilla/translations). The matching WebAssembly binary
and the **Firefox Translations** language models are not part of this repository: the app downloads the exact files
listed in `app/bergamot_models.json` (Mozilla Remote Settings attachments, pinned by sha256) from Mozilla's CDN and
keeps them on the box and the owner's device. The models keep Mozilla's licenses (see
https://github.com/mozilla/firefox-translations-models).

The view loads the centrally maintained `/wizard-os-home/core/app-client.js` (shared system functions v1). Python and
base image components retain their upstream licenses.
