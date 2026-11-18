'use strict';
// The device half of Translator: Firefox Translations (Bergamot) running in a Worker on this phone or computer.
// Model files come from this box (offline/<sha256>, mirrored from Mozilla's CDN and checksum-pinned), are kept in
// Cache Storage, and are then used without any network. The server half (private AI through Tinfoil) is in app.js.
const Device = (() => {
  const CACHE = 'translator-offline-v1';
  let manifest = null, worker = null, seq = 0;
  const pending = new Map(), sent = new Set(), downloading = new Map();
  const supported = typeof WebAssembly === 'object' && 'caches' in self && typeof Worker === 'function' && isSecureContext;

  const code = c => (c === 'zh' ? 'zh-Hans' : c);
  const legs = (from, to) => (from === 'en' || to === 'en') ? [`${from}-${to}`] : [`${from}-en`, `en-${to}`];
  const pairOf = name => manifest?.pairs?.[name];
  const urls = name => Object.values(pairOf(name)?.files || {}).map(f => new URL(f.url, location.href).href);

  async function cached(url) {
    try { return await (await caches.open(CACHE)).match(url); } catch { return undefined; }
  }
  async function has(name) {
    if (!supported || !pairOf(name)) return false;
    for (const u of urls(name)) if (!(await cached(u))) return false;
    return true;
  }
  // Can this device translate from -> to right now, without the network?
  async function ready(from, to) {
    from = code(from); to = code(to);
    if (!manifest || from === to || !from || from === 'auto') return false;
    for (const leg of legs(from, to)) if (!(await has(leg))) return false;
    return !!(await cached(new URL(manifest.wasm.url, location.href).href));
  }

  async function fetchInto(cache, url, onBytes) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok || !r.body) throw new Error(r.status === 503 ? 'The box could not download the model. Try again later.' : 'Download failed.');
    const reader = r.body.getReader(), parts = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); onBytes(value.byteLength); }
    await cache.put(url, new Response(new Blob(parts), { headers: { 'Content-Type': 'application/octet-stream' } }));
  }
  // Download one pair (and the engine itself) to this device. onProgress(fraction 0..1).
  function download(name, onProgress = () => {}) {
    if (downloading.has(name)) return downloading.get(name);
    const job = (async () => {
      const cache = await caches.open(CACHE);
      const wasm = new URL(manifest.wasm.url, location.href).href;
      const files = Object.values(pairOf(name).files).map(f => ({ url: new URL(f.url, location.href).href, size: f.size }));
      if (!(await cache.match(wasm))) files.unshift({ url: wasm, size: manifest.wasm.size });
      const total = files.reduce((a, f) => a + f.size, 0); let got = 0;
      for (const f of files) {
        if (await cache.match(f.url)) { got += f.size; onProgress(got / total); continue; }
        await fetchInto(cache, f.url, n => { got += n; onProgress(Math.min(got / total, 1)); });
      }
      onProgress(1);
    })().finally(() => downloading.delete(name));
    downloading.set(name, job);
    return job;
  }
  async function remove(name) {
    const cache = await caches.open(CACHE);
    for (const u of urls(name)) await cache.delete(u);
    sent.delete(name);
    if (worker) { worker.terminate(); worker = null; sent.clear(); } // free the model's memory
  }

  function spawn() {
    if (worker) return worker;
    worker = new Worker('device-worker.js');
    worker.onmessage = ({ data }) => { const p = pending.get(data.id); if (!p) return; pending.delete(data.id); data.ok ? p.resolve(data) : p.reject(new Error(data.error)); };
    worker.onerror = () => { for (const p of pending.values()) p.reject(new Error('The on-device engine stopped.')); pending.clear(); worker = null; sent.clear(); };
    return worker;
  }
  async function buffer(url) { return (await (await cached(url)).arrayBuffer()); }
  // Translate on this device. Resolves {text, ms}; rejects when the models are not on the device.
  async function translate(text, from, to) {
    from = code(from); to = code(to);
    if (!(await ready(from, to))) throw new Error('not-downloaded');
    const w = spawn(), msg = { id: ++seq, text, from, to, files: {} }, transfer = [];
    if (!sent.has('wasm')) { msg.wasm = await buffer(new URL(manifest.wasm.url, location.href).href); transfer.push(msg.wasm); }
    for (const leg of legs(from, to)) {
      if (sent.has(leg)) continue;
      msg.files[leg] = {};
      for (const [type, f] of Object.entries(pairOf(leg).files)) {
        const b = await buffer(new URL(f.url, location.href).href); msg.files[leg][type] = b; transfer.push(b);
      }
    }
    const answer = new Promise((resolve, reject) => pending.set(msg.id, { resolve, reject }));
    w.postMessage(msg, transfer);
    if (msg.wasm) sent.add('wasm');
    for (const leg of Object.keys(msg.files)) sent.add(leg);
    return answer;
  }

  // Pairs worth offering, as "Thai <-> English" bundles (both directions).
  function bundles() {
    if (!manifest) return [];
    const out = [];
    for (const name of Object.keys(manifest.pairs)) {
      const [a, ...rest] = name.split('-'); const b = rest.join('-');
      if (a !== 'en' || !manifest.pairs[`${b}-en`]) continue;
      out.push({ lang: b, pairs: [`${b}-en`, name], size: manifest.pairs[name].size + manifest.pairs[`${b}-en`].size });
    }
    return out.sort((x, y) => (x.lang === 'th' ? -1 : y.lang === 'th' ? 1 : x.lang.localeCompare(y.lang)));
  }

  return {
    supported, ready, translate, download, remove, has, bundles,
    setManifest: m => { manifest = m; },
    get manifest() { return manifest; },
  };
})();
