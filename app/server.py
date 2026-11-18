"""Translator: one API/service layer used by the view and MCP.

The engine is a private LibreTranslate sidecar (AGPL-3.0, unmodified upstream image) on the app's own network;
only this server talks to it. Stdlib only. The host gateway owns authentication; direct ports stay loopback.
"""
import json
import os
import sqlite3
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent.parent if '__file__' in globals() else Path(os.environ.get('APP_ROOT', '.')).resolve()
DATA = Path(os.environ.get('DATA_DIR', ROOT / '.data'))
APP_ID = 'translator'
VERSION = '0.1.0'
ENGINE = os.environ.get('ENGINE_URL', 'http://translator-engine:5000').rstrip('/')
STATIC_TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml'}
MAX_TEXT = 5000
HISTORY_KEEP = 200
MERGE_SECONDS = 90  # typing "Where is" then "Where is the BTS" within this window refines one history row

# Shown before the engine answers, so the pickers work while models load. Codes are LibreTranslate's.
FALLBACK_LANGUAGES = [
    {'code': 'en', 'name': 'English'}, {'code': 'th', 'name': 'Thai'}, {'code': 'ja', 'name': 'Japanese'},
    {'code': 'zh-Hans', 'name': 'Chinese'}, {'code': 'ko', 'name': 'Korean'}, {'code': 'vi', 'name': 'Vietnamese'},
    {'code': 'es', 'name': 'Spanish'}, {'code': 'fr', 'name': 'French'}, {'code': 'de', 'name': 'German'},
    {'code': 'ru', 'name': 'Russian'},
]
LOCAL_NAMES = {'th': 'ไทย', 'ja': '日本語', 'zh-Hans': '中文', 'ko': '한국어', 'vi': 'Tiếng Việt',
               'es': 'Español', 'fr': 'Français', 'de': 'Deutsch', 'ru': 'Русский', 'en': 'English'}
_cache = {'at': 0.0, 'langs': None}
_lock = threading.Lock()


class Problem(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message


def connect():
    DATA.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DATA / 'translator.sqlite3', timeout=10)
    c.row_factory = sqlite3.Row
    c.execute('CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, text TEXT NOT NULL, translation TEXT NOT NULL, '
              'source TEXT NOT NULL, target TEXT NOT NULL, detected TEXT, created REAL NOT NULL, updated REAL NOT NULL)')
    c.execute('CREATE TABLE IF NOT EXISTS prefs (k TEXT PRIMARY KEY, v TEXT NOT NULL)')
    return c


# ---- engine -------------------------------------------------------------------------------------------------------
def _engine(path, body=None, timeout=60):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(ENGINE + path, data=data, method='GET' if body is None else 'POST',
                                 headers={'Content-Type': 'application/json'} if body is not None else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read()).get('error') or ''
        except ValueError:
            msg = ''
        raise Problem(400 if e.code == 400 else 502, msg or f'The translation engine answered {e.code}.') from None
    except (urllib.error.URLError, OSError, ValueError):
        raise Problem(503, 'The translation engine is starting or offline. Try again in a minute.') from None


def languages():
    """{engine: ready|offline, languages:[{code,name,local}]}. Cached for 10 minutes once the engine answers."""
    with _lock:
        if _cache['langs'] and time.time() - _cache['at'] < 600:
            return {'engine': 'ready', 'languages': _cache['langs']}
    try:
        raw = _engine('/languages', timeout=5)
        langs = [{'code': l['code'], 'name': l['name'], 'local': LOCAL_NAMES.get(l['code'], l['name'])} for l in raw]
        order = {l['code']: i for i, l in enumerate(FALLBACK_LANGUAGES)}
        langs.sort(key=lambda l: (order.get(l['code'], 99), l['name']))
        with _lock:
            _cache.update(at=time.time(), langs=langs)
        return {'engine': 'ready', 'languages': langs}
    except Problem:
        return {'engine': 'offline', 'languages': [dict(l, local=LOCAL_NAMES.get(l['code'], l['name'])) for l in FALLBACK_LANGUAGES]}


def _code(value, allow_auto):
    v = str(value or '').strip()
    if v == 'zh':
        v = 'zh-Hans'
    if not v or len(v) > 12 or not all(ch.isalnum() or ch == '-' for ch in v):
        raise Problem(400, 'Use a language code such as th or en.')
    if v == 'auto' and not allow_auto:
        raise Problem(400, 'Pick a target language.')
    return v


def translate(args):
    text = args.get('text')
    if not isinstance(text, str) or not text.strip():
        raise Problem(400, 'Type something to translate.')
    if len(text) > MAX_TEXT:
        raise Problem(400, f'Translate up to {MAX_TEXT} characters at a time.')
    source, target = _code(args.get('source', 'auto'), True), _code(args.get('target'), False)
    out = {'text': text, 'source': source, 'target': target, 'detected': None}
    if source == target:
        out['translation'] = text
    else:
        r = _engine('/translate', {'q': text, 'source': source, 'target': target, 'format': 'text'})
        out['translation'] = r.get('translatedText', '')
        det = r.get('detectedLanguage')
        if isinstance(det, dict) and det.get('language'):
            out['detected'] = det['language']
            if det['language'] == target:  # auto-detect found the target language already: return it unchanged
                out['translation'] = text
    if args.get('save', True) is not False:
        out['id'] = _save(out)
    return out


# ---- history and preferences ---------------------------------------------------------------------------------------
def _row(r):
    return {k: r[k] for k in ('id', 'text', 'translation', 'source', 'target', 'detected')} | {'updated': r['updated']}


def _save(item, item_id=None):
    now = time.time()
    c = connect()
    try:
        with c:
            last = c.execute('SELECT * FROM history ORDER BY updated DESC LIMIT 1').fetchone()
            if item_id and c.execute('SELECT 1 FROM history WHERE id=?', (item_id,)).fetchone():
                rid = item_id  # idempotent replay of the same operation
                c.execute('UPDATE history SET text=?,translation=?,source=?,target=?,detected=?,updated=? WHERE id=?',
                          (item['text'], item['translation'], item['source'], item['target'], item.get('detected'), now, rid))
            elif (not item_id and last and last['source'] == item['source'] and last['target'] == item['target']
                    and now - last['updated'] < MERGE_SECONDS
                    and (item['text'].startswith(last['text'].rstrip()) or last['text'].startswith(item['text'].rstrip()))):
                rid = last['id']  # still typing the same sentence: refine one row, not one row per pause
                c.execute('UPDATE history SET text=?,translation=?,detected=?,updated=? WHERE id=?',
                          (item['text'], item['translation'], item.get('detected'), now, rid))
            else:
                rid = item_id or uuid.uuid4().hex
                c.execute('INSERT INTO history VALUES (?,?,?,?,?,?,?,?)', (rid, item['text'], item['translation'],
                          item['source'], item['target'], item.get('detected'), now, now))
            c.execute('DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY updated DESC LIMIT ?)', (HISTORY_KEEP,))
    finally:
        c.close()
    return rid


def history(limit=20):
    try:
        limit = max(1, min(int(limit), HISTORY_KEEP))
    except (TypeError, ValueError):
        raise Problem(400, 'limit must be a number.') from None
    c = connect()
    try:
        return {'history': [_row(r) for r in c.execute('SELECT * FROM history ORDER BY updated DESC LIMIT ?', (limit,))]}
    finally:
        c.close()


def add_history(args):
    """Save an already-translated pair. Idempotent by id."""
    item = {k: args.get(k) for k in ('text', 'translation', 'source', 'target')}
    if not all(isinstance(v, str) and v.strip() for v in item.values()) or len(item['text']) > MAX_TEXT \
            or len(item['translation']) > MAX_TEXT * 4:
        raise Problem(400, 'Send text, translation, source and target.')
    item['source'], item['target'] = _code(item['source'], True), _code(item['target'], False)
    item['detected'] = None
    item_id = args.get('id')
    if item_id is not None and (not isinstance(item_id, str) or not 8 <= len(item_id) <= 64 or not item_id.replace('-', '').isalnum()):
        raise Problem(400, 'id must be 8-64 letters, digits or dashes.')
    rid = _save(item, item_id or uuid.uuid4().hex)
    return {'id': rid, **history()}


def clear_history():
    c = connect()
    try:
        with c:
            c.execute('DELETE FROM history')
    finally:
        c.close()
    return history()


def prefs():
    c = connect()
    try:
        saved = {r['k']: r['v'] for r in c.execute('SELECT k,v FROM prefs')}
    finally:
        c.close()
    return {'source': saved.get('source', 'auto'), 'target': saved.get('target', 'th'),
            'features': {'voice_input': switch_on('voice-input')}}


def set_prefs(args):
    updates = {}
    if 'source' in args:
        updates['source'] = _code(args['source'], True)
    if 'target' in args:
        updates['target'] = _code(args['target'], False)
    if not updates:
        raise Problem(400, 'Send source and/or target.')
    c = connect()
    try:
        with c:
            for k, v in updates.items():
                c.execute('INSERT INTO prefs VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', (k, v))
    finally:
        c.close()
    return prefs()


# ---- MCP ------------------------------------------------------------------------------------------------------------
_LANG = {'type': 'string'}
TOOLS = [
    {'name': 'translate', 'description': 'Translate text privately on this box (Thai, English and more). Saved to recent history.',
     'inputSchema': {'type': 'object', 'properties': {
         'text': {'type': 'string', 'minLength': 1, 'maxLength': MAX_TEXT},
         'source': dict(_LANG, description='Source language code (th, en, ja, zh-Hans, ko, vi, es, fr, de, ru) or "auto" (default).'),
         'target': dict(_LANG, description='Target language code, e.g. th or en. See languages().'),
         'save': {'type': 'boolean', 'description': 'Keep in recent history (default true).'}},
         'required': ['text', 'target']}},
    {'name': 'languages', 'description': 'Languages the private engine translates between, and whether it is ready.',
     'inputSchema': {'type': 'object', 'properties': {}}},
    {'name': 'history', 'description': 'Recent translations, newest first.',
     'inputSchema': {'type': 'object', 'properties': {'limit': {'type': 'integer', 'minimum': 1, 'maximum': HISTORY_KEEP}}}},
]


def rpc(msg):
    if not isinstance(msg, dict):
        return {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32600, 'message': 'Expected a JSON-RPC object.'}}
    m, i, p = msg.get('method'), msg.get('id'), msg.get('params') or {}
    if 'id' not in msg:
        return None
    try:
        if m == 'initialize':
            r = {'protocolVersion': '2025-06-18', 'capabilities': {'tools': {}}, 'serverInfo': {'name': APP_ID, 'version': VERSION}}
        elif m == 'tools/list':
            r = {'tools': TOOLS}
        elif m == 'tools/call':
            a = p.get('arguments') or {}; n = p.get('name')
            if n == 'translate':
                value = translate(a)
            elif n == 'languages':
                value = languages()
            elif n == 'history':
                value = history(a.get('limit', 20))
            else:
                return {'jsonrpc': '2.0', 'id': i, 'error': {'code': -32602, 'message': 'Unknown tool.'}}
            r = {'content': [{'type': 'text', 'text': json.dumps(value, ensure_ascii=False)}], 'structuredContent': value, 'isError': False}
        elif m == 'ping':
            r = {}
        else:
            return {'jsonrpc': '2.0', 'id': i, 'error': {'code': -32601, 'message': 'Unknown method.'}}
    except Problem as e:
        r = {'content': [{'type': 'text', 'text': e.message}], 'isError': True}
    return {'jsonrpc': '2.0', 'id': i, 'result': r}


def _csv(name):
    return {x.strip().lower() for x in os.environ.get(name, '').split(',') if x.strip()}


# Who may talk to this app. Trust never comes from the request itself: the Host must be one this app
# was configured for (stops DNS rebinding), and a browser Origin on writes must be configured too.
_LOOPBACK = {f"127.0.0.1:{os.environ.get('PORT', '8799')}", f"localhost:{os.environ.get('PORT', '8799')}"}
TRUSTED_HOSTS = _csv('WIZARD_TRUSTED_HOSTS') | _csv('WIZARD_APP_HOSTS') | _LOOPBACK
TRUSTED_ORIGINS = _csv('WIZARD_TRUSTED_ORIGINS') | {'http://' + h for h in _LOOPBACK}


class Handler(BaseHTTPRequestHandler):
    def refused(self, write=False):
        if (self.headers.get('Host') or '').lower() not in TRUSTED_HOSTS:
            self.send(403, {'error': 'Unknown host.'})
            return True
        if write:
            origin = (self.headers.get('Origin') or '').lower()
            if origin and origin not in TRUSTED_ORIGINS:
                self.send(403, {'error': 'Cross-origin writes refused.'})
                return True
            if not origin and (self.headers.get('Sec-Fetch-Site') or '') == 'cross-site':
                self.send(403, {'error': 'Cross-origin writes refused.'})
                return True
        return False

    def send(self, code, body=None, content_type='application/json'):
        b = body if isinstance(body, bytes) else b'' if body is None else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', content_type if content_type != 'application/json' else 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(b)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'")
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(b)

    def do_GET(self):
        if self.refused():
            return
        u = urlsplit(self.path); path = u.path; q = parse_qs(u.query)
        try:
            if path == '/healthz':
                return self.send(200, {'ok': True, 'app': APP_ID, 'version': VERSION})
            if path == '/api/languages':
                return self.send(200, languages())
            if path == '/api/history':
                return self.send(200, history(q.get('limit', ['20'])[0]))
            if path == '/api/prefs':
                return self.send(200, prefs())
        except Problem as e:
            return self.send(e.code, {'error': e.message})
        name = 'index.html' if path == '/' else path[1:]
        kind = STATIC_TYPES.get(Path(name).suffix)
        if kind and '/' not in name and not name.startswith('.') and (ROOT / 'web' / name).is_file():
            return self.send(200, (ROOT / 'web' / name).read_bytes(), kind)
        if path == '/openapi.json':
            return self.send(200, (ROOT / 'openapi.json').read_bytes())
        self.send(405 if path == '/mcp' else 404, {'error': 'Use POST /mcp.' if path == '/mcp' else 'Not found.'})

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        if self.refused(write=True):
            return
        path = urlsplit(self.path).path
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.send(415, {'error': 'Use application/json.'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 <= size <= 65536:
                return self.send(413, {'error': 'Request too large.'})
            body = json.loads(self.rfile.read(size))
            if path == '/mcp':
                if not isinstance(body, dict):
                    return self.send(400, {'error': 'Expected a JSON-RPC object.'})
                out = rpc(body)
                return self.send(202 if out is None else 200, out)
            if not isinstance(body, dict):
                return self.send(400, {'error': 'Expected a JSON object.'})
            if path == '/api/translate':
                return self.send(200, translate(body))
            if path == '/api/history':
                return self.send(201, add_history(body))
            if path == '/api/history/clear':
                return self.send(200, clear_history())
            if path == '/api/prefs':
                return self.send(200, set_prefs(body))
            self.send(404, {'error': 'Not found.'})
        except Problem as e:
            self.send(e.code, {'error': e.message})
        except (ValueError, TypeError, AttributeError):
            self.send(400, {'error': 'Invalid JSON request.'})

    def log_message(self, format, *args):
        pass


# ---- wizard.app-switches/1 ------------------------------------------------------------------------------------------
# Owner feature switches for the Tracker's Try it (wizard-os docs/APP_SWITCHES.md). Shared block: the same text ships in
# every Wizard app; `wam new` starts every app with it (wizard-os AGENTS.md: a new app repo ships it in its first PR). Every new feature ships behind a switch, off by
# default: append it to SWITCHES with the issue it delivers, e.g.
#   {'id': 'compact-header', 'name': 'Compact top bar', 'description': '...', 'default': False,
#    'issues': ['humanitylabs-org/<repo>#20']}
# and gate the feature on switch_on('compact-header'). State lives on the box (DATA_DIR/switches.json), so the app's
# page, the Tracker (through the App Manager) and the agent see one state. GET/POST /api/switches, owner only, with
# X-Wizard-Switch: 1 and never a bearer or agent grant. An app with a platform owner-proof key (owner_proof in wizard.md,
# wizard-os spec/OWNER_PROOF.md) accepts only a valid signed proof: any process on the box can set the other headers.
# An app without one accepts the box's Tailscale Serve owner login, never a box-local host.
import hashlib as _sw_hashlib
import hmac as _sw_hmac
import json as _sw_json
import os as _sw_os
import re as _sw_re
import threading as _sw_threading
import time as _sw_time
from pathlib import Path as _SwPath
from urllib.parse import urlsplit as _sw_urlsplit

SWITCHES = [
    {'id': 'voice-input', 'name': 'Speak to translate',
     'description': 'Let Wizard voice send what you say into the source box, then translate it.',
     'default': False, 'issues': []},
]
_SW_CONTRACT = 'wizard.app-switches/1'
_SW_ROUTE = _sw_re.compile(r'(?:/[a-z0-9][a-z0-9-]{0,62})?/api/switches/?')
_SW_LOCAL = {'localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'}
_sw_lock = _sw_threading.Lock()
_sw_nonces = {}
_SW_PROOF = _sw_re.compile(r'(\d{1,12})\.([0-9a-f]{48})\.([0-9a-f]{64})')


def _sw_file():
    return _SwPath(_sw_os.environ.get('WIZARD_SWITCHES_DIR') or DATA) / 'switches.json'


def _sw_saved():
    try:
        saved = _sw_json.loads(_sw_file().read_text())
    except (OSError, ValueError):
        return {}
    return saved if isinstance(saved, dict) else {}


def switches_doc():
    saved = _sw_saved()
    return {'contract': _SW_CONTRACT, 'switches': [
        dict(s, on=saved[s['id']] if isinstance(saved.get(s['id']), bool) else bool(s.get('default'))) for s in SWITCHES]}


def switch_on(switch_id):
    return next((s['on'] for s in switches_doc()['switches'] if s['id'] == switch_id), False)


def _sw_set(switch_id, on):
    with _sw_lock:
        ids = {s['id'] for s in SWITCHES}
        saved = {k: v for k, v in _sw_saved().items() if k in ids and isinstance(v, bool)}
        saved[switch_id] = on
        f = _sw_file()
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_name(f.name + '.tmp')
        tmp.write_text(_sw_json.dumps(saved))
        _sw_os.replace(tmp, f)
    return switches_doc()


def _sw_proof(h):
    """None when this app has no platform owner-proof key, else whether the request carries a valid, unused proof."""
    key_file = _sw_os.environ.get('WIZARD_OWNER_PROOF_KEY_FILE')
    if not key_file:
        return None
    try:
        with open(key_file, 'rb') as f:
            key = f.read(33)
    except OSError:
        return False                    # a key is named but unreadable: refuse, never fall back to headers
    app = _sw_os.environ.get('WIZARD_OWNER_PROOF_APP') or ''
    values = h.headers.get_all('X-Wizard-App-Owner-Proof') or []
    m = _SW_PROOF.fullmatch(values[0].strip()) if len(values) == 1 else None
    if len(key) != 32 or not app or not m or abs(_sw_time.time() - int(m.group(1))) > 30:
        return False
    msg = '\n'.join(('wizard-app-owner-v1', app, m.group(1), m.group(2), h.command, h.path)).encode()
    if not _sw_hmac.compare_digest(_sw_hmac.new(key, msg, _sw_hashlib.sha256).hexdigest(), m.group(3)):
        return False
    now = _sw_time.monotonic()
    with _sw_lock:
        for n in [n for n, until in _sw_nonces.items() if until < now]:
            del _sw_nonces[n]
        if m.group(2) in _sw_nonces:
            return False
        _sw_nonces[m.group(2)] = now + 60
    return True


def _sw_owner(h, write):
    hd = h.headers
    if hd.get('Authorization') or hd.get('X-Wizard-Switch') != '1':
        return False
    proof = _sw_proof(h)
    if proof is not None:
        return proof
    if (hd.get('Sec-Fetch-Site') or 'same-origin').lower() not in ('same-origin', 'none'):
        return False
    host = (hd.get('Host') or '').strip().lower()
    name = host.split(']')[0] + ']' if host.startswith('[') else host.rsplit(':', 1)[0]
    if not name or name in _SW_LOCAL or '.' not in name:      # box-local and container hosts never prove the owner
        return False
    origin = hd.get('Origin')
    trusted = {o.strip() for o in (_sw_os.environ.get('WIZARD_TRUSTED_ORIGINS') or '').split(',') if o.strip()}
    if origin and _sw_urlsplit(origin).netloc.lower() != host and origin not in trusted:
        return False
    if write and not origin:
        return False
    logins = [x.strip() for x in (hd.get_all('Tailscale-User-Login') or [])]
    owners = {x.strip().lower() for x in (_sw_os.environ.get('WIZARD_OWNER_LOGINS') or '').split(',') if x.strip()}
    return len(logins) == 1 and '@' in logins[0] and (not owners or logins[0].lower() in owners)


def _sw_send(h, code, doc):
    body = _sw_json.dumps(doc).encode()
    h.send_response(code)
    h.send_header('Content-Type', 'application/json')
    h.send_header('Cache-Control', 'no-store')
    h.send_header('Content-Length', str(len(body)))
    h.end_headers()
    if h.command != 'HEAD':
        h.wfile.write(body)


def _sw_handle(h):
    """Serve /api/switches (or /<app>/api/switches) and return True; False for every other request."""
    if not _SW_ROUTE.fullmatch(_sw_urlsplit(h.path).path):
        return False
    if h.command in ('GET', 'HEAD'):
        if not _sw_owner(h, False):
            _sw_send(h, 403, {'error': "Only this Wizard's owner can see these switches.", 'code': 'owner_only'})
        else:
            _sw_send(h, 200, switches_doc())
        return True
    if not _sw_owner(h, True):
        _sw_send(h, 403, {'error': "Only this Wizard's owner can change these switches.", 'code': 'owner_only'})
        return True
    try:
        if (h.headers.get('Content-Type') or '').split(';')[0].strip() != 'application/json':
            raise ValueError
        size = int(h.headers.get('Content-Length') or '0')
        if size <= 0 or size > 4096:
            raise ValueError
        body = _sw_json.loads(h.rfile.read(size))
        if not isinstance(body, dict) or not isinstance(body.get('id'), str) or not isinstance(body.get('on'), bool) \
                or set(body) - {'id', 'on'}:
            raise ValueError
    except (ValueError, TypeError):
        _sw_send(h, 400, {'error': 'Send JSON {"id": "...", "on": true|false}', 'code': 'invalid_input'})
        return True
    if body['id'] not in {s['id'] for s in SWITCHES}:
        _sw_send(h, 404, {'error': 'No such switch', 'code': 'unknown_switch'})
        return True
    try:
        _sw_send(h, 200, _sw_set(body['id'], body['on']))
    except OSError:
        _sw_send(h, 500, {'error': 'storage_failure'})
    return True


def wizard_switches_install(handler_cls):
    """Route the switch endpoint ahead of the app's own GET/HEAD/POST handlers."""
    for method in ('do_GET', 'do_HEAD', 'do_POST'):
        orig = getattr(handler_cls, method, None)
        if getattr(orig, '_wizard_switches', False):
            continue

        def wrapped(self, _orig=orig):
            if _sw_handle(self):
                return None
            if _orig is None:
                return self.send_error(501)
            return _orig(self)
        wrapped._wizard_switches = True
        setattr(handler_cls, method, wrapped)
    return handler_cls
# ---- end wizard.app-switches/1 ---------------------------------------------------------------------------------------


wizard_switches_install(Handler)


if __name__ == "__main__":
    connect().close()
    (DATA / 'models').mkdir(exist_ok=True)  # the engine sidecar keeps its language models here
    ThreadingHTTPServer((os.environ.get("BIND", "0.0.0.0"), int(os.environ.get("PORT", "8799"))), Handler).serve_forever()
