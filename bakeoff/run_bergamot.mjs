// Bergamot (Firefox Translations) runner in Node: same wasm + glue + config as Firefox.
// usage: node run.mjs ../phrases.json ../results/bergamot.json
import fs from 'node:fs';
import vm from 'node:vm';

const glue = fs.readFileSync(new URL('./bergamot-translator.js', import.meta.url), 'utf8');
const ctx = { console, performance, WebAssembly, TextDecoder, TextEncoder, setTimeout, clearTimeout, URL };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(glue + '\nglobalThis.loadBergamot = loadBergamot;', ctx);

const wasmBinary = fs.readFileSync(new URL('./bergamot.wasm', import.meta.url));
const ALIGN = { model: 256, lex: 64, vocab: 64, srcvocab: 64, trgvocab: 64 };
const t0 = performance.now();
const B = await new Promise((resolve, reject) => {
  const m = ctx.loadBergamot({ INITIAL_MEMORY: 41943040, print: () => {}, printErr: () => {}, wasmBinary,
    onAbort: () => reject(new Error('abort')), onRuntimeInitialized: async () => { await Promise.resolve(); resolve(m); } });
});
const initMs = performance.now() - t0;
const cfg = o => '\n' + Object.entries(o).map(([k, v]) => `            ${k}: ${v}`).join('\n') + '\n            ';
const models = {};
function model(pair) {
  if (models[pair]) return models[pair];
  const t = performance.now();
  const mem = {};
  for (const ft of Object.keys(ALIGN)) {
    const f = new URL(`./models/${pair}.${ft}`, import.meta.url);
    if (!fs.existsSync(f)) continue;
    const buf = fs.readFileSync(f);
    const a = new B.AlignedMemory(buf.byteLength, ALIGN[ft]);
    a.getByteArrayView().set(new Uint8Array(buf));
    mem[ft] = a;
  }
  const vl = new B.AlignedMemoryList();
  if (mem.vocab) vl.push_back(mem.vocab); else { vl.push_back(mem.srcvocab); vl.push_back(mem.trgvocab); }
  const [s, ...rest] = pair.split('-');
  const config = cfg({ 'beam-size': '1', normalize: '1.0', 'word-penalty': '0', 'max-length-break': '128',
    'mini-batch-words': '1024', workspace: '128', 'max-length-factor': '2.0', 'skip-cost': 'true', 'cpu-threads': '0',
    quiet: 'true', 'quiet-translation': 'true', 'gemm-precision': 'int8shiftAlphaAll', alignment: 'soft' });
  models[pair] = new B.TranslationModel(s, rest.join('-'), config, mem.model, mem.lex ?? null, vl, null);
  console.error('loaded', pair, Math.round(performance.now() - t), 'ms');
  return models[pair];
}
const svc = new B.BlockingService({ cacheSize: 0 });
const code = c => (c === 'zh' ? 'zh-Hans' : c);
export function translate(text, s, t) {
  s = code(s); t = code(t);
  const msgs = new B.VectorString(); const opts = new B.VectorResponseOptions();
  msgs.push_back(text); opts.push_back({ qualityScores: false, alignment: true, html: false });
  let r;
  if (s === 'en' || t === 'en') r = svc.translate(model(`${s}-${t}`), msgs, opts);
  else r = svc.translateViaPivoting(model(`${s}-en`), model(`en-${t}`), msgs, opts);
  const out = r.get(0).getTranslatedText();
  msgs.delete(); opts.delete();
  return out;
}

const [inF, outF] = process.argv.slice(2);
if (inF) {
  const P = JSON.parse(fs.readFileSync(inF, 'utf8'));
  const res = [];
  for (const p of P) {
    translate('warm', p.src, p.tgt === p.src ? 'en' : p.tgt); // load models outside timing
    const a = performance.now();
    const out = translate(p.text, p.src, p.tgt);
    const ms = Math.round(performance.now() - a);
    const back = translate(out, p.tgt, p.src);
    res.push({ ...p, out, ms, back, err: null });
  }
  fs.writeFileSync(outF, JSON.stringify(res, null, 1));
  const ms = res.map(r => r.ms).sort((a, b) => a - b);
  console.log('bergamot init ms', Math.round(initMs), 'median ms', ms[ms.length >> 1], 'p90', ms[Math.floor(ms.length * .9)]);
}
