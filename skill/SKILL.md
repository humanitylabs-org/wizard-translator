---
name: translator
description: Use when the owner wants text translated (Thai, English and more) privately, or asks about recent translations.
---

# Translator

Private translation on this box (self-hosted LibreTranslate; nothing leaves the box). Thai <-> English is the main
pair; also Japanese, Chinese (zh-Hans), Korean, Vietnamese, Spanish, French, German, Russian. Every pair works
(non-English pairs pivot through English, so quality is lower than direct Thai<->English).

## Tools (MCP on the Translator app)

- `translate(text, target, source="auto", save=true)` → `{text, translation, source, target, detected, id}`.
  Use `source="auto"` unless the owner names the language; `detected` tells you what auto found. Max 5000 characters
  per call: split longer text by paragraph. Saved to the app's Recent list unless `save=false` (use `save=false` for
  bulk or agent-internal work so the owner's Recent list stays his).
- `languages()` → `{engine: "ready"|"offline", languages: [{code, name, local}]}`. `offline` means the engine is still
  downloading/loading its models (first start takes several minutes): say so and retry later; never fall back to an
  online service without asking.
- `history(limit=20)` → `{history: [{id, text, translation, source, target, detected, updated}]}`, newest first.

## Notes

- Machine translation: fine for signs, menus, messages, directions; for contracts, medical or legal text, say it is a
  machine translation and suggest a human check.
- Thai has no spaces between words; pass it as-is.
- The owner opens the app at `?open=translator`. Speaking into it is behind the `voice-input` switch (off by default).
