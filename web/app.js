'use strict';
const el = id => document.getElementById(id);
const AUTO = { code: 'auto', name: 'Detect language', local: 'Detect language' };
let langs = [
  { code: 'en', name: 'English' }, { code: 'th', name: 'Thai', local: 'ไทย' }, { code: 'ja', name: 'Japanese', local: '日本語' },
  { code: 'zh-Hans', name: 'Chinese', local: '中文' }, { code: 'ko', name: 'Korean', local: '한국어' },
];
const state = { source: 'auto', target: 'th', detected: null, result: '', resultFor: '', history: [], seq: 0, voice: false };

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
async function translateNow() {
  clearTimeout(timer);
  const text = el('text').value;
  if (!text.trim()) return;
  const mine = ++state.seq, k = key(text);
  el('busy').textContent = 'Translating…';
  try {
    const r = await request('api/translate', { text, source: state.source, target: state.target });
    if (mine !== state.seq) return; // a newer edit is on its way; never show a stale answer
    state.result = r.translation; state.resultFor = k; state.detected = r.detected;
    el('busy').textContent = ''; say('');
    renderLangs(); renderResult(); loadHistory();
    return r;
  } catch (error) {
    if (mine !== state.seq) return;
    el('busy').textContent = '';
    say(error.message, 'error');
  }
}

let prefTimer = null;
function savePrefs() {
  clearTimeout(prefTimer);
  prefTimer = setTimeout(() => request('api/prefs', { source: state.source, target: state.target }).catch(() => {}), 300);
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
  return request('api/languages').then(r => {
    langs = r.languages;
    const pill = el('engine');
    pill.className = 'wz-pill ' + (r.engine === 'ready' ? 'ok' : 'warn');
    pill.textContent = r.engine === 'ready' ? 'Private' : 'Engine starting';
    pill.title = r.engine === 'ready' ? 'Translations stay on this box' : 'The private engine is loading its language models';
    renderLangs();
    if (r.engine !== 'ready') setTimeout(loadLanguages, 15000);
  }).catch(() => setTimeout(loadLanguages, 15000));
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

if (!window.WizardApp || WizardApp.version !== 1) {
  say('Wizard system functions are unavailable. Open this preview through Wizard.', 'error');
} else {
  WizardApp.ready({ name: 'translator', version: '0.1.0' });
  // One screen: the picker sheet registers its own Back step through WzSheet.
  WizardApp.back.register({ canGoBack: () => false, back: () => false });
}

renderLangs(); renderResult();
request('api/prefs').then(p => {
  if (!el('text').value) { state.source = p.source; state.target = p.target; renderLangs(); }
  state.voice = !!p.features?.voice_input; registerVoice();
}).catch(() => {});
loadLanguages();
loadHistory();
