#!/bin/bash
# Emits one line per event: build done, training started, each finished epoch
# (with accuracy), errors, training end. Remembers what it already reported.
R=/f/circuit_training_v6; ST=$R/tmp/watch_state; mkdir -p $ST
CSV=$R/runs/v6_yolo11n/results.csv; LOG=$R/runs/train_log.txt
START=$(date +%s)
while [ $(( $(date +%s) - START )) -lt 1740 ]; do
  if [ -f $R/data/v6/build_report.json ] && [ $R/data/v6/build_report.json -nt $ST/build ] ; then
    echo "BUILD DONE: $(grep -o '"train_list_len_after_rfs": [0-9]*' $R/data/v6/build_report.json)"; touch $ST/build; fi
  grep -q "BUILD FAILED" $R/data/build_log.txt 2>/dev/null && [ ! -f $ST/bfail ] && { echo "BUILD FAILED: $(tail -3 $R/data/build_log.txt)"; touch $ST/bfail; }
  if [ -f $LOG ]; then
    n=$(grep -c -E "Traceback|CUDA out of memory|RuntimeError|Error:" $LOG); o=$(cat $ST/err 2>/dev/null || echo 0)
    [ "$n" -gt "$o" ] && { echo "TRAIN ERROR: $(grep -E 'Traceback|out of memory|Error' $LOG | tail -2 | tr '\n' ' ')"; echo $n > $ST/err; }
  fi
  if [ -f $CSV ]; then
    rows=$(($(wc -l < $CSV) - 1)); seen=$(cat $ST/rows 2>/dev/null || echo 0)
    if [ "$rows" -gt "$seen" ]; then
      tail -n +$((seen + 2)) $CSV | awk -F, '{gsub(/ /,""); printf "EPOCH %d | mAP50 %.4f | mAP50-95 %.4f | P %.4f | R %.4f | box %.3f cls %.3f | %.0fs\n", $1, $8, $9, $6, $7, $3, $4, $2; fflush()}'
      echo $rows > $ST/rows
    fi
  fi
  grep -q "TRAIN EXIT" "$R/runs/train_exit.txt" 2>/dev/null && { echo "TRAINING ENDED"; exit 0; }
  sleep 20
done
