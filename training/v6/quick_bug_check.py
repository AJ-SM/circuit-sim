"""CPU-only quick check of the v5 bug on the test split: of the true voltage
sources (Voltage / AC Source / Battery), how many each model calls Transistor.
Uses evaluate.py's matching; conf 0.25, imgsz 640 (the backend's settings)."""
import sys, torch
torch.set_num_threads(4)
sys.path.insert(0, r"F:\circuit_training_v6\scripts")
import evaluate as E
from ultralytics import YOLO
from pathlib import Path
E.IMGSZ = 640
imgs = sorted((E.DATA / "images" / "test").glob("*.jpg"))
names = ["AC Source","Battery","Capacitor","Diode","Ground","Inductor","Resistor","Voltage","LED","Lamp","Transformer","Switch","Transistor","Op-Amp"]
for tag, p in [("v4", E.DEFAULT_MODELS["v4"]), ("v5", E.DEFAULT_MODELS["v5"]), ("v6 final", Path("F:/circuit_training_v6/runs/v6_yolo11n/weights/best.pt"))]:
    m = YOLO(str(p))
    orig = m.predict
    m.predict = lambda *a, **k: orig(*a, **{**k, "device": 0, "half": True})
    print(tag, E.bug_metrics(E.confusion(m, imgs, 14), names), flush=True)
