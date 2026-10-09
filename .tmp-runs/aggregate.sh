#!/bin/bash
total=0; fails=0; files=0
for f in $(cat .tmp-runs/regression-files.txt); do
  b=$(basename $f .test.ts)
  line=$(sed -e 's/\x1b\[[0-9;]*m//g' ".tmp-runs/reg-per-$b.log" 2>/dev/null | grep -a "^      Tests" | tail -1)
  p=$(echo "$line" | grep -aoE "[0-9]+ passed" | grep -oE "[0-9]+")
  fl=$(echo "$line" | grep -aoE "[0-9]+ failed" | grep -oE "[0-9]+")
  files=$((files+1))
  if [ -n "$fl" ] && [ "$fl" != "0" ]; then fails=$((fails+1)); echo "FAIL: $f"; fi
  total=$((total + ${p:-0}))
done
echo "FILES=$files TOTAL_PASSED=$total FILES_WITH_FAILURES=$fails"
