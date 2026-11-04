"""
train.py  -  train circuit detector v6 (YOLO11n, 14 classes) on the RTX 3050
=============================================================================
Starts from v4 (same 14-class head, already adapted to circuit drawings;
NOT v5, whose head is biased towards Transistor) and trains every layer on
the full v6 dataset. Safe to stop: re-running resumes from last.pt.

    F:\\circuit_training_v6\\venv\\Scripts\\python.exe train.py [--epochs N] [--batch B]
"""

import argparse
from pathlib import Path

from ultralytics import YOLO

ROOT = Path(r"F:\circuit_training_v6")
DATA = ROOT / "data" / "v6" / "data.yaml"
INIT = Path(r"E:\FYPPP\New folder\circuit-sim\backend\model\circuit_yolo11_v4_best.pt")
PROJECT = ROOT / "runs"
NAME = "v6_yolo11n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=100)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--name", default=NAME)
    args = ap.parse_args()

    last = PROJECT / args.name / "weights" / "last.pt"
    if last.exists():
        YOLO(str(last)).train(resume=True)
        return

    YOLO(str(INIT)).train(
        data=str(DATA),
        project=str(PROJECT),
        name=args.name,
        device=0,
        epochs=args.epochs,
        patience=40,              # stop when val mAP50-95 hasn't improved for 40 epochs
        imgsz=640,                # the backend's main inference size
        batch=args.batch,
        workers=args.workers,
        cache="disk",             # decode each image once (.npy beside it on F:)
        amp=True,
        seed=0,
        deterministic=False,
        # Optimiser: SGD + cosine decay is the standard long-schedule recipe.
        optimizer="SGD",
        lr0=0.01,
        lrf=0.01,
        momentum=0.937,
        weight_decay=5e-4,
        cos_lr=True,
        warmup_epochs=3,
        # Augmentation. A part's class doesn't change when it is flipped or
        # turned, and drawings come at any angle, so flip both ways and
        # rotate a little (the backend also checks +-45 deg views).
        degrees=10,
        translate=0.1,
        scale=0.5,
        shear=2.0,
        perspective=0.0005,
        flipud=0.5,
        fliplr=0.5,
        hsv_h=0.015,
        hsv_s=0.5,
        hsv_v=0.4,
        mosaic=1.0,
        mixup=0.1,
        close_mosaic=10,          # last 10 epochs on whole images, like inference
        save_period=10,
        plots=True,
        val=True,
    )


if __name__ == "__main__":
    main()
