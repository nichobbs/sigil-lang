import os, shutil, sys, re
R='/home/claude/sigil-lang'
T=R+'/experiments/tasks'
SRC='/home/claude/exp-work/m6-src'
W='/home/claude/exp-work/m6'
BUNDLE='/home/claude/exp-work/_bundle/sigil.mjs'
CAP=12
shutil.rmtree(W, ignore_errors=True); os.makedirs(W)
lang_md=open(R+'/docs/LANGUAGE.md').read()
lang_md=re.sub(r'npx tsx src/cli\.ts (\w+) DIR', r'node sigil.mjs \1 task', lang_md).replace('DIR','task')
wf=open(R+'/docs/AGENT_WORKFLOW.md').read()
wf=re.sub(r'npx tsx src/cli\.ts (\w+)\s+DIR', r'node sigil.mjs \1 task', wf).replace('DIR','task')
ENC='Values: integers are JSON numbers; strings are strings; an enum value is its case name as a string ("Gold"); a record is an object with the declared field names; a list is an array; Result is {"ok": v} or {"err": "CaseName"}.'
COMMON=lambda prog: f'''You are reviewing a program that someone else wrote for one task. Work only inside your current workspace directory. Do not read or search any directory outside it, and do not browse the web.

The program ({prog}) was written to satisfy the task README and intent spec included below, including the data-handling policy. It contains either exactly one defect (behaviour that violates the spec, the README or the policy: for example a data leak, a missing or wrong authorisation, an arithmetic overflow, unvalidated input, or wrong audit behaviour) or none at all. Decide which. Use the tools you are given as you see fit. Do not modify the program file.

Finish by writing review.json in the workspace: {{"defect": true or false, "where": "function or line", "what": "what is wrong", "why": "which rule of the spec, README or policy it breaks"}}. If you find no defect, write {{"defect": false}}. Budget: at most {CAP} tool calls in total. Then reply with one line.
'''
def sec(name, body): return f'\n\n===== {name} =====\n{body.rstrip()}\n'
for d in sorted(os.listdir(SRC)):
    t,lang,kind=d.split('-')
    td=[x for x in os.listdir(T) if x.startswith(t+'-')][0]
    vis=f'{T}/{td}/visible'
    w=f'{W}/{d}'; os.makedirs(w)
    rd=lambda f: open(f'{vis}/{f}').read()
    if lang=='sigil':
        os.makedirs(w+'/task')
        for f in os.listdir(vis):
            shutil.copy(f'{vis}/{f}', w+('/README.md' if f=='README.md' else '/task/'+f))
        shutil.copy(f'{vis}/README.md', w+'/task/README.md')
        shutil.copy(f'{SRC}/{d}/app.sigil', w+'/task/app.sigil')
        shutil.copy(BUNDLE, w+'/sigil.mjs'); os.symlink(R+'/node_modules', w+'/node_modules')
        open(w+'/LANGUAGE.md','w').write(lang_md); open(w+'/WORKFLOW.md','w').write(wf)
        tool='Tooling: `node sigil.mjs verify task --fast` checks ranges, capabilities and information flow, then runs the scenarios and properties from the intent spec (seconds); `node sigil.mjs check task` runs only the static checks. Do not run the full `verify` (mutation testing, minutes). Do not read sigil.mjs.\n'
        b=COMMON('task/app.sigil')+tool
        b+=sec('README.md (task)',rd('README.md'))+sec('task/intent.feature',rd('intent.feature'))
        for f in ('glossary.sigil','policy.sigil'): b+=sec('task/'+f,rd(f))
        b+=sec('task/app.sigil (the program under review)',open(w+'/task/app.sigil').read())
        b+=sec('WORKFLOW.md',wf)+sec('LANGUAGE.md (language spec)',lang_md)
    else:
        for f in os.listdir(R+'/experiments/ts-kit'): shutil.copy(f'{R}/experiments/ts-kit/{f}', w+'/'+f)
        os.symlink('/home/claude/exp-tools/node_modules', w+'/node_modules')
        for f in ('README.md','intent.feature'): shutil.copy(f'{vis}/{f}', w+'/'+f)
        shutil.copy(f'{SRC}/{d}/solution.ts', w+'/solution.ts')
        open(w+'/package.json','w').write('{"name":"work","private":true,"type":"module"}\n')
        tool='Tooling: TypeScript (Node, ES modules). `./check.sh` runs strict tsc, eslint with the security plugin, and vitest. You may write your own vitest tests (*.test.ts) from the examples in intent.feature using makeHost from host.ts; effects() lists successful host calls. `host` is the interface in host.ts. '+ENC+'\n'
        b=COMMON('solution.ts')+tool
        b+=sec('README.md (task)',rd('README.md'))+sec('intent.feature',rd('intent.feature'))+sec('host.ts (read only)',open(w+'/host.ts').read())
        b+=sec('solution.ts (the program under review)',open(w+'/solution.ts').read())
    open(w+'/REVIEW.md','w').write(b)
print(len(os.listdir(W)),'workspaces')
