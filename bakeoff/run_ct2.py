import json, sys, time
import ctranslate2, transformers
P = json.load(open('phrases.json'))
which = sys.argv[1]
threads = int(sys.argv[2]) if len(sys.argv) > 2 else 8
NLLB = {'en': 'eng_Latn', 'th': 'tha_Thai', 'ja': 'jpn_Jpan', 'zh': 'zho_Hans'}
path = {'nllb': 'hf/nllb-200-distilled-1.3B-ct2-int8', 'madlad': 'hf/madlad400-3b-mt-ct2-int8'}[which]
t0 = time.time()
tr = ctranslate2.Translator(path, device='cpu', compute_type='int8', intra_threads=threads)
if which == 'nllb':
    tok = transformers.AutoTokenizer.from_pretrained(path, src_lang='eng_Latn')
else:
    import sentencepiece as spm
    sp = spm.SentencePieceProcessor(model_file=path + '/spiece.model')
load = time.time() - t0

def tr1(text, s, t):
    if which == 'nllb':
        tok.src_lang = NLLB[s]
        src = tok.convert_ids_to_tokens(tok.encode(text))
        r = tr.translate_batch([src], target_prefix=[[NLLB[t]]], beam_size=2, max_decoding_length=160)
        out = r[0].hypotheses[0][1:]
        return tok.decode(tok.convert_tokens_to_ids(out), skip_special_tokens=True)
    src = sp.encode(f'<2{t}> ' + text, out_type=str) + ['</s>']
    r = tr.translate_batch([src], beam_size=2, max_decoding_length=160)
    return sp.decode(r[0].hypotheses[0])

res = []
for p in P:
    a = time.time(); out = tr1(p['text'], p['src'], p['tgt']); ms = int((time.time() - a) * 1000)
    back = tr1(out, p['tgt'], p['src'])
    res.append({**p, 'out': out, 'ms': ms, 'back': back, 'err': None})
json.dump(res, open(f'results/{which}.json', 'w'), ensure_ascii=False, indent=1)
ms = sorted(r['ms'] for r in res)
print(which, 'load s', round(load, 1), 'median ms', ms[len(ms) // 2], 'p90', ms[int(len(ms) * .9)])
