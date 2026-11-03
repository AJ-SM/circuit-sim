"""
circuit-backend/unknown_solver.py
==================================
Find the value of one unknown part ("x") from one known measurement.

    solve_unknown(evaluate, param, target) -> SolveResult

`evaluate(x)` sets the unknown parameter to `x`, solves the circuit and
returns the measured quantity (signed, in the branch-analysis convention)
or None when the circuit can't be solved at that value. `target` is the
measured value the user gave; it is matched by magnitude, because the user
doesn't know which pin the simulator calls "a".

Two methods, tried in order:

1. Exact (linear circuits). By the bilinear theorem, any voltage or current
   of a linear circuit, as a function of ONE element value x (a resistance,
   or a source voltage), is a Möbius function f(x) = (a·x + b) / (c·x + d).
   Three solves fix a, b, c, d up to scale; f(x) = t then has the closed
   form x = (t·d − b) / (a − t·c). Every candidate is checked with one more
   solve, so a circuit that isn't linear in x (diodes, transistors, power,
   AC magnitudes) simply fails the check and falls through to:

2. Numeric. Scan x over its plausible range (log-spaced for R/C/L, linear
   for a source voltage), find where |f(x)| crosses the target, and refine
   each crossing by bisection.
"""

from __future__ import annotations

import math
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

# Part type -> the parameter that "x" stands for.
UNKNOWN_PARAM = {
    "resistor": "resistance",
    "capacitor": "capacitance",
    "inductor": "inductance",
    "vsource_dc": "voltage",
    "battery": "voltage",
    "vsource_dep": "voltage",
    "vsource_ac": "amplitude",
}

PARAM_UNIT = {
    "resistance": "ohm",
    "capacitance": "F",
    "inductance": "H",
    "voltage": "V",
    "amplitude": "V",
}

# Physical search range per parameter. R/C/L must be positive and are
# searched on a log scale; a source voltage may have either sign.
_RANGE = {
    "resistance": (1e-3, 1e9),
    "capacitance": (1e-15, 1.0),
    "inductance": (1e-12, 1e4),
    "voltage": (-1e4, 1e4),
    "amplitude": (1e-6, 1e4),
}
_LOG_SCALE = {"resistance", "capacitance", "inductance", "amplitude"}

# Three well-separated sample points for the exact fit.
_SAMPLES = {
    "resistance": (10.0, 1e3, 1e5),
    "capacitance": (1e-9, 1e-6, 1e-3),
    "inductance": (1e-6, 1e-3, 1.0),
    "voltage": (-7.0, 1.0, 13.0),
    "amplitude": (0.5, 5.0, 50.0),
}

_REL_TOL = 1e-4      # a candidate must reproduce the target to 0.01 %
_ABS_TOL = 1e-9      # ... or to 1 nV / 1 nA for a zero target
_SCAN_POINTS = 61
_BISECT_ITERS = 50


class SolveError(Exception):
    """The measurement can't be met; the message is shown to the user."""


@dataclass
class SolveResult:
    value: float
    solutions: list[float]
    method: str                       # "exact" | "numeric"
    achieved: float                   # measured quantity at `value`
    evaluations: int
    notes: list[str] = field(default_factory=list)


def _close(got: float | None, target: float) -> bool:
    if got is None or not math.isfinite(got):
        return False
    return abs(abs(got) - abs(target)) <= max(_REL_TOL * abs(target), _ABS_TOL)


def _tidy(x: float) -> float:
    """Round to 6 significant figures: ngspice prints 12 digits, so the
    closed form lands a hair off (4000.00015 for 4 kΩ). The rounded value is
    what gets verified, so it still meets the target within _REL_TOL."""
    return float(f"{x:.6g}") if math.isfinite(x) and x != 0 else x


def _in_range(param: str, x: float) -> bool:
    lo, hi = _RANGE[param]
    return math.isfinite(x) and lo <= x <= hi


def _order(param: str, xs: list[float]) -> list[float]:
    """De-duplicate and put the most likely answer first: a positive value
    before a negative one, then the smallest magnitude."""
    out: list[float] = []
    for x in sorted(xs, key=lambda v: (v <= 0, abs(v))):
        if not any(math.isclose(x, y, rel_tol=1e-6, abs_tol=1e-12) for y in out):
            out.append(x)
    return out


def _mobius_candidates(points: list[tuple[float, float]], target: float) -> list[float]:
    """Fit f(x) = (a x + b)/(c x + d) through three points (the null space of
    the homogeneous system) and solve f(x) = ±target."""
    m = np.array([[x, 1.0, -x * y, -y] for x, y in points], dtype=float)
    # Scale rows so a 1e5 Ω sample doesn't swamp a 10 Ω one.
    m /= np.maximum(np.linalg.norm(m, axis=1, keepdims=True), 1e-300)
    _, _, vt = np.linalg.svd(m)
    a, b, c, d = vt[-1]
    out = []
    for t in {abs(target), -abs(target)}:
        den = a - t * c
        if abs(den) < 1e-300:
            continue
        out.append((t * d - b) / den)
    return out


def solve_unknown(evaluate: Callable[[float], float | None], param: str,
                  target: float) -> SolveResult:
    if param not in _RANGE:
        raise SolveError(f"Can't solve for a part's '{param}'.")
    if not math.isfinite(target):
        raise SolveError("The measured value must be a number.")
    count = 0

    def ev(x: float) -> float | None:
        nonlocal count
        count += 1
        try:
            y = evaluate(x)
        except Exception:
            return None
        return y if y is not None and math.isfinite(y) else None

    # ── 1. exact: bilinear fit ──
    samples = _SAMPLES[param]
    with ThreadPoolExecutor(max_workers=3) as pool:
        ys = list(pool.map(ev, samples))
    points = [(x, y) for x, y in zip(samples, ys) if y is not None]
    if len(points) == 3:
        if max(y for _, y in points) - min(y for _, y in points) <= _ABS_TOL:
            raise SolveError(
                "The measured value doesn't change with x, so x can't be found "
                "from it. Pick a voltage or current that x actually affects.")
        verified = []
        for x in map(_tidy, _mobius_candidates(points, target)):
            if _in_range(param, x):
                y = ev(x)
                if _close(y, target):
                    verified.append((x, y))
        if verified:
            xs = _order(param, [x for x, _ in verified])
            achieved = next(y for x, y in verified if x == xs[0])
            return SolveResult(xs[0], xs, "exact", achieved, count)

    # ── 2. numeric: scan + bisection ──
    lo, hi = _RANGE[param]
    log = param in _LOG_SCALE
    if log:
        grid = list(np.logspace(math.log10(lo), math.log10(hi), _SCAN_POINTS))
    else:
        grid = list(np.linspace(lo, hi, _SCAN_POINTS))
        # Source voltages of a few volts are by far the most common; a
        # linear grid over ±10 kV would step right over them.
        grid += list(np.linspace(-100, 100, 81))
        grid = sorted(set(grid))
    with ThreadPoolExecutor(max_workers=8) as pool:
        values = list(pool.map(ev, grid))
    scanned = [(x, y) for x, y in zip(grid, values) if y is not None]
    if len(scanned) < 2:
        raise SolveError("The circuit could not be solved for any value of x. "
                         "Check that it is complete and simulates on its own.")
    mags = [abs(y) for _, y in scanned]
    if max(mags) - min(mags) <= max(_ABS_TOL, 1e-9 * max(mags)):
        raise SolveError(
            "The measured value doesn't change with x, so x can't be found "
            "from it. Pick a voltage or current that x actually affects.")

    m = abs(target)

    def g(y: float) -> float:
        return abs(y) - m

    roots: list[float] = []
    for (x0, y0), (x1, y1) in zip(scanned, scanned[1:]):
        if _close(y0, target):
            roots.append(x0)
            continue
        if g(y0) * g(y1) > 0:
            continue
        a, b, ga = x0, x1, g(y0)
        for _ in range(_BISECT_ITERS):
            mid = math.sqrt(a * b) if log else (a + b) / 2
            ym = ev(mid)
            if ym is None:
                break
            gm = g(ym)
            if ga * gm <= 0:
                b = mid
            else:
                a, ga = mid, gm
            if (log and b / a < 1 + 1e-9) or (not log and b - a < 1e-9 * max(1.0, abs(b))):
                break
        roots.append(math.sqrt(a * b) if log else (a + b) / 2)
    if scanned and _close(scanned[-1][1], target):
        roots.append(scanned[-1][0])

    checked = []
    for x in _order(param, [_tidy(r) for r in roots]):
        y = ev(x)
        if _close(y, target):
            checked.append((x, y))
    if not checked:
        lo_m, hi_m = min(mags), max(mags)
        raise SolveError(
            f"No value of x gives that measurement. Over the whole range of x the "
            f"measured value only reaches {lo_m:.4g} to {hi_m:.4g}.")
    xs = [x for x, _ in checked]
    notes = []
    if len(xs) > 1:
        notes.append("More than one value of x fits; the most likely one is shown first.")
    return SolveResult(xs[0], xs, "numeric", checked[0][1], count, notes)
