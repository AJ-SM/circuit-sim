"""
circuit-backend/value_reader.py
================================
Reads handwritten component values ("4V", "0.7 mH", "7kΩ", "0.6µF") that
sit next to each detected symbol, so generated circuits keep the drawn
values instead of defaults.

  run_ocr(image)                  → OcrItem list (easyocr if installed, else [])
  parse_value(text, cls_name)     → (SI value, unit) from one label string
  value_near_box(box, cls, items) → (SI value, unit) for one component
  assign_values(boxes, items)     → best label per component, each label used once
  format_spice(value, unit, cls)  → "7k", "0.6u", "DC 4", …
  read_designators(image, items)  → printed/handwritten names ("R5") + the value under each
  assign_designators(comps, ds)   → which name labels which component

OCR is optional: without an engine every component keeps its default value.
Handwriting OCR is noisy, so parsing is deliberately forgiving (O→0, l→1,
µ read as u/U/M on a capacitor) and uses the component's class to settle
ambiguous prefixes (an "M" next to a capacitor is micro, never mega).
"""

import math
import re
import os
import threading
from dataclasses import dataclass, field

import numpy as np

# Canonical unit per detected class.
CLASS_UNIT = {
    "Resistor": "ohm",
    "Capacitor": "F",
    "Inductor": "H",
    "Voltage": "V",
    "Battery": "V",
    "AC Source": "V",
    "Dep. Voltage": "V",
}

# Unit letters as they show up in OCR output.
_UNIT_ALIASES = {
    "ohm": ("Ω", "Ω", "ohm", "ohms", "Q", "R", "n", "O", "o", "S", "2"),
    "F": ("F", "f"),
    "H": ("H", "h"),
    "V": ("V", "v"),
}

# Plausible prefixes per unit (OCR letter → multiplier). Case is unreliable in
# handwriting, so each table only contains the readings that make physical
# sense for that part: µ is often read as u/U/M, mega-farads don't exist, and
# milli-ohm resistors are rare enough that "m" on a resistor means mega.
_PREFIXES = {
    "ohm": {"k": 1e3, "K": 1e3, "M": 1e6, "m": 1e6, "G": 1e9, "g": 1e9},
    "F": {"m": 1e-3, "u": 1e-6, "U": 1e-6, "µ": 1e-6, "μ": 1e-6, "M": 1e-6,
          "w": 1e-6, "y": 1e-6,
          "n": 1e-9, "N": 1e-9, "p": 1e-12, "P": 1e-12},
    # pico-henries never appear on a drawn schematic: a "p" there is a µ.
    "H": {"m": 1e-3, "M": 1e-3, "u": 1e-6, "U": 1e-6, "µ": 1e-6, "μ": 1e-6,
          "w": 1e-6, "y": 1e-6, "p": 1e-6, "P": 1e-6,
          "n": 1e-9, "N": 1e-9},
    "V": {"m": 1e-3, "k": 1e3, "K": 1e3},
}

# Values outside these ranges are treated as misreads (e.g. "45µF" read as
# "4545" → 4545 F): a wrong value is worse than the default.
_PLAUSIBLE = {"ohm": (0.1, 1e9), "F": (1e-12, 0.1), "H": (1e-9, 10.0), "V": (1e-3, 1e4)}

# The prefix letter is often not read as a letter at all but as a digit that
# gets glued onto the number: "4k" -> "43" / "46", "47k" -> "476", "0.6µF" ->
# "0.64F", "47u" -> "470". Which digit depends on the letter and the
# handwriting; these are the ones observed (rendered script fonts read k as 6
# and u as 4/6/0; real handwriting read k as 3). Applied only when no prefix
# letter was read, and the result is reported as *inferred* because a genuine
# "43" (ohms) looks identical.
_TRAILING_DIGIT_PREFIX = {
    "ohm": {"3": 1e3, "6": 1e3},
    "F": {"4": 1e-6, "6": 1e-6, "0": 1e-6},
    "H": {"4": 1e-6},
}

# OCR confusions inside the numeric part only.
_DIGIT_FIXES = str.maketrans({"O": "0", "o": "0", "D": "0", "l": "1", "I": "1",
                              "|": "1", "i": "1", ",": ".", "·": "."})

_NUMBER_RE = re.compile(r"^\s*([0-9OoDlIi|]*[.,·]?[0-9OoDlIi|]+)\s*(.*)$")


@dataclass
class OcrItem:
    text: str
    x1: int
    y1: int
    x2: int
    y2: int
    conf: float = 1.0
    # Other readings of the same label (the handwriting model's); see parse_item.
    alts: list[str] = field(default_factory=list)

    @property
    def center(self) -> tuple[float, float]:
        return (self.x1 + self.x2) / 2, (self.y1 + self.y2) / 2


# ── OCR engine ──────────────────────────────────────────────────

_reader = None
_reader_lock = threading.Lock()


def ocr_available() -> bool:
    try:
        import easyocr  # noqa: F401
        return True
    except ImportError:
        return False


# Only characters a value label can contain. easyocr's English charset has no
# Ω or µ; they come back as look-alikes (n, 4, u, …) handled in parse_value.
# R / L / C / D (with V, already there) also let designators like "R5" be read
# as names instead of being forced into digits ("R5" → "35").
_OCR_ALLOWLIST = "0123456789.kKmMuUnNpPvVfFhHRLCD"
# Long side (px) the image is resampled to for OCR. Chosen empirically on
# the canvas test drawing; larger was slower and read fewer labels.
OCR_LONG_SIDE = 1650


# ── Speed ───────────────────────────────────────────────────────
#
# Nearly all of the time to read a drawing is easyocr's CRAFT text detector
# (≈6 s a pass at OCR_LONG_SIDE on CPU, two passes); recognising the boxes it
# finds takes < 0.1 s. Measured on the test drawings, without changing a
# single box or reading:
#   * torch defaults to 8 of this machine's 12 threads: all cores ≈ 11 % faster.
#   * the same CRAFT network run by ONNX Runtime ≈ 20 % faster.
# Tried and rejected: one shared detection for both passes (2× faster but
# drops / misreads labels), int8 CRAFT (slower here and misreads), a lower
# OCR_LONG_SIDE (loses labels), cropping to the ink (drawings fill the frame).
# Set VALUE_OCR_ONNX=0 to keep easyocr's own torch detector.

def _use_all_cores() -> None:
    try:
        import torch
        torch.set_num_threads(os.cpu_count() or 1)
    except Exception:
        pass


class _OrtCraft:
    """Drop-in for easyocr's CRAFT module: same call, same tensors back,
    computed by ONNX Runtime."""
    def __init__(self, session):
        self.session = session

    def __call__(self, x):
        import torch
        y, feature = self.session.run(None, {"x": x.detach().cpu().numpy().astype(np.float32)})
        return torch.from_numpy(y), torch.from_numpy(feature)

    def eval(self):
        return self


def _onnx_detector(reader):
    """CRAFT exported to ONNX once (cached next to easyocr's weights) and
    loaded in ONNX Runtime, or None to keep the torch detector."""
    if os.environ.get("VALUE_OCR_ONNX", "1") == "0":
        return None
    try:
        import onnxruntime as ort
        import torch
        net = getattr(reader.detector, "module", reader.detector).eval()
        path = os.path.join(reader.model_storage_directory, "craft_ort.onnx")
        if not os.path.exists(path):
            tmp = path + ".tmp"
            torch.onnx.export(
                net, torch.randn(1, 3, 640, 800), tmp,
                input_names=["x"], output_names=["y", "feature"],
                dynamic_axes={"x": {2: "h", 3: "w"}, "y": {1: "h2", 2: "w2"},
                              "feature": {2: "h2", 3: "w2"}},
                opset_version=17, dynamo=False)
            os.replace(tmp, path)
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        opts.intra_op_num_threads = os.cpu_count() or 1
        ort_net = _OrtCraft(ort.InferenceSession(path, opts, providers=["CPUExecutionProvider"]))
        # Must agree with the torch network before it replaces it.
        x = torch.rand(1, 3, 96, 128)
        with torch.no_grad():
            ref = net(x)[0].numpy()
        if not np.allclose(ort_net(x)[0].numpy(), ref, atol=1e-3):
            raise RuntimeError("ONNX CRAFT output differs from torch")
        return ort_net
    except Exception as exc:  # no onnxruntime / onnx, export failed, …
        print(f"[value_reader] ONNX text detector unavailable, using torch: {exc}")
        return None


def _get_reader():
    """The easyocr reader, built once (thread-safe) with the fast detector."""
    global _reader
    with _reader_lock:
        if _reader is None:
            import easyocr
            _use_all_cores()
            reader = easyocr.Reader(["en"], gpu=False, verbose=False)
            fast = _onnx_detector(reader)
            if fast is not None:
                reader.detector = fast
            _reader = reader
    return _reader


def warm_up() -> None:
    """Load the OCR models now (the first request otherwise waits for them)."""
    if not ocr_available():
        return
    reader = _get_reader()
    reader.readtext(np.full((64, 160), 255, np.uint8))
    _get_trocr()


def run_ocr(image: np.ndarray) -> list[OcrItem]:
    """Text boxes in the image, with neighbouring words on one line merged
    ("0.7" + "mH" → "0.7mH"). Returns [] when no OCR engine is installed.

    Thin pen strokes OCR badly and results shift with resolution, so the
    image is resampled to a fixed working size and strokes are thickened
    before recognition. Thickening blurs small printed labels together, so
    the unthickened image is read too and the two readings merged."""
    if not ocr_available():
        return []
    import cv2
    reader = _get_reader()

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    scale = OCR_LONG_SIDE / max(gray.shape)
    gray = cv2.resize(gray, None, fx=scale, fy=scale,
                      interpolation=cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA)
    thick = cv2.erode(gray, np.ones((3, 3), np.uint8))   # dark ink → thicker

    passes = []
    for img in (thick, gray):
        found = []
        for quad, text, conf in reader.readtext(img, allowlist=_OCR_ALLOWLIST):
            xs = [p[0] / scale for p in quad]
            ys = [p[1] / scale for p in quad]
            found.append(OcrItem(text, int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys)), float(conf)))
        passes.append(found)
    items = merge_line_items(_merge_passes(*passes))

    orig_gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    for it, alt in zip(items, read_handwriting_batch(orig_gray, items)):
        if alt:
            it.alts.append(alt)
    return items


# ── Handwriting second opinion (TrOCR) ──────────────────────────
#
# easyocr's English model is trained on print and keeps turning the unit
# letter into a digit ("9V" → "93", "2mH" → "2n31", "7kΩ" → "1kn"). TrOCR is
# trained on handwriting and reads most of those right, but it has its own
# misses, so it is used as a second reading of each label easyocr found and
# parse_item picks whichever reading fits the component best. Optional: needs
# `transformers` + `sentencepiece`; the weights (~250 MB) download on first use.
# Set VALUE_OCR_TROCR=0 to turn it off.

TROCR_MODEL = os.environ.get("VALUE_OCR_TROCR_MODEL", "microsoft/trocr-small-handwritten")
# Vertical padding around easyocr's box, as a fraction of the text height.
# Measured: wider crops (incl. horizontal padding) made TrOCR read worse.
_TROCR_PAD = 0.3
# Crops are resized to this height (px) first; tried 32–96 and unscaled,
# 64 read best and stayed the same between 822 px and 1600 px drawings.
_TROCR_HEIGHT = 64

_trocr = None           # (image_processor, tokenizer, model), or False if unavailable
_trocr_lock = threading.Lock()


def _get_trocr():
    global _trocr
    if _trocr is None:
        if os.environ.get("VALUE_OCR_TROCR", "1") == "0":
            _trocr = False
            return _trocr
        try:
            # Loaded piecewise: TrOCRProcessor fails to build the tokenizer
            # under transformers 5, the explicit tokenizer class works.
            from transformers import (RobertaTokenizer, ViTImageProcessor,
                                      VisionEncoderDecoderModel, XLMRobertaTokenizer)
            tok_cls = XLMRobertaTokenizer if "small" in TROCR_MODEL else RobertaTokenizer
            _trocr = (ViTImageProcessor.from_pretrained(TROCR_MODEL),
                      tok_cls.from_pretrained(TROCR_MODEL),
                      VisionEncoderDecoderModel.from_pretrained(TROCR_MODEL).eval())
        except Exception as exc:  # missing package, no network for first download, …
            print(f"[value_reader] TrOCR unavailable, using easyocr only: {exc}")
            _trocr = False
    return _trocr


def _trocr_crop(gray: np.ndarray, item: OcrItem):
    """The label region TrOCR reads (padded vertically, scaled to
    _TROCR_HEIGHT), or None when it is empty."""
    import cv2
    pad = int(_TROCR_PAD * (item.y2 - item.y1))
    crop = gray[max(0, item.y1 - pad):item.y2 + pad, max(0, item.x1):item.x2]
    if crop.size == 0:
        return None
    s = _TROCR_HEIGHT / crop.shape[0]
    return cv2.resize(crop, None, fx=s, fy=s,
                      interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)


def read_handwriting_batch(gray: np.ndarray, items: list[OcrItem]) -> list[str | None]:
    """TrOCR's reading of every label in one batched pass (the processor
    resizes each crop to the same input size, so batching changes nothing but
    the time). None where a label can't be read."""
    out: list[str | None] = [None] * len(items)
    if not items:
        return out
    with _trocr_lock:
        trocr = _get_trocr()
        if not trocr:
            return out
        from PIL import Image
        processor, tokenizer, model = trocr
        crops = [(i, _trocr_crop(gray, it)) for i, it in enumerate(items)]
        crops = [(i, c) for i, c in crops if c is not None]
        if not crops:
            return out
        pixels = processor(images=[Image.fromarray(c).convert("RGB") for _, c in crops],
                           return_tensors="pt").pixel_values
        ids = model.generate(pixels, max_new_tokens=12, num_beams=4)
        for (i, _), text in zip(crops, tokenizer.batch_decode(ids, skip_special_tokens=True)):
            out[i] = clean_handwriting(text)
    return out


def read_handwriting(gray: np.ndarray, item: OcrItem) -> str | None:
    """TrOCR's reading of one label region, cleaned up, or None."""
    with _trocr_lock:
        trocr = _get_trocr()
        if not trocr:
            return None
        import cv2
        from PIL import Image
        processor, tokenizer, model = trocr
        pad = int(_TROCR_PAD * (item.y2 - item.y1))
        crop = gray[max(0, item.y1 - pad):item.y2 + pad, max(0, item.x1):item.x2]
        if crop.size == 0:
            return None
        s = _TROCR_HEIGHT / crop.shape[0]
        crop = cv2.resize(crop, None, fx=s, fy=s,
                          interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
        pixels = processor(images=Image.fromarray(crop).convert("RGB"), return_tensors="pt").pixel_values
        ids = model.generate(pixels, max_new_tokens=12, num_beams=4)
        text = tokenizer.batch_decode(ids, skip_special_tokens=True)[0]
    return clean_handwriting(text)


def clean_handwriting(text: str) -> str:
    """TrOCR emits free text ("4 . 7k", "3V (", ", 220"): drop spaces and
    punctuation, and anything before the first digit."""
    text = re.sub(r"[^0-9.,a-zA-ZΩµμ]", "", text)
    m = re.search(r"[0-9.]", text)
    return text[m.start():].rstrip(".,") if m else ""


def _iou(a: OcrItem, b: OcrItem) -> float:
    iw = min(a.x2, b.x2) - max(a.x1, b.x1)
    ih = min(a.y2, b.y2) - max(a.y1, b.y1)
    if iw <= 0 or ih <= 0:
        return 0.0
    inter = iw * ih
    return inter / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter)


def _merge_passes(first: list[OcrItem], second: list[OcrItem]) -> list[OcrItem]:
    """Union of two readings of the same image. Where both read the same
    spot, keep a well-formed designator over anything else, then the more
    confident reading."""
    def rank(it: OcrItem):
        return (parse_designator(it.text) is not None, it.conf)

    out = list(first)
    for it in second:
        same = [i for i, o in enumerate(out) if _iou(o, it) > 0.3]
        if not same:
            out.append(it)
        elif all(rank(it) > rank(out[i]) for i in same):
            for i in sorted(same, reverse=True):
                del out[i]
            out.append(it)
    return out


def merge_line_items(items: list[OcrItem]) -> list[OcrItem]:
    """Join words that sit side by side on the same text line. A gap up to
    one text height counts as the same label, so "0.7 mH" stays together."""
    items = sorted(items, key=lambda i: i.x1)
    merged: list[OcrItem] = []
    for it in items:
        for m in merged:
            h = max(m.y2 - m.y1, it.y2 - it.y1, 1)
            same_line = abs(m.center[1] - it.center[1]) < 0.5 * h
            if same_line and 0 <= it.x1 - m.x2 <= h:
                m.text += it.text
                m.x2, m.y1, m.y2 = it.x2, min(m.y1, it.y1), max(m.y2, it.y2)
                m.conf = min(m.conf, it.conf)
                break
        else:
            merged.append(OcrItem(it.text, it.x1, it.y1, it.x2, it.y2, it.conf, list(it.alts)))
    return merged


# ── Parsing ─────────────────────────────────────────────────────

def _unit_of(suffix: str) -> str | None:
    """Explicit unit named at the end of a suffix like 'kΩ' / 'mH', if any."""
    s = suffix.strip()
    if not s:
        return None
    for unit, aliases in _UNIT_ALIASES.items():
        for a in sorted(aliases, key=len, reverse=True):
            if s.endswith(a) and (unit != "ohm" or len(a) > 1 or a in "ΩΩ"):
                return unit
    return None


def parse_value(text: str, cls_name: str | None = None) -> tuple[float | None, str | None]:
    """Returns (numeric_value, unit) for one label string, value in SI base
    units (7kΩ → (7000.0, "ohm")), or (None, None) if it isn't a value.

    `cls_name` selects the expected unit, which resolves ambiguous prefixes;
    a label whose explicit unit contradicts the class is rejected."""
    value, unit, _ = parse_value_ex(text, cls_name)
    return value, unit


def parse_value_ex(text: str, cls_name: str | None = None
                   ) -> tuple[float | None, str | None, bool]:
    """Like parse_value, plus `inferred`: True when a trailing digit was
    reinterpreted as a prefix ("43" → 4k), i.e. the value is a guess."""
    value, unit, inferred, _ = _parse(text, cls_name)
    return value, unit, inferred


def _parse(text: str, cls_name: str | None, guess_prefix: bool = True
           ) -> tuple[float | None, str | None, bool, int]:
    """parse_value_ex plus `fit`, how well the label's letters read as a value
    for this class: +2 if it names the unit ("mH", "V"), -1 if the letter in
    the prefix slot is neither a prefix nor the unit ("0.7th" → is that m?).
    `guess_prefix=False` skips the trailing-digit rule, which was calibrated
    on easyocr's confusions and misfires on TrOCR ("45µF" read "4540" → 454µ)."""
    m = _NUMBER_RE.match(text.replace(" ", ""))
    if not m:
        return None, None, False, 0
    digits = m.group(1)
    try:
        number = float(digits.translate(_DIGIT_FIXES))
    except ValueError:
        return None, None, False, 0
    suffix = m.group(2)

    expected = CLASS_UNIT.get(cls_name) if cls_name else None
    explicit = _unit_of(suffix)
    if expected and explicit and explicit != expected:
        return None, None, False, 0
    unit = expected or explicit
    if unit is None:
        return None, None, False, 0

    multiplier = 1.0
    garbled = False
    if suffix:
        prefix = suffix[0]
        prefixes = _PREFIXES[unit]
        # A lone letter that *is* the unit ("5V", "10F") isn't a prefix.
        is_unit_letter = len(suffix) == 1 and _unit_of(suffix) == unit
        if prefix in prefixes and not is_unit_letter:
            multiplier = prefixes[prefix]
        garbled = prefix not in prefixes and not any(a.startswith(prefix) for a in _UNIT_ALIASES[unit])

    lo, hi = _PLAUSIBLE[unit]
    inferred = False
    trailing = _TRAILING_DIGIT_PREFIX.get(unit, {}).get(digits[-1:].translate(_DIGIT_FIXES))
    if guess_prefix and multiplier == 1.0 and trailing and len(digits) > 1:
        if unit == "ohm":
            # bare number, or number + the ohm sign / a stray "n"
            eligible = suffix == "" or explicit == "ohm"
        else:
            # a bare farad/henry is implausible on a hand-drawn schematic, so
            # either the unit letter was written or the raw value is out of range
            eligible = explicit == unit or not (lo <= number <= hi)
        try:
            stripped = float(digits[:-1].translate(_DIGIT_FIXES))
        except ValueError:
            stripped = 0.0
        if eligible and stripped > 0:
            number, multiplier, inferred = stripped, trailing, True

    value = number * multiplier
    # Below a picofarad isn't a drawn capacitor: that "p" was a µ ("0.6pF").
    if unit == "F" and multiplier == 1e-12 and value < lo:
        value = number * 1e-6
    if lo <= value <= hi:
        return value, unit, inferred, 2 * (explicit == unit) - garbled
    return None, None, False, 0


# Letters a reader writes for a handwritten µ. Neither engine was seen to
# turn a real n / p into one of these, while both regularly turn µ into n / p
# (easyocr "10uF" vs TrOCR "10pF"), so a µ reading wins such a disagreement.
_MICRO_LOOKALIKES = set("uUµμwy")
# What a handwritten Ω turns into when it is read as a digit glued onto the
# number ("330Ω" -> "3300" / "3302", "47Ω" -> "470" / "472").
_OHM_AS_DIGITS = set("029")


def _digit_count(text: str) -> int:
    m = _NUMBER_RE.match(text.replace(" ", ""))
    return sum(ch.isdigit() for ch in m.group(1)) if m else 0


def _prefix_letter(text: str) -> str:
    m = _NUMBER_RE.match(text.replace(" ", ""))
    return m.group(2)[:1] if m else ""


def _ohm_glyph_reading(readings: list[str]) -> str | None:
    """Two all-digit readings of a resistor label that share a stem and
    differ only by trailing Ω look-alikes ("3300" / "3302") disagree because
    the Ω was read as digits: the stem is the value ("330")."""
    plain = [t for t in readings if t.isdigit()]
    for i, a in enumerate(plain):
        for b in plain[i + 1:]:
            if a == b:
                continue
            stem = os.path.commonprefix([a, b])
            tails = (a[len(stem):], b[len(stem):])
            if (stem and len(stem) >= max(len(a), len(b)) - 2
                    and all(set(t) <= _OHM_AS_DIGITS for t in tails)):
                return stem
    return None


def parse_item(item: OcrItem, cls_name: str | None) -> tuple[float | None, str | None, bool]:
    """(value, unit, inferred) from the best of an item's readings for this
    class. A reading scores for its letters fitting the class (see _parse),
    for not needing the trailing-digit guess, and for agreeing with the other
    engine. Known disagreements are settled by what each engine gets wrong
    (measured on rendered handwriting): a µ beats an n / p for the same
    number, a reading that kept its decimal point beats the same digits
    without it, and a resistor's Ω read as digits is stripped. Otherwise, on
    a tie the handwriting model wins (it is the better reader of the two)."""
    texts = list(item.alts) + [item.text]
    parsed = [(t, _parse(t, cls_name, guess_prefix=False)) for t in item.alts]
    parsed.append((item.text, _parse(item.text, cls_name)))
    if cls_name == "Resistor":
        stem = _ohm_glyph_reading(texts)
        if stem is not None:
            parsed.insert(0, (stem, _parse(stem, cls_name, guess_prefix=False)))
    parsed = [(t, p) for t, p in parsed if p[0] is not None]
    if not parsed:
        return None, None, False

    values = [p[0] for _, p in parsed]
    micro = CLASS_UNIT.get(cls_name) in ("F", "H")

    def score(entry):
        text, p = entry
        agree = sum(math.isclose(p[0], v, rel_tol=1e-6) for v in values) - 1
        s = p[3] + (not p[2]) + 2 * (agree > 0)
        if micro and _prefix_letter(text) in _MICRO_LOOKALIKES:
            s += 3
        if "." in text and text.replace(".", "") in texts:
            s += 1
        if cls_name == "Resistor" and text.isdigit() and text == _ohm_glyph_reading(texts):
            s += 3
        # A reading that lost two or more digits the other engine saw
        # ("10µF": easyocr "104F", TrOCR "4pyf") is missing part of the number.
        if _digit_count(text) + 2 <= max(_digit_count(t) for t, _ in parsed):
            s -= 2
        return s

    _, (value, unit, inferred, _) = max(parsed, key=score)   # max keeps the first on ties
    return value, unit, inferred


# ── Designators ("R5", "V1") ────────────────────────────────────
#
# Printed schematics (and tidy drawings) name each part, usually with its
# value on the line below:   R5
#                            12
# The name gives the part its reference designator, and the line under it is
# the value: far more reliable than "nearest number to the symbol", which on
# a dense schematic picks up a neighbour's label.

# Designator letter → detector classes it can name.
DESIGNATOR_CLASSES = {
    "R": ("Resistor",),
    "C": ("Capacitor",),
    "L": ("Inductor",),
    "D": ("Diode",),
    "V": ("Voltage", "Battery", "AC Source"),
}
_DESIGNATOR_RE = re.compile(r"^([RCLDV])([0-9OoIl|]{1,3})$")
# Characters a value line may hold when re-read on its own.
_VALUE_ALLOWLIST = "0123456789.kKmMuUnNpPvVfFhH"


def parse_designator(text: str) -> str | None:
    """'R5' -> 'R5', with OCR look-alikes in the number fixed ('Rl0' -> 'R10').
    None for anything else, including 'R0' (numbers never start at 0)."""
    m = _DESIGNATOR_RE.match(text.strip())
    if not m:
        return None
    num = m.group(2).translate(_DIGIT_FIXES)
    if not num.isdigit() or num.startswith("0"):
        return None
    return m.group(1) + num


@dataclass
class Designator:
    name: str                       # "R5"
    item: OcrItem                   # where the name is written
    value: OcrItem | None = None    # the value line under it, if found


def read_designators(image: np.ndarray, items: list[OcrItem]) -> list[Designator]:
    """Designator labels among `items`, each paired with the value written
    directly under it. A value the full-image OCR missed (small single
    digits often are) is re-read from just that spot."""
    found = [Designator(n, it) for it in items if (n := parse_designator(it.text))]
    taken: set[int] = set()
    for d in found:
        it = d.item
        h = max(it.y2 - it.y1, 1)
        below = [
            (o.y1 - it.y2, i) for i, o in enumerate(items)
            if i not in taken and parse_designator(o.text) is None
            and min(o.x2, it.x2) - max(o.x1, it.x1) > 0          # overlaps in x
            and -0.3 * h <= o.y1 - it.y2 <= 0.8 * h
        ]
        if below:
            _, i = min(below)
            taken.add(i)
            d.value = items[i]
        else:
            d.value = _reread_below(image, it)
    return found


def _reread_below(image: np.ndarray, it: OcrItem) -> OcrItem | None:
    """OCR just the strip under a designator, about one text line tall."""
    if _reader is None:
        return None
    import cv2
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
    h = max(it.y2 - it.y1, 1)
    x1, x2 = max(0, it.x1 - h // 2), min(gray.shape[1], it.x2 + h)
    y1, y2 = it.y2, min(gray.shape[0], it.y2 + int(1.3 * h))
    crop = gray[y1:y2, x1:x2].copy()
    if crop.size == 0:
        return None
    # Keep only free-standing glyphs: ink touching the strip's edge belongs to
    # a symbol or wire running past (a zigzag tip reads as ">" or "^").
    _, ink = cv2.threshold(crop, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
    ch, cw = crop.shape
    for i in range(1, n):
        x, y, w, hh, _ = stats[i]
        if x == 0 or y == 0 or x + w >= cw or y + hh >= ch:
            crop[lab == i] = 255
    ys, xs = np.nonzero(crop < 128)
    if ys.size == 0:
        return None
    # Tight around the glyphs, then recognise directly: the text detector
    # tends to miss a lone small character.
    crop = crop[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    s = 48 / crop.shape[0]
    crop = cv2.resize(crop, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
    crop = cv2.copyMakeBorder(crop, 12, 12, 12, 12, cv2.BORDER_CONSTANT, value=255)
    res = _reader.recognize(crop, allowlist=_VALUE_ALLOWLIST)
    if not res:
        return None
    _, text, conf = max(res, key=lambda r: r[2])
    # Low bar: the spot (an isolated glyph right under a name) and the
    # charset are already narrow, and the reading must still parse as a value.
    if conf < 0.05:
        return None
    return OcrItem(text, x1, y1, x2, y2, float(conf))


def assign_designators(components, designators: list[Designator]) -> dict[str, Designator]:
    """{component_id: Designator}: each name goes to the nearest component
    of a class it can name (closest pairs first, each used once)."""
    pairs = []
    for comp in components:
        box = comp.box
        reach = 1.5 * max(box.x2 - box.x1, box.y2 - box.y1)
        for j, d in enumerate(designators):
            if comp.cls_name not in DESIGNATOR_CLASSES.get(d.name[0], ()):
                continue
            dist = _box_distance(box, d.item)
            if d.value is not None:
                dist = min(dist, _box_distance(box, d.value))
            if dist <= reach:
                pairs.append((dist, comp, j))
    pairs.sort(key=lambda p: p[0])
    out: dict[str, Designator] = {}
    used: set[int] = set()
    names: set[str] = set()
    for _, comp, j in pairs:
        d = designators[j]
        if comp.component_id in out or j in used or d.name in names:
            continue
        out[comp.component_id] = d
        used.add(j)
        names.add(d.name)
    return out


# ── Matching labels to components ───────────────────────────────

def _box_distance(box, item: OcrItem) -> float:
    """Gap between the component box and the text box (0 if they overlap)."""
    dx = max(box.x1 - item.x2, item.x1 - box.x2, 0)
    dy = max(box.y1 - item.y2, item.y1 - box.y2, 0)
    return math.hypot(dx, dy)


def value_near_box(box, cls_name: str, items: list[OcrItem],
                   max_dist: float | None = None,
                   exclude: set[int] | None = None) -> tuple[float | None, str | None]:
    """Returns (numeric_value, unit) parsed from OCR text near the box, or (None, None) if nothing usable is found."""
    idx = _best_item(box, cls_name, items, max_dist, exclude)
    return parse_item(items[idx], cls_name)[:2] if idx is not None else (None, None)


def _best_item(box, cls_name, items, max_dist=None, exclude=None) -> int | None:
    """Index of the closest OCR item that parses as a value for this class."""
    if cls_name not in CLASS_UNIT:
        return None
    if max_dist is None:
        # labels are written beside the symbol: allow about one symbol-size away
        max_dist = 1.2 * max(box.x2 - box.x1, box.y2 - box.y1)
    best, best_d = None, float("inf")
    for i, item in enumerate(items):
        if exclude and i in exclude:
            continue
        d = _box_distance(box, item)
        if d > max_dist or d >= best_d:
            continue
        if parse_item(item, cls_name)[0] is None:
            continue
        best, best_d = i, d
    return best


def assign_values(components, items: list[OcrItem]) -> dict[str, tuple[float, str, bool]]:
    """Match labels to components ({ref_des: (value, unit)}). Each label is
    used at most once, closest pairs first, so a label between two parts
    goes to the nearer one and the other part looks further out.
    Each result is (value, unit, inferred); see parse_value_ex."""
    pairs = []
    for comp in components:
        for i, item in enumerate(items):
            if _best_item(comp.box, comp.cls_name, [item]) is not None:
                pairs.append((_box_distance(comp.box, item), comp, i))
    pairs.sort(key=lambda p: p[0])

    values: dict[str, tuple[float, str, bool]] = {}
    used: set[int] = set()
    for _, comp, i in pairs:
        if comp.component_id in values or i in used:
            continue
        value, unit, inferred = parse_item(items[i], comp.cls_name)
        values[comp.component_id] = (value, unit, inferred)
        used.add(i)
    return values


# ── Output ──────────────────────────────────────────────────────

_SPICE_PREFIXES = [(1e9, "G"), (1e6, "Meg"), (1e3, "k"), (1, ""),
                   (1e-3, "m"), (1e-6, "u"), (1e-9, "n"), (1e-12, "p")]


def format_spice(value: float, unit: str, cls_name: str) -> str:
    """SI value → the value string NetlistGenerator / the frontend expect.
    'Meg' (not 'M') because SPICE reads 'M' as milli."""
    for mult, sym in _SPICE_PREFIXES:
        if value >= mult * 0.999:
            text = f"{value / mult:.4g}{sym}"
            break
    else:
        text = f"{value:.4g}"
    if cls_name in ("Voltage", "Battery", "Dep. Voltage"):
        return f"DC {text}"
    if cls_name == "AC Source":
        return f"AC {text}"
    return text
