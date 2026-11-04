import json, os, shutil, sys
T='/home/claude/sigil-lang/experiments/tasks'
OUT=sys.argv[1]
D=json.load(open('/home/claude/sigil-lang/experiments/m6/defects.json'))
shutil.rmtree(OUT, ignore_errors=True)
for t,d in D.items():
    td=[x for x in os.listdir(T) if x.startswith(t+'-')][0]
    for lang,fn,sub in (('ts','solution.ts','ts'),('sigil','app.sigil','sigil')):
        src=open(f'{T}/{td}/ref/{sub}/{fn}').read()
        bad=src
        for old,new in d[lang]:
            assert bad.count(old)==1,(t,lang,old[:50],bad.count(old))
            bad=bad.replace(old,new)
        for kind,txt in (('clean',src),('defect',bad)):
            p=f'{OUT}/{t}-{lang}-{kind}'; os.makedirs(p)
            open(f'{p}/{fn}','w').write(txt)
print('ok')
