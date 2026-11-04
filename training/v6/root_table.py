"""
root_table.py  -  write the ultralytics-style per-class table to root.txt
=========================================================================
  python root_table.py summary          # 'all' row per epoch from results.csv
                                        # (no model run; safe during training)
  python root_table.py full [weights]   # + per-class rows from a full val run

Format (same as ultralytics val):
  Class   Images  Instances   Box(P      R   mAP50  mAP50-95)
"""

import sys
from collections import Counter
from pathlib import Path

import yaml

ROOT = Path(r"F:\circuit_training_v6")
DATA = ROOT / "data" / "v6"
RUN = ROOT / "runs" / "v6_yolo11n"
OUT = Path(r"E:\FYPPP\New folder\root.txt")


SPLIT = "test"   # drawings the model never trained on


def counts(split: str = SPLIT):
    names = yaml.safe_load((DATA / "data.yaml").read_text())["names"]
    inst, imgs = Counter(), Counter()
    files = list((DATA / "labels" / split).glob("*.txt"))
    for f in files:
        cls = [int(l.split()[0]) for l in f.read_text().splitlines() if l.strip()]
        inst.update(cls)
        imgs.update(set(cls))
    return names, len(files), inst, imgs


def row(name, images, instances, p, r, m50, m5095):
    return f"{name:>14} {images:>8} {instances:>10} {p:>10.3f} {r:>10.3f} {m50:>10.3f} {m5095:>10.3f}"


HEADER = f"{'Class':>14} {'Images':>8} {'Instances':>10} {'Box(P':>10} {'R':>10} {'mAP50':>10} {'mAP50-95)':>10}"


def epochs_table() -> list[str]:
    lines = (RUN / "results.csv").read_text().splitlines()
    head = [h.strip() for h in lines[0].split(",")]
    col = {h: i for i, h in enumerate(head)}
    names, n_img, inst, _ = counts()
    out = [f"{'Epoch':>6} " + HEADER]
    for l in lines[1:]:
        v = [x.strip() for x in l.split(",")]
        out.append(f"{int(float(v[col['epoch']])):>6} " + row(
            "all", n_img, sum(inst.values()),
            float(v[col["metrics/precision(B)"]]), float(v[col["metrics/recall(B)"]]),
            float(v[col["metrics/mAP50(B)"]]), float(v[col["metrics/mAP50-95(B)"]])))
    return out


def full_table(weights: Path) -> list[str]:
    from ultralytics import YOLO
    names, n_img, inst, imgs = counts()
    m = YOLO(str(weights)).val(data=str(DATA / "data.yaml"), split=SPLIT, imgsz=640, batch=16,
                               workers=2, plots=False, verbose=False,
                               project=str(ROOT / "runs" / "eval"), name="root_table", exist_ok=True)
    out = [HEADER, row("all", n_img, sum(inst.values()), m.box.mp, m.box.mr, m.box.map50, m.box.map)]
    idx = list(m.box.ap_class_index)
    for c, n in enumerate(names):
        if c in idx:
            p, r, a50, a = m.box.class_result(idx.index(c))
        else:
            p = r = a50 = a = 0.0
        out.append(row(n, imgs[c], inst[c], p, r, a50, a))
    return out


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "summary"
    lines = ["Circuit detector v6 (YOLO11n, 14 classes) - results per component",
             f"(scored on {counts()[1]} test drawings the model never trained on: hand-drawn CGHD photos"
             " from unseen drafters, ckt2, op-amp and old hand-drawn sets)", ""]
    if mode == "full":
        w = Path(sys.argv[2]) if len(sys.argv) > 2 else RUN / "weights" / "best.pt"
        lines += [f"Per-component results, weights: {w}", ""] + full_table(w) + [""]
    else:
        names, n_img, inst, imgs = counts()
        lines += ["Per-class rows are filled in automatically when training finishes",
                  "(a per-class run needs ~1 GB RAM, not free while training). Data per class:", "",
                  f"{'Class':>14} {'Images':>8} {'Instances':>10}"]
        lines += [f"{n:>14} {imgs[c]:>8} {inst[c]:>10}" for c, n in enumerate(names)]
        lines += [""]
    lines += ["All components together, per training epoch:", ""] + epochs_table()
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines[:40]))


if __name__ == "__main__":
    main()
