// On-device engine: Firefox Translations (Bergamot) in a Web Worker. Same WASM, glue and settings Firefox uses.
// tools/build_worker.py prepends Mozilla's unmodified glue (vendor/bergamot-translator.js) to make web/device-worker.js.
'use strict';
// Messages: {id, type:'translate', text, from, to, files:{'th-en': {model: ArrayBuffer, lex, vocab|srcvocab+trgvocab}}, wasm}

const ALIGN = { model: 256, lex: 64, vocab: 64, srcvocab: 64, trgvocab: 64 };
const CONFIG = {
  'beam-size': '1', normalize: '1.0', 'word-penalty': '0', 'max-length-break': '128', 'mini-batch-words': '1024',
  workspace: '128', 'max-length-factor': '2.0', 'skip-cost': 'true', 'cpu-threads': '0', quiet: 'true',
  'quiet-translation': 'true', 'gemm-precision': 'int8shiftAlphaAll', alignment: 'soft',
};
const configText = '\n' + Object.entries(CONFIG).map(([k, v]) => `            ${k}: ${v}`).join('\n') + '\n            ';
let bergamot = null, service = null;
const models = new Map();

function boot(wasmBinary) {
  if (bergamot) return Promise.resolve(bergamot);
  return new Promise((resolve, reject) => {
    const m = loadBergamot({
      INITIAL_MEMORY: 41943040, print: () => {}, printErr: () => {}, wasmBinary,
      onAbort: () => reject(new Error('The on-device engine stopped.')),
      onRuntimeInitialized: async () => { await Promise.resolve(); bergamot = m; service = new m.BlockingService({ cacheSize: 0 }); resolve(m); },
    });
  });
}

function model(pair, files) {
  if (models.has(pair)) return models.get(pair);
  if (!files) throw new Error('missing model ' + pair);
  const mem = {};
  for (const [type, buf] of Object.entries(files)) {
    const a = new bergamot.AlignedMemory(buf.byteLength, ALIGN[type]);
    a.getByteArrayView().set(new Uint8Array(buf));
    mem[type] = a;
  }
  const vocabs = new bergamot.AlignedMemoryList();
  if (mem.vocab) vocabs.push_back(mem.vocab); else { vocabs.push_back(mem.srcvocab); vocabs.push_back(mem.trgvocab); }
  const [from, ...rest] = pair.split('-');
  const m = new bergamot.TranslationModel(from, rest.join('-'), configText, mem.model, mem.lex ?? null, vocabs, null);
  models.set(pair, m);
  return m;
}

function translate(text, from, to, files) {
  const msgs = new bergamot.VectorString(), opts = new bergamot.VectorResponseOptions();
  // Thai has no sentence punctuation: keep lines apart so each line is its own sentence.
  const lines = text.split('\n');
  for (const line of lines) { msgs.push_back(line); opts.push_back({ qualityScores: false, alignment: false, html: false }); }
  let r;
  if (from === 'en' || to === 'en') r = service.translate(model(`${from}-${to}`, files[`${from}-${to}`]), msgs, opts);
  else r = service.translateViaPivoting(model(`${from}-en`, files[`${from}-en`]), model(`en-${to}`, files[`en-${to}`]), msgs, opts);
  const out = [];
  for (let i = 0; i < lines.length; i++) out.push(lines[i].trim() ? r.get(i).getTranslatedText() : lines[i]);
  msgs.delete(); opts.delete();
  return out.join('\n');
}

onmessage = async ({ data }) => {
  const { id } = data;
  try {
    await boot(data.wasm);
    const t0 = performance.now();
    const text = translate(data.text, data.from, data.to, data.files || {});
    postMessage({ id, ok: true, text, ms: Math.round(performance.now() - t0) });
  } catch (e) {
    postMessage({ id, ok: false, error: String(e && e.message || e) });
  }
};
