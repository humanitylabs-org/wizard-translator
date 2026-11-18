'use strict';
const el = id => document.getElementById(id);
const AUTO = { code: 'auto', name: 'Detect language', local: 'Detect language' };
let langs = [
  { code: 'en', name: 'English' }, { code: 'th', name: 'Thai', local: 'ไทย' }, { code: 'ja', name: 'Japanese', local: '日本語' },
  { code: 'zh-Hans', name: 'Chinese', local: '中文' }, { code: 'ko', name: 'Korean', local: '한국어' },
];
const state = { source: 'auto', target: 'th', detected: null, result: '', resultFor: '', history: [], seq: 0, voice: false,
  mode: 'auto', speaker: 'male', server: { linked: false, removed: false }, via: '' };
const TINFOIL = new URL('../wizard-tinfoil/', location.href).pathname; // the Tinfoil app, same origin through Wizard

// Script-based guess, same rules as the server: enough to choose the on-device model.
function detect(text) {
  const tests = [['th', /[\u0e00-\u0e7f]/], ['ja', /[\u3040-\u30ff]/], ['ko', /[\uac00-\ud7af]/], ['zh-Hans', /[\u4e00-\u9fff]/], ['ru', /[\u0400-\u04ff]/]];
  for (const [c, rx] of tests) if (rx.test(text)) return c;
  if (/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(text)) return 'vi';
  return /[a-z]/i.test(text) ? 'en' : null;
}

function say(text, kind = '') { // kind: '' screen readers only, 'error' visible
  const s = el('status');
  s.classList.toggle('wz-sr', !kind);
  s.textContent = text;
}
async function request(path, data) {
  const init = data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
  const response = await fetch(path, init);
  let body = {};
  try { body = await response.json(); } catch (e) {}
  if (!response.ok) throw new Error(body.error || 'The translator could not do that. Try again.');
  return body;
}
const nameOf = code => code === 'auto' ? AUTO.name : (langs.find(l => l.code === code) || { name: code }).name;

function renderLangs() {
  el('source').textContent = nameOf(state.source);
  el('target').textContent = nameOf(state.target);
  el('result').lang = state.target;
  el('text').lang = state.source === 'auto' ? (state.detected || '') : state.source;
}
function renderResult() {
  el('result').textContent = state.result;
  el('placeholder').hidden = !!state.result;
  el('copy').disabled = !state.result;
  el('clear').hidden = !el('text').value;
  const det = state.source === 'auto' && state.detected && el('text').value.trim() ? 'Detected: ' + nameOf(state.detected) : '';
  el('detected').textContent = det;
}
function renderHistory() {
  const list = el('recent'); list.replaceChildren();
  el('recent-sec').hidden = !state.history.length;
  for (const item of state.history.slice(0, 15)) {
    const li = document.createElement('li');
    const row = document.createElement('button'); row.type = 'button'; row.className = 'wz-row tr-recent';
    const main = document.createElement('span'); main.className = 'wz-main';
    const b = document.createElement('b'); b.textContent = item.text; b.lang = item.detected || (item.source === 'auto' ? '' : item.source);
    const sm = document.createElement('small'); sm.textContent = item.translation; sm.lang = item.target;
    main.append(b, sm);
    const tag = document.createElement('span'); tag.className = 'tr-tag';
    tag.textContent = (item.source === 'auto' ? (item.detected || 'auto') : item.source).split('-')[0] + ' → ' + item.target.split('-')[0];
    row.append(main, tag);
    row.setAttribute('aria-label', item.text + ', translated: ' + item.translation);
    row.onclick = () => restore(item);
    li.append(row); list.append(li);
  }
}

// Tapping a recent translation restores it at once, without asking the engine again.
function restore(item) {
  state.seq++; clearTimeout(timer);
  state.source = item.source; state.target = item.target; state.detected = item.detected;
  el('text').value = item.text; state.result = item.translation; state.resultFor = key(item.text);
  el('busy').textContent = '';
  renderLangs(); renderResult();
  el('text').focus({ preventScroll: true });
  savePrefs();
}

const key = text => state.source + '|' + state.target + '|' + text.trim();
let timer = null;
function schedule(delay = 650) {
  clearTimeout(timer);
  const text = el('text').value;
  renderResult();
  if (!text.trim()) { state.seq++; state.result = ''; state.resultFor = ''; state.detected = null; el('busy').textContent = ''; renderResult(); return; }
  if (key(text) === state.resultFor) return;
  timer = setTimeout(translateNow, delay);
}
const VIA = { device: 'On this device', tinfoil: 'Private AI', fallback: 'On this device · private AI unavailable' };
function showVia(via) { state.via = via; el('busy').textContent = via ? VIA[via] : ''; }

// Two engines work together: this device answers at once when it has the models (and is the only engine in
// "Only this device" mode or without a connection); the private AI on the box then replaces it with the better text.
async function translateNow() {
  clearTimeout(timer);
  const text = el('text').value;
  if (!text.trim()) return;
  const mine = ++state.seq, k = key(text);
  const from = state.source === 'auto' ? detect(text) : state.source;
  // Typed in the target language with Detect on (Thai text, target Thai): turn the target around, as a Thai/English
  // speaker means "the other one".
  if (state.source === 'auto' && from && from === state.target) { state.target = from === 'en' ? 'th' : 'en'; renderLangs(); savePrefs(); }
  const to = state.target;
  const useServer = state.mode !== 'device' && navigator.onLine !== false;
  let draft = null;
  el('busy').textContent = 'Translating…';
  if (from && from !== to && await Device.ready(from, to)) {
    try {
      draft = await Device.translate(text, from, to);
      if (mine !== state.seq) return;
      state.result = draft.text; state.resultFor = useServer ? '' : k; state.detected = state.source === 'auto' ? from : null;
      renderLangs(); renderResult();
      showVia('device'); if (useServer) el('busy').textContent = 'On this device · improving…';
    } catch (e) { draft = null; }
  }
  if (!useServer) {
    if (mine !== state.seq) return;
    if (draft) { saveDeviceResult(text, from); say(''); }
    else { showVia(''); say(Device.supported ? 'Download this language on Engines to translate on this device.' : 'This browser cannot translate on the device.', 'error'); }
    return;
  }
  try {
    const r = await request('api/translate', { text, source: state.source, target: state.target });
    if (mine !== state.seq) return; // a newer edit is on its way; never show a stale answer
    state.result = r.translation; state.resultFor = k; state.detected = r.detected;
    showVia(r.engine === 'tinfoil' ? 'tinfoil' : ''); say('');
    renderLangs(); renderResult(); loadHistory();
    return r;
  } catch (error) {
    if (mine !== state.seq) return;
    if (draft) { state.resultFor = k; showVia('fallback'); saveDeviceResult(text, from); say(''); return; }
    showVia('');
    const hint = /not linked/i.test(error.message) ? ' Open Engines to link it, or download a language for this device.' : '';
    say(error.message + hint, 'error');
  }
}
function saveDeviceResult(text, from) {
  if (navigator.onLine === false) return;
  request('api/history', { text, translation: state.result, source: state.source === 'auto' ? (from || 'auto') : state.source, target: state.target })
    .then(r => { state.history = r.history; renderHistory(); }).catch(() => {});
}

let prefTimer = null;
function savePrefs() {
  clearTimeout(prefTimer);
  prefTimer = setTimeout(() => request('api/prefs', { source: state.source, target: state.target, engine: state.mode, speaker: state.speaker }).catch(() => {}), 300);
}

// ---- pickers (one shared sheet) ----
let picking = null;
function openPicker(which) {
  picking = which;
  el('picker-h').textContent = which === 'source' ? 'Translate from' : 'Translate to';
  const list = el('picker-list'); list.replaceChildren();
  const options = which === 'source' ? [AUTO, ...langs] : langs;
  for (const lang of options) {
    const li = document.createElement('li');
    const row = document.createElement('button'); row.type = 'button'; row.className = 'wz-row';
    row.setAttribute('role', 'menuitemradio');
    row.setAttribute('aria-checked', String(state[which] === lang.code));
    const main = document.createElement('span'); main.className = 'wz-main';
    const b = document.createElement('b'); b.textContent = lang.name; main.append(b);
    if (lang.local && lang.local !== lang.name) { const s = document.createElement('small'); s.textContent = lang.local; s.lang = lang.code; main.append(s); }
    row.append(main);
    row.onclick = () => pick(lang.code);
    li.append(row); list.append(li);
  }
  WzSheet.open(el('picker'));
}
function pick(code) {
  const which = picking;
  WzSheet.close(el('picker'));
  if (!which) return;
  const other = which === 'source' ? 'target' : 'source';
  if (state[other] === code) { swap(); return; } // picking the other side's language swaps, like Google Translate
  state[which] = code;
  if (which === 'source') state.detected = null;
  renderLangs(); renderResult(); savePrefs(); schedule(0);
}
function swap() {
  const from = state.source === 'auto' ? (state.detected || (state.target === 'en' ? 'th' : 'en')) : state.source;
  const text = el('text').value;
  state.source = state.target; state.target = from; state.detected = null;
  if (state.result && text.trim()) { el('text').value = state.result; state.result = text; state.resultFor = key(el('text').value); }
  renderLangs(); renderResult(); savePrefs(); schedule(0);
}

async function copy() {
  const text = state.result; if (!text) return;
  const label = el('copy').querySelector('span');
  label.textContent = 'Copied';
  setTimeout(() => { label.textContent = 'Copy'; }, 1400);
  try { await navigator.clipboard.writeText(text); say('Translation copied.'); }
  catch (e) {
    const sel = window.getSelection(); const range = document.createRange();
    range.selectNodeContents(el('result')); sel.removeAllRanges(); sel.addRange(range);
    let ok = false; try { ok = document.execCommand('copy'); } catch (_) {}
    if (!ok) { label.textContent = 'Copy'; say('Copy is blocked here. The translation is selected; copy it from the menu.', 'error'); }
  }
}

function loadHistory() {
  return request('api/history?limit=15').then(r => { state.history = r.history; renderHistory(); }).catch(() => {});
}
function loadLanguages() {
  return request('api/languages').then(async r => {
    langs = r.languages; state.server = r.server || state.server;
    Device.setManifest(r.offline);
    renderLangs(); renderEngines();
    if (!state.server.linked && !state.server.removed) { if (await linkTinfoil()) renderEngines(); }
    autoDownload();
  }).catch(() => { renderEngines(); setTimeout(loadLanguages, 15000); });
}

// ---- engines: the Tinfoil link (server) and models on this device ----
// Like Messenger and Search: this owner page asks the Tinfoil app for a Translator-only token and hands it to the
// box. The Tinfoil key never leaves the Tinfoil app; Remove there (or Unlink here) revokes the token.
async function linkTinfoil() {
  try {
    // (Tinfoil's api/connection is box-only, so the page asks for the token directly: 409 = not connected yet.)
    const r = await fetch(TINFOIL + 'api/app-tokens', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Wizard-Request': '1' }, body: JSON.stringify({ app: 'translator' }) });
    if (!r.ok) { state.server.tinfoil = r.status === 409 ? 'not_connected' : r.status === 404 ? 'missing' : 'error'; return false; }
    const grant = await r.json().catch(() => null);
    if (!grant?.token) return false;
    state.server = await request('api/tinfoil', { token: grant.token });
    return state.server.linked;
  } catch (e) { return false; }
}
async function unlinkTinfoil() {
  state.server = { ...state.server, linked: false, removed: true }; renderEngines();
  await request('api/tinfoil/unlink', {}).then(s => { state.server = s; }).catch(() => {});
  fetch(TINFOIL + 'api/app-tokens/remove', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Wizard-Request': '1' },
    body: JSON.stringify({ app: 'translator' }) }).catch(() => {});
  renderEngines();
}
const progress = {};
const mb = n => Math.round(n / 1e6) + ' MB';
async function renderEngines() {
  const s = state.server, pill = el('engine');
  const offline = [];
  for (const b of Device.bundles()) if (await Device.has(b.pairs[0]) && await Device.has(b.pairs[1])) offline.push(b.lang);
  pill.className = 'wz-pill ' + (s.linked ? 'ok' : offline.length ? 'ok' : 'warn');
  pill.textContent = s.linked ? 'Private AI' : offline.length ? 'On device' : 'Not set up';
  const names = offline.map(nameOf).join(', ');
  el('engines-sub').textContent = (s.linked ? 'Private AI (Tinfoil)' : 'Private AI not linked') + (offline.length ? ' · offline: ' + names : '');
  el('tinfoil-sub').textContent = s.linked ? 'Linked · ' + (s.model || 'model') + ' in a Tinfoil secure enclave; the text is not kept'
    : s.tinfoil === 'missing' ? 'Install and connect the Tinfoil app to use it' : s.tinfoil === 'not_connected' ? 'Connect Tinfoil on its page first' : 'Not linked';
  const act = el('tinfoil-act'); act.hidden = false; act.textContent = s.linked ? 'Unlink' : 'Link';
  act.onclick = async () => { if (state.server.linked) return unlinkTinfoil(); act.textContent = 'Linking…'; await linkTinfoil(); renderEngines(); };
  for (const m of ['auto', 'device']) el('mode-' + m).setAttribute('aria-checked', String(state.mode === m));
  for (const g of ['male', 'female']) el('speaker-' + g).setAttribute('aria-checked', String(state.speaker === g));
  const list = el('offline-list'); list.replaceChildren();
  if (!Device.supported) { const li = document.createElement('li'); li.className = 'tr-note tr-pad'; li.textContent = 'This browser cannot run the on-device engine.'; list.append(li); return; }
  for (const b of Device.bundles()) {
    const li = document.createElement('li'); li.className = 'tr-offline';
    const row = document.createElement('div'); row.className = 'wz-row';
    const main = document.createElement('span'); main.className = 'wz-main';
    const t = document.createElement('b'); t.textContent = nameOf(b.lang) + ' ↔ English';
    const sm = document.createElement('small');
    const have = offline.includes(b.lang), p = progress[b.lang];
    sm.textContent = p !== undefined ? 'Downloading… ' + Math.round(p * 100) + '%' : have ? 'On this device' : mb(b.size);
    main.append(t, sm);
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'wz-button secondary';
    btn.textContent = have ? 'Remove' : 'Download'; btn.disabled = p !== undefined;
    btn.onclick = () => have ? Device.remove(b.pairs[0]).then(() => Device.remove(b.pairs[1])).then(renderEngines) : getBundle(b);
    row.append(main, btn); li.append(row); list.append(li);
  }
}
async function getBundle(b) {
  progress[b.lang] = 0; renderEngines();
  let last = 0;
  try {
    for (const [i, pair] of b.pairs.entries()) {
      await Device.download(pair, f => { progress[b.lang] = (i + f) / b.pairs.length; if (Date.now() - last > 400) { last = Date.now(); renderEngines(); } });
    }
  } catch (e) { say(e.message, 'error'); delete progress[b.lang]; renderEngines(); return false; }
  delete progress[b.lang]; renderEngines();
  return true;
}
// Thai <-> English is the pair that matters on the street: fetch it once by itself when the connection isn't metered.
function autoDownload() {
  const c = navigator.connection;
  if (!Device.supported || !Device.manifest || c?.saveData || c?.type === 'cellular' || localStorage.getItem('translator-auto-th') === 'done') return;
  const th = Device.bundles().find(b => b.lang === 'th');
  if (!th) return;
  getBundle(th).then(ok => { if (ok) localStorage.setItem('translator-auto-th', 'done'); });
}

// ---- voice: shared Wizard voice input sends spoken text here (switch voice-input, off by default) ----
function registerVoice() {
  if (!state.voice || !window.WizardApp?.voiceInput) return;
  WizardApp.voiceInput.register({
    snapshot: () => document.hidden ? null : { label: 'Translator: text to translate', context: { source: state.source, target: state.target } },
    receive: async (message, authorize) => {
      authorize();
      el('text').value = message.text.slice(0, 5000);
      state.resultFor = '';
      renderResult();
      translateNow();
      return { accepted: true, request_id: message.request_id };
    },
  });
}

el('text').addEventListener('input', () => schedule());
el('text').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); translateNow(); } });
el('source').onclick = () => openPicker('source');
el('target').onclick = () => openPicker('target');
el('swap').onclick = swap;
el('copy').onclick = copy;
el('clear').onclick = () => { el('text').value = ''; schedule(); el('text').focus(); };
el('engines').onclick = () => { renderEngines(); WzSheet.open(el('settings')); };
for (const m of ['auto', 'device']) el('mode-' + m).onclick = () => { state.mode = m; savePrefs(); renderEngines(); state.resultFor = ''; schedule(0); };
for (const g of ['male', 'female']) el('speaker-' + g).onclick = () => { state.speaker = g; savePrefs(); renderEngines(); state.resultFor = ''; schedule(0); };
window.addEventListener('online', () => { state.resultFor = ''; schedule(0); });

if (!window.WizardApp || WizardApp.version !== 1) {
  say('Wizard system functions are unavailable. Open this preview through Wizard.', 'error');
} else {
  WizardApp.ready({ name: 'translator', version: '0.2.0' });
  // One screen: the picker sheet registers its own Back step through WzSheet.
  WizardApp.back.register({ canGoBack: () => false, back: () => false });
}

renderLangs(); renderResult();
request('api/prefs').then(p => {
  if (!el('text').value) { state.source = p.source; state.target = p.target; renderLangs(); }
  state.mode = p.engine || 'auto'; state.speaker = p.speaker || 'male';
  state.voice = !!p.features?.voice_input; registerVoice();
}).catch(() => {});
loadLanguages();
loadHistory();
