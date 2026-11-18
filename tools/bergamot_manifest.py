#!/usr/bin/env python3
"""Pin the Firefox Translations (Bergamot) files this app may download: writes app/bergamot_models.json.

Reads Mozilla's public Remote Settings (the same records Firefox uses), picks the newest desktop release of each
English pair for LANGS plus the bergamot-translator WASM, and records each attachment's CDN location, size and sha256.
The app downloads only these files and checks every byte against the pinned sha256. Re-run to move to newer models.
"""
import json
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RS = 'https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/'
CDN = 'https://firefox-settings-attachments.cdn.mozilla.net/'
LANGS = ['th', 'ja', 'zh-Hans', 'ko', 'vi', 'es', 'fr', 'de', 'ru']
WASM_VERSION = '3.0'   # matches web/vendor/bergamot-translator.js (Firefox's v0.6.0+eea6e5a8 glue)


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'wizard-translator'}), timeout=60) as r:
        return json.load(r)


def vkey(v):
    return [int(x) for x in re.findall(r'\d+', v)]


def main():
    recs = get(RS + 'translations-models/records')['data']
    pairs = {}
    for lang in LANGS:
        for pair in ((lang, 'en'), ('en', lang)):
            rs = [r for r in recs if (r['fromLang'], r['toLang']) == pair and 'a' not in r['version']
                  and "OS == 'Android'" not in (r.get('filter_expression') or '')]
            if not rs:
                print('no model for', pair); continue
            top = max(rs, key=lambda r: vkey(r['version']))['version']
            files = {}
            for r in rs:
                if r['version'] == top:
                    a = r['attachment']
                    files[r['fileType']] = {'name': r['name'], 'location': a['location'], 'size': a['size'], 'sha256': a['hash']}
            pairs[f'{pair[0]}-{pair[1]}'] = {'version': top, 'files': files}
    w = [r for r in get(RS + 'translations-wasm/records')['data'] if r['name'] == 'bergamot-translator' and r['version'] == WASM_VERSION][0]
    a = w['attachment']
    out = {'source': 'Mozilla Firefox Translations (Remote Settings main/translations-models, translations-wasm)',
           'cdn': CDN, 'license': 'Models: MPL-2.0 / CC-BY-SA per Mozilla; bergamot-translator: MPL-2.0',
           'wasm': {'version': WASM_VERSION, 'location': a['location'], 'size': a['size'], 'sha256': a['hash']},
           'pairs': pairs}
    (ROOT / 'app/bergamot_models.json').write_text(json.dumps(out, indent=1, sort_keys=True) + '\n')
    print('pinned', len(pairs), 'pairs:', ', '.join(sorted(pairs)))


if __name__ == '__main__':
    main()
