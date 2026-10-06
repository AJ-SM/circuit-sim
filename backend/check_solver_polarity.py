"""Audit of the solver's branch-current polarity (run with the backend up).

The backend sends each circuit to ngspice (Modified Nodal Analysis) and
reports, per part, `current_a`: the current THROUGH the part from its first
node (a) to its second (b). This script checks that convention against an
independent MNA solve and against circuit laws, on random resistor networks
with several voltage sources (some forced to absorb power), plus fixed RLC
cases:

  * current_a matches an independent numpy MNA solution, sign and magnitude
  * Ohm's law: a resistor's current_a = (Va - Vb) / R
  * KCL: at every node, the through-currents of the attached parts balance
  * power balance: sum of current_a * delta_v over all parts is 0
  * direction field agrees with the sign of current_a

    python check_solver_polarity.py
"""
import json
import random
import urllib.request

import numpy as np

URL = "http://127.0.0.1:8000/simulate"


def simulate(components, mode="dc"):
    body = {"netlist": {"version": 1, "nets": [], "components": components},
            "analysis": {"mode": mode}}
    req = urllib.request.Request(URL, json.dumps(body).encode(), {"Content-Type": "application/json"})
    res = json.load(urllib.request.urlopen(req))
    assert res["ok"], res.get("message")
    return {b["component_id"]: b for b in res["branch_analysis"]}


def mna(components):
    """Independent DC MNA for resistors + voltage sources. Returns
    {id: current a->b through the part}."""
    nodes = sorted({n for c in components for n in c["nodes"]} - {"0"})
    idx = {n: i for i, n in enumerate(nodes)}
    vs = [c for c in components if c["type"] == "vsource_dc"]
    n, m = len(nodes), len(vs)
    A = np.zeros((n + m, n + m))
    z = np.zeros(n + m)
    for c in components:
        a, b = c["nodes"]
        if c["type"] == "resistor":
            g = 1 / c["params"]["resistance"]
            for p, q, s in ((a, a, 1), (b, b, 1), (a, b, -1), (b, a, -1)):
                if p != "0" and q != "0":
                    A[idx[p], idx[q]] += s * g
    for k, c in enumerate(vs):
        a, b = c["nodes"]
        if a != "0":
            A[idx[a], n + k] += 1; A[n + k, idx[a]] += 1
        if b != "0":
            A[idx[b], n + k] -= 1; A[n + k, idx[b]] -= 1
        z[n + k] = c["params"]["voltage"]
    x = np.linalg.solve(A, z)
    v = lambda node: 0.0 if node == "0" else x[idx[node]]
    out = {}
    for c in components:
        a, b = c["nodes"]
        if c["type"] == "resistor":
            out[c["id"]] = (v(a) - v(b)) / c["params"]["resistance"]
    for k, c in enumerate(vs):
        out[c["id"]] = x[n + k]   # MNA source unknown: current a(+) -> b(-) through it
    return out, v


def check_laws(components, br, label, tol=1e-9):
    problems = []
    # direction field vs sign
    for c in components:
        b = br[c["id"]]
        want = "none" if abs(b["current_a"]) < 1e-15 else ("a_to_b" if b["current_a"] > 0 else "b_to_a")
        if b["direction"] != want:
            problems.append(f"{c['id']}: direction {b['direction']} but current {b['current_a']}")
    # KCL: current leaving node via part = +current_a at node a, -current_a at node b
    net = {}
    for c in components:
        a, bn = c["nodes"]
        i = br[c["id"]]["current_a"]
        net[a] = net.get(a, 0) + i
        net[bn] = net.get(bn, 0) - i
    for node, s in net.items():
        if abs(s) > tol * 10 + 1e-12:
            problems.append(f"KCL at node {node}: imbalance {s:.3e} A")
    # power balance (passive sign convention: sum p = 0)
    p = sum(br[c["id"]]["current_a"] * br[c["id"]]["delta_v"] for c in components)
    scale = sum(abs(br[c["id"]]["current_a"] * br[c["id"]]["delta_v"]) for c in components) or 1
    if abs(p) > 1e-6 * scale:
        problems.append(f"power balance off by {p:.3e} W")
    return problems


def random_network(rng, k):
    """Connected random network: a spanning chain plus extra resistors, and
    2-3 sources at random places / orientations (so some absorb power)."""
    n_nodes = rng.randint(3, 6)
    nodes = ["0"] + [str(i) for i in range(1, n_nodes)]
    comps = []
    for i in range(1, n_nodes):
        comps.append({"id": f"Rc{i}", "ref": f"R{i}", "type": "resistor",
                      "nodes": [nodes[i - 1], nodes[i]] if rng.random() < .5 else [nodes[i], nodes[i - 1]],
                      "params": {"resistance": rng.choice([100, 220, 470, 1000, 2200, 4700])}})
    for j in range(rng.randint(1, 4)):
        a, b = rng.sample(nodes, 2)
        comps.append({"id": f"Rx{j}", "ref": f"R{10 + j}", "type": "resistor", "nodes": [a, b],
                      "params": {"resistance": rng.choice([150, 330, 680, 1500, 3300])}})
    used = set()
    for s in range(rng.randint(2, 3)):
        while True:
            a, b = rng.sample(nodes, 2)
            if frozenset((a, b)) not in used:
                break
        used.add(frozenset((a, b)))
        comps.append({"id": f"V{s}", "ref": f"V{s + 1}", "type": "vsource_dc", "nodes": [a, b],
                      "params": {"voltage": rng.choice([1.5, 3, 5, 9, 12])}})
    return comps


def main():
    rng = random.Random(7)
    failures = 0
    absorbing = 0
    skipped = 0
    sign_errors = 0
    for k in range(40):
        comps = random_network(rng, k)
        try:
            ref, _ = mna(comps)
        except np.linalg.LinAlgError:
            skipped += 1          # sources forming a loop: no unique solution
            continue
        br = simulate(comps)
        probs = check_laws(comps, br, f"net{k}")
        for c in comps:
            got, want = br[c["id"]]["current_a"], ref[c["id"]]
            if abs(want) > 1e-9 and (got > 0) != (want > 0):
                sign_errors += 1
                probs.append(f"{c['id']}: SIGN differs: solver {got:.6e} vs independent MNA {want:.6e}")
            if abs(got - want) > 1e-6 * max(1e-3, abs(want)) + 2e-9:
                probs.append(f"{c['id']}: solver {got:.6e} vs independent MNA {want:.6e}")
            if c["type"] == "resistor":
                ohm = br[c["id"]]["delta_v"] / c["params"]["resistance"]
                # delta_v is reported rounded to 1 µV, so allow that much over R.
                if abs(ohm - got) > 1e-6 * max(1e-3, abs(got)) + 2e-6 / c["params"]["resistance"]:
                    probs.append(f"{c['id']}: Ohm's law (Va-Vb)/R = {ohm:.6e} but current {got:.6e}")
            elif got > 1e-12:
                absorbing += 1     # a source with current + -> - inside absorbs power
        if probs:
            failures += 1
            print(f"net{k}: FAIL\n   " + "\n   ".join(probs))
    print(f"sign disagreements with the independent MNA solve: {sign_errors}")
    print(f"random DC networks: {40 - skipped - failures}/{40 - skipped} consistent "
          f"({absorbing} sources were absorbing power, i.e. charged by others)")

    # Fixed cases with reactive parts.
    cases = {
        "DC: V-R-L (inductor is a short)": [
            {"id": "V", "ref": "V1", "type": "vsource_dc", "nodes": ["1", "0"], "params": {"voltage": 10}},
            {"id": "R", "ref": "R1", "type": "resistor", "nodes": ["1", "2"], "params": {"resistance": 100}},
            {"id": "L", "ref": "L1", "type": "inductor", "nodes": ["2", "0"], "params": {"inductance": 1e-3}}],
        "DC: V-R with C in parallel (C blocks)": [
            {"id": "V", "ref": "V1", "type": "vsource_dc", "nodes": ["1", "0"], "params": {"voltage": 5}},
            {"id": "R", "ref": "R1", "type": "resistor", "nodes": ["1", "0"], "params": {"resistance": 1000}},
            {"id": "C", "ref": "C1", "type": "capacitor", "nodes": ["0", "1"], "params": {"capacitance": 1e-6}}],
        "AC: series V-R-C loop": [
            {"id": "V", "ref": "V1", "type": "vsource_ac", "nodes": ["1", "0"], "params": {"amplitude": 1, "frequency": 1000}},
            {"id": "R", "ref": "R1", "type": "resistor", "nodes": ["1", "2"], "params": {"resistance": 7000}},
            {"id": "C", "ref": "C1", "type": "capacitor", "nodes": ["0", "2"], "params": {"capacitance": 6e-7}}],
    }
    for name, comps in cases.items():
        mode = "tran" if "AC" in name else "dc"
        br = simulate(comps, mode)
        line = ", ".join(f"{c['ref']} {br[c['id']]['current_a'] * 1e3:+.4f} mA {br[c['id']]['direction']}" for c in comps)
        print(f"{name}: {line}")
    return failures


if __name__ == "__main__":
    raise SystemExit(1 if main() else 0)
