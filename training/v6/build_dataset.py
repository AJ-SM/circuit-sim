"""
build_dataset.py  -  circuit detector v6 dataset (14 classes)
==============================================================
One clean YOLO dataset from every labelled source on this machine, built
to fix v5's bias (every drawn circle detected as a Transistor).

Why v5 went wrong, and what this build does about it
-----------------------------------------------------
* v5 = v4 fine-tuned only on ~1,000 synthetic images that contain 805
  transistors and ZERO DC voltage sources, so "circle -> Transistor" was
  all it saw.  -> v6 trains once, jointly, on all data.
* Half of v4's data ("rf_" Roboflow copies of CGHD) labels only 9 part
  types: their transistors, op-amps, ground and sources were unlabelled
  background.  -> v6 uses the original CGHD annotations (3,267 drawings,
  every part labelled) instead of the Roboflow copies.
* Repeated copies (_r1/_r2) inflated small sources.  -> each image once;
  rare classes are balanced with repeat-factor sampling in train.txt.
* Parts of a type the system doesn't have (FETs, ICs, logic gates,
  probes...) would be "background" next to similar-looking symbols, e.g.
  a voltage probe is a circle with a V.  -> those regions are painted
  out with the surrounding paper colour.

Splits: CGHD is split by drafter (no handwriting in both train and
val/test). Other sources keep their own splits. Near-duplicate images
(perceptual hash) are removed from train when they appear in val/test.

Output: F:\\circuit_training_v6\\data\\v6\\{images,labels}\\{train,val,test},
        data.yaml, train_rfs.txt (balanced train list), build_report.json
"""

from __future__ import annotations

import argparse
import io
import json
import math
import random
import re
import shutil
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

import imagehash
import yaml
from PIL import Image, ImageOps

PROJECT = Path(r"E:\FYPPP\New folder")
OUT = Path(r"F:\circuit_training_v6\data\v6")

# The system's class list (backend recognizer / netlist_generator). Order is
# the model's class ids; it matches v4/v5 so the backend needs no change.
CLASSES = ["AC Source", "Battery", "Capacitor", "Diode", "Ground", "Inductor",
           "Resistor", "Voltage", "LED", "Lamp", "Transformer", "Switch",
           "Transistor", "Op-Amp"]
CID = {c: i for i, c in enumerate(CLASSES)}

# ── CGHD (Pascal VOC, 61 classes) ───────────────────────────────
CGHD_DIR = PROJECT / "dataset" / "archive"
CGHD_MAP = {
    "voltage.dc": "Voltage", "voltage.ac": "AC Source", "voltage.battery": "Battery",
    "resistor": "Resistor", "resistor.adjustable": "Resistor", "resistor.photo": "Resistor",
    "capacitor.unpolarized": "Capacitor", "capacitor.polarized": "Capacitor",
    "capacitor.adjustable": "Capacitor",
    "inductor": "Inductor", "inductor.ferrite": "Inductor",
    "transformer": "Transformer", "inductor.coupled": "Transformer",
    "diode": "Diode", "diode.zener": "Diode", "diode.light_emitting": "LED",
    "transistor.bjt": "Transistor", "transistor.photo": "Transistor",
    "operational_amplifier": "Op-Amp", "operational_amplifier.schmitt_trigger": "Op-Amp",
    "gnd": "Ground", "vss": "Ground",
    "switch": "Switch", "lamp": "Lamp",
}
# Drawing furniture: present everywhere, never a part. Left as is.
CGHD_KEEP_AS_BACKGROUND = {"text", "junction", "crossover", "terminal", "__background__",
                           "explanatory"}
# Everything else is a real part the system has no class for: painted out.

# ── YOLO sources ────────────────────────────────────────────────
DATSETS = PROJECT / "datsets"
YOLO_ZIPS = [
    dict(zip=DATSETS / "Circuit_component_detection_2.v9-ckt_components_10-417-images-.yolov12.zip",
         prefix="ckt2", pose=False,
         names={"ac_voltage_source": "AC Source", "capacitor": "Capacitor",
                "dc_voltage_source": "Voltage", "diode": "Diode", "ground": "Ground",
                "inductor": "Inductor", "resistor": "Resistor", "switch": "Switch",
                "transformer": "Transformer", "transistor": "Transistor"}),
    dict(zip=DATSETS / "components-pose-op-amps.v5i.yolov8.zip", prefix="opamp", pose=True,
         names={"operational-amplifier": "Op-Amp"}),
    # Synthetic hand-drawn composites (the v5 fine-tune data); already 14-class.
    dict(zip=DATSETS / "composite_circuit_datasetv44.zip", prefix="syn", pose=False,
         names={c: c for c in CLASSES}),
]
# Hand Drawn Circuits v3 + electronic circuit v8, already merged, 8 classes.
OLD_DIR = PROJECT / "circuitmodel" / "dataset" / "merged_dataset"

SPLIT_ALIASES = {"train": "train", "valid": "val", "val": "val", "test": "test"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
MAX_SIDE = 1280          # training runs at 640; keep headroom for scale aug
MIN_BOX_PX = 4           # boxes thinner than this (after resize) are noise


class Builder:
    def __init__(self, out: Path):
        self.out = out
        self.records: list[dict] = []       # one per written image
        self.stats = defaultdict(Counter)   # source -> class counts
        self.notes = Counter()

    # ── writing ──
    def write(self, img: Image.Image, boxes: list[tuple[int, float, float, float, float]],
              split: str, source: str, name: str, mask: list[tuple] = ()) -> None:
        """boxes: (cls, x1, y1, x2, y2) in img pixels. mask: (x1,y1,x2,y2) regions
        to paint out."""
        img = img.convert("RGB")
        if mask:
            img = paint_out(img, mask)
        w, h = img.size
        s = min(1.0, MAX_SIDE / max(w, h))
        if s < 1.0:
            img = img.resize((round(w * s), round(h * s)), Image.LANCZOS)
        W, H = img.size
        lines = []
        for c, x1, y1, x2, y2 in boxes:
            x1, x2 = sorted((max(0.0, x1 * s), min(W, x2 * s)))
            y1, y2 = sorted((max(0.0, y1 * s), min(H, y2 * s)))
            if x2 - x1 < MIN_BOX_PX or y2 - y1 < MIN_BOX_PX:
                self.notes["tiny_box_dropped"] += 1
                continue
            lines.append(f"{c} {(x1 + x2) / 2 / W:.6f} {(y1 + y2) / 2 / H:.6f} "
                         f"{(x2 - x1) / W:.6f} {(y2 - y1) / H:.6f}")
            self.stats[source][CLASSES[c]] += 1
        stem = re.sub(r"[^A-Za-z0-9_.-]", "_", f"{source}_{name}")
        ip = self.out / "images" / split / f"{stem}.jpg"
        lp = self.out / "labels" / split / f"{stem}.txt"
        img.save(ip, quality=92)
        lp.write_text("\n".join(lines) + ("\n" if lines else ""))
        self.records.append(dict(split=split, source=source, image=str(ip), label=str(lp),
                                 classes=sorted({int(l.split()[0]) for l in lines}),
                                 phash=str(imagehash.phash(img.convert("L").resize((256, 256)), hash_size=16))))

    # ── sources ──
    def add_cghd(self, val_drafters: set[str], test_drafters: set[str]) -> None:
        for d in sorted(CGHD_DIR.glob("drafter_*")):
            split = "val" if d.name in val_drafters else "test" if d.name in test_drafters else "train"
            for xml in sorted((d / "annotations").glob("*.xml")):
                root = ET.parse(xml).getroot()
                img_path = d / "images" / root.findtext("filename")
                if not img_path.exists():
                    cands = list((d / "images").glob(xml.stem + ".*"))
                    if not cands:
                        self.notes["cghd_missing_image"] += 1
                        continue
                    img_path = cands[0]
                img = Image.open(img_path)
                xw, xh = int(root.findtext("size/width")), int(root.findtext("size/height"))
                if (xw, xh) != img.size:
                    # Annotation made on the EXIF-rotated view.
                    img = ImageOps.exif_transpose(img)
                    if (xw, xh) != img.size:
                        self.notes["cghd_size_mismatch_skipped"] += 1
                        continue
                    self.notes["cghd_exif_rotated"] += 1
                boxes, mask = [], []
                for o in root.iter("object"):
                    name = o.findtext("name")
                    bb = o.find("bndbox")
                    x1, y1, x2, y2 = (float(bb.findtext(k)) for k in ("xmin", "ymin", "xmax", "ymax"))
                    if name in CGHD_MAP:
                        boxes.append((CID[CGHD_MAP[name]], x1, y1, x2, y2))
                    elif name not in CGHD_KEEP_AS_BACKGROUND:
                        mask.append((x1, y1, x2, y2))
                        self.notes[f"cghd_painted_out:{name}"] += 1
                self.write(img, boxes, split, "cghd", f"{d.name}_{xml.stem}", mask)

    def add_yolo_zip(self, src: dict) -> None:
        with zipfile.ZipFile(src["zip"]) as z:
            cfg = yaml.safe_load(z.read("data.yaml"))
            names = cfg["names"]
            names = [names[k] for k in sorted(names)] if isinstance(names, dict) else names
            remap = {i: CID[src["names"][n]] for i, n in enumerate(names) if n in src["names"]}
            members = set(z.namelist())
            for entry in sorted(members):
                parts = entry.split("/")
                if len(parts) < 3 or parts[-2] != "images" or Path(entry).suffix.lower() not in IMAGE_EXTS:
                    continue
                split = SPLIT_ALIASES.get(parts[-3])
                if split is None:
                    continue
                lab = "/".join(parts[:-2] + ["labels", Path(parts[-1]).stem + ".txt"])
                img = Image.open(io.BytesIO(z.read(entry)))
                W, H = img.size
                boxes = []
                text = z.read(lab).decode() if lab in members else ""
                for line in text.splitlines():
                    v = line.split()
                    if not v:
                        continue
                    c, vals = int(v[0]), list(map(float, v[1:]))
                    if c not in remap:
                        self.notes[f"{src['prefix']}_dropped_class:{names[c] if c < len(names) else c}"] += 1
                        continue
                    if len(vals) == 4 or src["pose"]:
                        cx, cy, bw, bh = vals[:4]
                        x1, y1, x2, y2 = cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2
                    else:   # polygon -> bounding box
                        xs, ys = vals[0::2], vals[1::2]
                        x1, y1, x2, y2 = min(xs), min(ys), max(xs), max(ys)
                    boxes.append((remap[c], x1 * W, y1 * H, x2 * W, y2 * H))
                self.write(img, boxes, split, src["prefix"], Path(parts[-1]).stem)

    def add_old(self) -> None:
        cfg = yaml.safe_load((OLD_DIR / "data.yaml").read_text())
        remap = {i: CID[n] for i, n in enumerate(cfg["names"])}
        for folder, split in (("train", "train"), ("valid", "val"), ("test", "test")):
            for ip in sorted((OLD_DIR / folder / "images").iterdir()):
                if ip.suffix.lower() not in IMAGE_EXTS:
                    continue
                img = Image.open(ip)
                W, H = img.size
                lp = OLD_DIR / folder / "labels" / (ip.stem + ".txt")
                boxes = []
                for line in (lp.read_text().splitlines() if lp.exists() else []):
                    v = line.split()
                    if not v:
                        continue
                    c, vals = int(v[0]), list(map(float, v[1:]))
                    if len(vals) == 4:
                        cx, cy, bw, bh = vals
                        x1, y1, x2, y2 = cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2
                    else:
                        xs, ys = vals[0::2], vals[1::2]
                        x1, y1, x2, y2 = min(xs), min(ys), max(xs), max(ys)
                    boxes.append((remap[c], x1 * W, y1 * H, x2 * W, y2 * H))
                self.write(img, boxes, split, "old", ip.stem)


def paint_out(img: Image.Image, regions) -> Image.Image:
    """Fill each region with the median colour of a thin ring around it (the
    paper), so the symbol disappears instead of becoming background."""
    import numpy as np
    a = np.asarray(img).copy()
    H, W = a.shape[:2]
    for x1, y1, x2, y2 in regions:
        x1, y1 = max(0, int(x1) - 2), max(0, int(y1) - 2)
        x2, y2 = min(W, int(math.ceil(x2)) + 2), min(H, int(math.ceil(y2)) + 2)
        if x2 <= x1 or y2 <= y1:
            continue
        r = 6
        ring = np.concatenate([
            a[max(0, y1 - r):y1, x1:x2].reshape(-1, 3), a[y2:min(H, y2 + r), x1:x2].reshape(-1, 3),
            a[y1:y2, max(0, x1 - r):x1].reshape(-1, 3), a[y1:y2, x2:min(W, x2 + r)].reshape(-1, 3)])
        fill = np.median(ring, axis=0) if len(ring) else np.array([255, 255, 255])
        a[y1:y2, x1:x2] = fill.astype(a.dtype)
    return Image.fromarray(a)


def dedupe(records: list[dict], notes: Counter) -> list[dict]:
    """Drop train images that are near-duplicates of a val/test image (leak),
    and repeated near-identical images inside train."""
    held = defaultdict(list)
    for r in records:
        if r["split"] != "train":
            held["all"].append(imagehash.hex_to_hash(r["phash"]))
    keep, seen = [], {}
    for r in records:
        if r["split"] != "train":
            keep.append(r)
            continue
        h = imagehash.hex_to_hash(r["phash"])
        # 256-bit hash: line drawings on white paper collide on the 64-bit
        # one (65% of distinct synthetic drawings matched). <= 6 bits is a
        # true copy (re-encode, slight crop/brightness).
        if any(h - o <= 6 for o in held["all"]):
            notes["train_dropped_leak_dup_of_val_test"] += 1
            Path(r["image"]).unlink(); Path(r["label"]).unlink()
            continue
        if r["phash"] in seen:
            notes["train_dropped_exact_dup"] += 1
            Path(r["image"]).unlink(); Path(r["label"]).unlink()
            continue
        seen[r["phash"]] = True
        keep.append(r)
    return keep


def repeat_factor_list(records: list[dict], t: float, cap: int) -> tuple[list[str], dict]:
    """Repeat-factor sampling (LVIS): an image is repeated r = max over its
    classes of max(1, sqrt(t / f_c)), f_c = fraction of train images with
    class c. Rare classes (Battery, Lamp, AC Source...) are seen more often
    without blindly duplicating whole sources."""
    train = [r for r in records if r["split"] == "train"]
    n = len(train)
    freq = Counter(c for r in train for c in r["classes"])
    rc = {c: max(1.0, math.sqrt(t / (freq[c] / n))) for c in freq}
    rng = random.Random(0)
    out = []
    for r in train:
        f = min(cap, max([rc[c] for c in r["classes"]], default=1.0))
        k = int(f) + (rng.random() < f - int(f))
        out += [r["image"]] * k
    rng.shuffle(out)
    return out, {CLASSES[c]: round(v, 2) for c, v in sorted(rc.items())}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--rfs-t", type=float, default=0.4)
    ap.add_argument("--rfs-cap", type=int, default=3)
    ap.add_argument("--seed", type=int, default=6)
    args = ap.parse_args()

    if args.out.exists():
        shutil.rmtree(args.out)
    for kind in ("images", "labels"):
        for split in ("train", "val", "test"):
            (args.out / kind / split).mkdir(parents=True)

    drafters = sorted(d.name for d in CGHD_DIR.glob("drafter_*") if d.name != "drafter_-1")
    rng = random.Random(args.seed)
    rng.shuffle(drafters)
    n = max(1, round(0.1 * len(drafters)))
    val_d, test_d = set(drafters[:n]), set(drafters[n:2 * n])

    b = Builder(args.out)
    print("CGHD ...", flush=True); b.add_cghd(val_d, test_d)
    for src in YOLO_ZIPS:
        print(src["prefix"], "...", flush=True); b.add_yolo_zip(src)
    print("old ...", flush=True); b.add_old()
    records = dedupe(b.records, b.notes)

    train_list, rfs = repeat_factor_list(records, args.rfs_t, args.rfs_cap)
    (args.out / "train_rfs.txt").write_text("\n".join(train_list) + "\n")
    data = {"path": str(args.out), "train": "train_rfs.txt", "val": "images/val",
            "test": "images/test", "nc": len(CLASSES), "names": CLASSES}
    (args.out / "data.yaml").write_text(yaml.safe_dump(data, sort_keys=False))
    # Same data without the balancing, for a quick ablation if wanted.
    (args.out / "data_plain.yaml").write_text(yaml.safe_dump({**data, "train": "images/train"}, sort_keys=False))
    (args.out / "records.json").write_text(json.dumps(records))

    split_src = Counter((r["split"], r["source"]) for r in records)
    box_counts = defaultdict(Counter)
    for r in records:
        for line in Path(r["label"]).read_text().splitlines():
            box_counts[r["split"]][CLASSES[int(line.split()[0])]] += 1
    report = {
        "classes": CLASSES,
        "cghd_val_drafters": sorted(val_d), "cghd_test_drafters": sorted(test_d),
        "images_per_split_source": {f"{s}/{src}": k for (s, src), k in sorted(split_src.items())},
        "boxes_per_split": {s: dict(c.most_common()) for s, c in box_counts.items()},
        "train_list_len_after_rfs": len(train_list),
        "repeat_factor_per_class": rfs,
        "notes": dict(b.notes.most_common()),
    }
    (args.out / "build_report.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
