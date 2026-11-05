#!/bin/bash
# usage: _killrate.sh TASK  -> prints "task set defect killed(1/0)"
t=$1
for set in m6-src m6h-src; do
  d=/home/claude/exp-work/$set/$t-ts-defect/solution.ts
  [ -f "$d" ] || continue
  w=/home/claude/exp-work/_kr-$t-$set
  rm -rf $w; mkdir -p $w
  cp /home/claude/exp-work/T-$t/{host.ts,tsconfig.json,tests.test.ts,package.json} $w/ 2>/dev/null
  ln -s /home/claude/exp-tools/node_modules $w/node_modules
  cp $d $w/solution.ts
  if (cd $w && timeout 120 npx vitest run tests.test.ts >/dev/null 2>&1); then echo "$t $set survived"; else echo "$t $set killed"; fi
done
