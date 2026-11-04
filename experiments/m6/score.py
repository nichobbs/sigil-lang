import json, os, re, sys
W=os.environ.get('WORKDIR','/home/claude/exp-work/m6')
KEY={'A1':r'email','A2':r'clamp|overflow|1000000000000|1e12|MAX|maximum|bound|unbounded|range','A3':r'denied|audit','A4':r'owner|src\.id|account id|ownership|a\.id s\.id',
 'B1':r'publish','B2':r'skipped|skip','B3':r'card','B4':r'categor|unknowncategory|\b9\b|upper'}
if 'm6h' in W:
    KEY={'A1':r'round|floor|ceil|80|up','A2':r'fee|spent','A3':r'burst','A4':r'approval|exactly|>=|boundary|1000000|10,000|limit','B1':r'gone|order|before|authoris|deleted','B2':r'fallback|attempt 3|>= ?2|third','B3':r'remaining|refunded|prior|earlier|previous|left','B4':r'alreadyimported|duplicate|order|preced'}
rows=[]
for d in sorted(os.listdir(W)):
    if not os.path.isdir(f'{W}/{d}') or '-' not in d: continue
    t,lang,kind=d.split('-')
    p=f'{W}/{d}/review.json'
    if not os.path.exists(p): rows.append((d,'MISSING',''));continue
    try: r=json.load(open(p))
    except Exception as e: rows.append((d,'BADJSON',str(e)));continue
    claim=bool(r.get('defect'))
    txt=' '.join(str(r.get(k,'')) for k in ('where','what','why')).lower()
    hit=bool(re.search(KEY[t],txt))
    rows.append((d,('claim' if claim else 'none')+('+match' if claim and hit else ''),(r.get('what') or '')[:110]))
for r in rows: print(f'{r[0]:18} {r[1]:12} {r[2]}')
