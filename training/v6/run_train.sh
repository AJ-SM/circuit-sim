#!/bin/bash
# Train only (dataset already built). Log: runs/train_log.txt; exit code: runs/train_exit.txt
cd /f/circuit_training_v6
export TMP='F:\circuit_training_v6\tmp' TEMP='F:\circuit_training_v6\tmp' PYTHONUNBUFFERED=1
./venv/Scripts/python scripts/train.py >> runs/train_log.txt 2>&1
echo "TRAIN EXIT $?" > runs/train_exit.txt
