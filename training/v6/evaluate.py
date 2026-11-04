"""
evaluate.py  -  compare circuit detectors on the v6 held-out test set
=====================================================================
For each model (v4, v5, v6 by default):
  * standard COCO metrics per class (mAP50, mAP50-95, P, R) via ultralytics
  * the v5 bug, measured directly: of all ground-truth voltage sources
    (Voltage / AC Source / Battery), how many are detected as Transistor,
    using the backend's own settings (conf 0.25, imgsz 640)
  * a confusion matrix at those settings, and the same numbers per source
Writes tables + graphs to E:\\FYPPP\\New folder\\training_results_v6.

    venv\\Scripts\\python.exe evaluate.py [--model name=path ...] [--split test]
"""

import argparse
import json
import shutil
from collections import defaultdict
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import yaml
from ultralytics import YOLO

ROOT = Path(r"F:\circuit_training_v6")
DATA = ROOT / "data" / "v6"
RESULTS = Path(r"E:\FYPPP\New folder\training_results_v6")
MODELS_DIR = Path(r"E:\FYPPP\New folder\circuit-sim\backend\model")
DEFAULT_MODELS = {
    "v4": MODELS_DIR / "circuit_yolo11_v4_best.pt",
    "v5": MODELS_DIR / "circuit_yolo11_v5_best.pt",
    "v6": ROOT / "runs" / "v6_yolo11n" / "weights" / "best.pt",
}
CONF, IOU_NMS, IMGSZ, MATCH_IOU = 0.25, 0.5, 640, 0.5
SOURCES_V = ("Voltage", "AC Source", "Battery")
COLORS = {"v4": "#8b949e", "v5": "#e5534b", "v6": "#2f81f7"}


def box_iou(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    tl = np.maximum(a[:, None, :2], b[None, :, :2])
    br = np.minimum(a[:, None, 2:], b[None, :, 2:])
    inter = np.prod(np.clip(br - tl, 0, None), axis=2)
    area = lambda x: np.prod(x[:, 2:] - x[:, :2], axis=1)
    return inter / (area(a)[:, None] + area(b)[None, :] - inter + 1e-9)


def read_gt(label: Path, w: int, h: int) -> tuple[np.ndarray, np.ndarray]:
    rows = [list(map(float, l.split())) for l in label.read_text().splitlines() if l.strip()]
    if not rows:
        return np.zeros(0, int), np.zeros((0, 4))
    a = np.array(rows)
    cx, cy, bw, bh = a[:, 1] * w, a[:, 2] * h, a[:, 3] * w, a[:, 4] * h
    return a[:, 0].astype(int), np.stack([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], 1)


def confusion(model: YOLO, images: list[Path], nc: int) -> np.ndarray:
    """(nc+1)x(nc+1) matrix, rows = truth, cols = prediction, index nc =
    background (missed part / false detection). Greedy one-to-one matching
    by IoU, class-agnostic, so a voltage source boxed as a transistor counts
    as Voltage -> Transistor."""
    m = np.zeros((nc + 1, nc + 1), int)
    for i in range(0, len(images), 32):
        batch = images[i:i + 32]
        for img, r in zip(batch, model.predict([str(p) for p in batch], conf=CONF, iou=IOU_NMS,
                                               imgsz=IMGSZ, verbose=False, half=True)):
            h, w = r.orig_shape
            gc, gb = read_gt(DATA / "labels" / img.parent.name / (img.stem + ".txt"), w, h)
            pc = r.boxes.cls.cpu().numpy().astype(int)
            pb = r.boxes.xyxy.cpu().numpy()
            used_p = set()
            if len(gc) and len(pc):
                iou = box_iou(gb, pb)
                pairs = sorted(((iou[g, p], g, p) for g in range(len(gc)) for p in range(len(pc))
                                if iou[g, p] >= MATCH_IOU), reverse=True)
                used_g = set()
                for _, g, p in pairs:
                    if g in used_g or p in used_p:
                        continue
                    used_g.add(g); used_p.add(p)
                    m[gc[g], pc[p]] += 1
                for g in set(range(len(gc))) - used_g:
                    m[gc[g], nc] += 1
            else:
                for g in gc:
                    m[g, nc] += 1
            for p in set(range(len(pc))) - used_p:
                m[nc, pc[p]] += 1
    return m


def bug_metrics(m: np.ndarray, names: list[str]) -> dict:
    idx = {n: i for i, n in enumerate(names)}
    t = idx["Transistor"]
    src = [idx[n] for n in SOURCES_V]
    n_src = int(m[src, :].sum())
    as_t = int(m[src, t].sum())
    correct_src = int(sum(m[i, i] for i in src))
    return {
        "voltage_source_boxes": n_src,
        "voltage_sources_detected_as_transistor": as_t,
        "pct_voltage_sources_as_transistor": round(100 * as_t / max(n_src, 1), 2),
        "voltage_source_recall_pct": round(100 * correct_src / max(n_src, 1), 2),
        "transistor_recall_pct": round(100 * m[t, t] / max(m[t].sum(), 1), 2),
        "transistor_precision_pct": round(100 * m[t, t] / max(m[:, t].sum(), 1), 2),
        "false_transistors_total": int(m[:, t].sum() - m[t, t]),
    }


def plot_confusion(m: np.ndarray, names: list[str], title: str, path: Path) -> None:
    labels = names + ["background"]
    norm = m / np.maximum(m.sum(1, keepdims=True), 1)
    fig, ax = plt.subplots(figsize=(11, 9))
    ax.imshow(norm, cmap="Blues", vmin=0, vmax=1)
    for i in range(len(labels)):
        for j in range(len(labels)):
            if m[i, j]:
                ax.text(j, i, f"{norm[i, j]:.2f}\n({m[i, j]})", ha="center", va="center", fontsize=6,
                        color="white" if norm[i, j] > 0.5 else "black")
    ax.set_xticks(range(len(labels)), labels, rotation=60, ha="right", fontsize=8)
    ax.set_yticks(range(len(labels)), labels, fontsize=8)
    ax.set_xlabel("Predicted"); ax.set_ylabel("True")
    ax.set_title(title + "  (rows normalised; conf 0.25, imgsz 640)")
    fig.tight_layout(); fig.savefig(path, dpi=140); plt.close(fig)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", action="append", default=[], help="name=path (repeatable)")
    ap.add_argument("--split", default="test")
    args = ap.parse_args()
    models = dict(DEFAULT_MODELS)
    for kv in args.model:
        k, v = kv.split("=", 1); models[k] = Path(v)
    models = {k: v for k, v in models.items() if v.exists()}

    cfg = yaml.safe_load((DATA / "data.yaml").read_text())
    names = cfg["names"]
    RESULTS.mkdir(parents=True, exist_ok=True)
    records = json.loads((DATA / "records.json").read_text())
    split_dir = "val" if args.split == "val" else args.split
    images = sorted((DATA / "images" / split_dir).glob("*.jpg"))
    by_source = defaultdict(list)
    for r in records:
        if r["split"] == split_dir:
            by_source[r["source"]].append(Path(r["image"]))

    summary, per_class = {}, {}
    for name, path in models.items():
        print(f"== {name}: {path}", flush=True)
        model = YOLO(str(path))
        assert list(model.names.values()) == names, f"{name} has different classes"
        v = model.val(data=str(DATA / "data.yaml"), split=args.split, imgsz=IMGSZ, batch=16,
                      half=True, plots=True, project=str(ROOT / "runs" / "eval"),
                      name=f"{name}_{args.split}", exist_ok=True, verbose=False)
        ap50 = dict(zip([names[i] for i in v.box.ap_class_index], v.box.ap50))
        ap5095 = dict(zip([names[i] for i in v.box.ap_class_index], v.box.ap))
        per_class[name] = {"AP50": ap50, "AP50-95": ap5095}
        m = confusion(model, images, len(names))
        plot_confusion(m, names, f"{name} - {args.split} set", RESULTS / f"confusion_{name}_{args.split}.png")
        per_src = {s: bug_metrics(confusion(model, imgs, len(names)), names)
                   for s, imgs in sorted(by_source.items())}
        summary[name] = {
            "weights": str(path),
            "mAP50": round(float(v.box.map50), 4), "mAP50-95": round(float(v.box.map), 4),
            "precision": round(float(v.box.mp), 4), "recall": round(float(v.box.mr), 4),
            **bug_metrics(m, names),
            "per_source": per_src,
        }
        np.savetxt(RESULTS / f"confusion_{name}_{args.split}.csv", m, fmt="%d", delimiter=",",
                   header=",".join(names + ["background"]))

    (RESULTS / f"comparison_{args.split}.json").write_text(json.dumps(
        {"summary": summary, "per_class": per_class}, indent=2))

    # ── graphs ──
    keys = list(summary)
    x = np.arange(len(names)); wbar = 0.8 / max(len(keys), 1)
    for metric in ("AP50", "AP50-95"):
        fig, ax = plt.subplots(figsize=(14, 5))
        for i, k in enumerate(keys):
            ax.bar(x + i * wbar - 0.4 + wbar / 2, [per_class[k][metric].get(n, 0) for n in names],
                   wbar, label=k, color=COLORS.get(k))
        ax.set_xticks(x, names, rotation=30, ha="right"); ax.set_ylim(0, 1)
        ax.set_ylabel(metric); ax.set_title(f"Per-class {metric} on the {args.split} set")
        ax.legend(); ax.grid(axis="y", alpha=0.3)
        fig.tight_layout(); fig.savefig(RESULTS / f"per_class_{metric}_{args.split}.png", dpi=140); plt.close(fig)

    fig, axes = plt.subplots(1, 3, figsize=(15, 4.5))
    panels = [("pct_voltage_sources_as_transistor", "Voltage sources detected\nas Transistor (%) - lower is better"),
              ("voltage_source_recall_pct", "Voltage sources detected\ncorrectly (%) - higher is better"),
              ("false_transistors_total", "False Transistor detections\n(count) - lower is better")]
    for ax, (k, t) in zip(axes, panels):
        vals = [summary[m][k] for m in keys]
        bars = ax.bar(keys, vals, color=[COLORS.get(m) for m in keys])
        ax.bar_label(bars, fmt="%g"); ax.set_title(t); ax.grid(axis="y", alpha=0.3)
    fig.suptitle(f"The v5 bug: circles detected as transistors ({args.split} set, conf 0.25, imgsz 640)")
    fig.tight_layout(); fig.savefig(RESULTS / f"voltage_vs_transistor_{args.split}.png", dpi=140); plt.close(fig)

    fig, ax = plt.subplots(figsize=(7, 4))
    for i, k in enumerate(("mAP50", "mAP50-95", "precision", "recall")):
        bars = ax.bar(np.arange(len(keys)) + i * 0.2 - 0.3, [summary[m][k] for m in keys], 0.2, label=k)
        ax.bar_label(bars, fmt="%.3f", fontsize=7)
    ax.set_xticks(range(len(keys)), keys); ax.set_ylim(0, 1); ax.legend(fontsize=8)
    ax.set_title(f"Overall detection metrics ({args.split} set)"); ax.grid(axis="y", alpha=0.3)
    fig.tight_layout(); fig.savefig(RESULTS / f"overall_{args.split}.png", dpi=140); plt.close(fig)

    # Ultralytics' own plots for each model (PR / F1 curves, confusion).
    for name in summary:
        src = ROOT / "runs" / "eval" / f"{name}_{args.split}"
        dst = RESULTS / "ultralytics_plots" / f"{name}_{args.split}"
        if src.exists():
            shutil.copytree(src, dst, dirs_exist_ok=True)

    lines = [f"# Circuit detector comparison ({args.split} set)", "",
             "| model | mAP50 | mAP50-95 | P | R | V-sources as Transistor | V-source recall | Transistor P | Transistor R | false Transistors |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for k, s in summary.items():
        lines.append(f"| {k} | {s['mAP50']:.3f} | {s['mAP50-95']:.3f} | {s['precision']:.3f} | {s['recall']:.3f} | "
                     f"{s['pct_voltage_sources_as_transistor']}% ({s['voltage_sources_detected_as_transistor']}/{s['voltage_source_boxes']}) | "
                     f"{s['voltage_source_recall_pct']}% | {s['transistor_precision_pct']}% | {s['transistor_recall_pct']}% | {s['false_transistors_total']} |")
    lines += ["", "## Per class AP50", "", "| class | " + " | ".join(keys) + " |", "|---|" + "---|" * len(keys)]
    for n in names:
        lines.append(f"| {n} | " + " | ".join(f"{per_class[k]['AP50'].get(n, 0):.3f}" for k in keys) + " |")
    (RESULTS / f"comparison_{args.split}.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
