# Circuit detector v6 training pipeline

Produces `backend/model/circuit_yolo11_v6_best.pt` (YOLO11n, 14 classes, same
class ids as v4/v5). Built to fix v5 detecting a transistor in drawn circles.

The scripts were run from `F:\circuit_training_v6` (venv with CUDA PyTorch,
data and runs live there); paths in them point at that folder and at the
datasets in `E:\FYPPP\New folder`.

| file | what it does |
|---|---|
| `build_dataset.py` | merges every labelled source into one dataset: CGHD (original VOC labels, split by drafter), ckt2, op-amp, old hand-drawn, synthetic. Paints out parts with no class, removes near-duplicates and val/test leaks (256-bit pHash), writes a repeat-factor-sampled train list. Report: `build_report.json` |
| `train.py` | trains from v4 weights: 100 epochs, SGD + cosine LR, flips/rotation/mosaic, last 10 epochs without mosaic. Resumes from `last.pt` |
| `run_train.sh`, `watch.sh` | run training detached; print one line per epoch |
| `root_table.py` | ultralytics-style per-component table (P, R, mAP50, mAP50-95) |
| `evaluate.py` | v4 / v5 / v6 comparison with plots (optional) |
| `quick_bug_check.py` | how often voltage sources are called Transistor, false transistors |
| `results.csv`, `args.yaml` | the v6 run's per-epoch metrics and settings |

Rebuild and retrain:

```
F:\circuit_training_v6\venv\Scripts\python.exe build_dataset.py
F:\circuit_training_v6\venv\Scripts\python.exe train.py
```

On a 4 GB RTX 3050 / 16 GB RAM laptop: ~5 min per epoch, 8.7 h for 100
epochs. Keep `workers` at 2: on Windows each data-loader worker is a full
process with its own PyTorch (~550 MB).

## Results (best.pt = epoch 69)

387 test drawings never used for training or model selection:

| | v5 | v6 |
|---|---|---|
| transistor-free drawings that trip the transistor check | 38% | 3% |
| ...of those with a voltage source | 39% | 0% |
| false Transistor boxes | 238 | 27 |
| Transistor precision / recall | 33% / 34% | 92% / 90% |
| voltage sources found | 28% | 72% |

Per component (test set):

```
        Class   Images  Instances      P       R     mAP50  mAP50-95
          all      387       5242    0.812   0.746   0.805    0.545
    AC Source       19         21    0.554   0.857   0.877    0.720
      Battery      114        154    0.706   0.669   0.694    0.448
    Capacitor      257       1057    0.868   0.905   0.914    0.546
        Diode      156        537    0.790   0.918   0.870    0.569
       Ground      148        498    0.924   0.786   0.892    0.633
     Inductor      102        201    0.758   0.900   0.875    0.478
     Resistor      302       1827    0.957   0.974   0.985    0.707
      Voltage       46         65    0.668   0.862   0.826    0.569
          LED       64        164    0.911   0.188   0.362    0.225
         Lamp       16         24    0.666   0.250   0.562    0.456
  Transformer       69         85    0.900   0.847   0.890    0.480
       Switch       96        160    0.836   0.494   0.600    0.339
   Transistor      160        346    0.897   0.864   0.955    0.663
       Op-Amp       79        103    0.932   0.925   0.963    0.800
```

Weak spots, all from too little data: LED, Lamp and Switch recall, and
Battery. More labelled drawings of those help more than more training.
