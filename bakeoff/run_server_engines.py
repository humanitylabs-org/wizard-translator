"""Bake-off runner: LibreTranslate (dev install) + Tinfoil LLMs. Writes results/<engine>.json."""
import json, sys, time, urllib.request, concurrent.futures as cf
from pathlib import Path
import tkey

P = json.load(open('phrases.json'))
OUT = Path('results'); OUT.mkdir(exist_ok=True)
NAMES = {'en': 'English', 'th': 'Thai', 'ja': 'Japanese', 'zh': 'Simplified Chinese'}

def post(url, body, headers=None, timeout=120):
    for attempt in range(3):
        req = urllib.request.Request(url, json.dumps(body).encode(), {'Content-Type': 'application/json', **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except Exception:
            if attempt == 2:
                raise
            time.sleep(1 + attempt)

def libre(text, s, t):
    return post('http://127.0.0.1:18895/api/translate', {'text': text, 'source': s, 'target': t})['translation'] \
        if True else None

SYSTEM = ("You are a professional translator. Translate the user's text from {s} to {t}. "
          "Keep the meaning, tone and register (casual stays casual, polite particles map to natural politeness), "
          "numbers, names and formatting. Output only the translation, with no notes, quotes or explanations.")

def llm(model, extra=None):
    key = tkey.key()
    def f(text, s, t):
        body = {'model': model, 'temperature': 0.2, 'max_tokens': 800,
                'messages': [{'role': 'system', 'content': SYSTEM.format(s=NAMES[s], t=NAMES[t])},
                             {'role': 'user', 'content': text}]}
        body.update(extra or {})
        d = post('https://inference.tinfoil.sh/v1/chat/completions', body, {'Authorization': 'Bearer ' + key})
        return d['choices'][0]['message']['content'].strip()
    return f

ENGINES = {
    'libre': libre,
    'gemma4-31b': llm('gemma4-31b', {'chat_template_kwargs': {'enable_thinking': False}}),
    'deepseek-v4-1-flash': llm('deepseek-v4-1-flash', {'chat_template_kwargs': {'thinking': False}}),
    'gpt-oss-120b': llm('gpt-oss-120b', {'reasoning_effort': 'low'}),
    'llama3-3-70b': llm('llama3-3-70b'),
    'glm-5-3': llm('glm-5-3', {'chat_template_kwargs': {'enable_thinking': False}}),
    'kimi-k3-1-pro': llm('kimi-k3-1-pro', {'chat_template_kwargs': {'thinking': False}}),
}

def run(name, items, workers=1, tag=''):
    fn = ENGINES[name]
    def one(p):
        t0 = time.time()
        try:
            out = fn(p['text'], p['src'], p['tgt']); err = None
        except Exception as e:
            out, err = '', repr(e)[:200]
        return {**p, 'out': out, 'ms': int((time.time() - t0) * 1000), 'err': err}
    with cf.ThreadPoolExecutor(workers) as ex:
        res = list(ex.map(one, items))
    return res

if __name__ == '__main__':
    name = sys.argv[1]
    res = run(name, P, workers=int(sys.argv[2]) if len(sys.argv) > 2 else 1)
    # back-translation of each output into the source language
    back = run(name, [{**r, 'text': r['out'], 'src': r['tgt'], 'tgt': r['src']} for r in res if r['out']], 1)
    bmap = {b['id']: b['out'] for b in back}
    for r in res:
        r['back'] = bmap.get(r['id'], '')
    json.dump(res, open(OUT / f'{name}.json', 'w'), ensure_ascii=False, indent=1)
    ms = sorted(r['ms'] for r in res)
    print(name, 'errors', sum(1 for r in res if r['err']), 'median ms', ms[len(ms) // 2], 'p90', ms[int(len(ms) * .9)])
