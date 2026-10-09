#!/bin/bash
for f in $(cat .tmp-runs/remaining-files.txt); do
  b=$(basename $f .test.ts)
  npx vitest run --config vitest.security.config.ts "$f" > ".tmp-runs/reg-per-$b.log" 2>&1
  code=$?
  summary=$(grep -aE "Tests  " ".tmp-runs/reg-per-$b.log" | tail -1)
  echo "$code|$f|$summary" >> .tmp-runs/regression30-summary.txt
done
echo "ALL DONE" >> .tmp-runs/regression30-summary.txt
