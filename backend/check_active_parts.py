"""Check transistor and op-amp simulation against circuit theory.

Runs the /simulate route in-process (no server needed; ngspice must be
installed) on small circuits whose answers are known, and checks:

  * BJT: active-region bias point (Ic = beta * Ib, Vbe ~ 0.65 V, Vce from
    Ohm's law), KCL inside the part (Ic + Ib + Ie = 0), NPN and PNP
  * op-amp: inverting gain -Rf/Rin, non-inverting gain 1 + Rf/Rg,
    saturation at the rails when open loop, AC inverting gain
  * per-pin results: pin_currents/pin_voltages, and that every net's pin
    currents balance (KCL), except the ground net which also carries the
    op-amp's (undrawn) supply current

Run from backend/:
    python check_active_parts.py
"""

import asyncio
import contextlib
import io

import main

FAILS: list[str] = []


def comp(ref, type_, nodes, **params):
    return {"id": ref, "ref": ref, "type": type_, "nodes": nodes, "params": params}


def simulate(components, mode="dc"):
    nets = sorted({n for c in components for n in c["nodes"]}, key=lambda n: (n != "0", n))
    req = main.SimulateRequest(
        netlist={"version": 1, "components": components, "nets": nets},
        analysis={"mode": mode},
    )
    with contextlib.redirect_stdout(io.StringIO()):   # main prints the deck/raw output
        res = asyncio.run(main.simulate(req))
    assert res.ok, res.message
    return {b.ref: b for b in res.branch_analysis}, res


def check(label, value, expected, tol):
    ok = abs(value - expected) <= tol
    print(f"  {'ok  ' if ok else 'FAIL'} {label:38s} {value:+.6g}   expected {expected:+.6g} ± {tol:g}")
    if not ok:
        FAILS.append(label)


def check_kcl(br, label, skip_nets=("0",)):
    """Sum of currents into parts at every net (except skip_nets) is 0."""
    sums: dict[str, float] = {}
    for b in br.values():
        for n, i in zip(b.pin_nodes, b.pin_currents):
            sums[n] = sums.get(n, 0.0) + i
    worst = max((abs(v) for n, v in sums.items() if n not in skip_nets), default=0.0)
    check(f"{label}: KCL worst net", worst, 0.0, 1e-9)


def bjt(type_):
    # Vcc 12 V; Rb 470k from Vcc to base; Rc 1k from Vcc to collector;
    # emitter to ground. PNP: everything mirrored (Vcc = -12 V).
    sign = 1 if type_ == "bjt_npn" else -1
    print(f"\n{type_}: common emitter, beta 100")
    br, _ = simulate([
        comp("V1", "vsource_dc", ["1", "0"], voltage=12 * sign),
        comp("RB", "resistor", ["1", "2"], resistance=470e3),
        comp("RC", "resistor", ["1", "3"], resistance=1e3),
        comp("Q1", type_, ["3", "0", "2"], beta=100),     # pins C, E, B
    ])
    q = br["Q1"]
    ic, ie, ib = q.pin_currents
    vc, ve, vb = q.pin_voltages
    vbe = vb - ve
    check("Vbe magnitude", abs(vbe), 0.65, 0.08)
    ib_expected = (12 - abs(vbe)) / 470e3 * sign
    check("Ib (into base)", ib, ib_expected, abs(ib_expected) * 0.01)
    # Early effect (VAF 100) raises beta by (1 + Vce/VAF) ~ 1.1
    check("Ic / Ib", ic / ib, 100 * (1 + abs(vc) / 100), 3)
    # ngspice converges KCL to its tolerances (abstol 1 pA + reltol), not exactly
    check("Ic + Ib + Ie (part KCL)", ic + ib + ie, 0.0, 1e-8 * abs(ie))
    check("Vce = Vcc - Ic*Rc", vc, 12 * sign - ic * 1e3, 1e-6)
    check("delta_v is Vce", q.delta_v, vc - ve, 1e-6)
    check("current_a is Ic", q.current_a, ic, 1e-12)
    check_kcl(br, type_)


def opamp():
    print("\nopamp: inverting amplifier, Rin 1k, Rf 10k, Vin 1 V")
    br, _ = simulate([
        comp("V1", "vsource_dc", ["1", "0"], voltage=1),
        comp("RIN", "resistor", ["1", "2"], resistance=1e3),
        comp("RF", "resistor", ["2", "3"], resistance=10e3),
        comp("U1", "opamp", ["0", "2", "3"], gain=1e5, vpos=15, vneg=-15),  # +, -, out
    ])
    u = br["U1"]
    check("Vout", u.pin_voltages[2], -10.0, 2e-3)
    check("V(-) virtual ground", u.pin_voltages[1], 0.0, 1e-3)
    check("Iout into output pin", u.pin_currents[2], 1e-3, 1e-6)
    check_kcl(br, "inverting")

    print("\nopamp: non-inverting amplifier, Rf 9k, Rg 1k, Vin 0.5 V")
    br, _ = simulate([
        comp("V1", "vsource_dc", ["1", "0"], voltage=0.5),
        comp("RF", "resistor", ["3", "2"], resistance=9e3),
        comp("RG", "resistor", ["2", "0"], resistance=1e3),
        comp("U1", "opamp", ["1", "2", "3"]),            # default params
    ])
    check("Vout", br["U1"].pin_voltages[2], 5.0, 2e-3)

    print("\nopamp: open-loop comparator saturates at the rails")
    for vin, rail in ((1.0, 12.0), (-1.0, -12.0)):
        br, _ = simulate([
            comp("V1", "vsource_dc", ["1", "0"], voltage=vin),
            comp("RL", "resistor", ["2", "0"], resistance=10e3),
            comp("U1", "opamp", ["1", "0", "2"], gain=1e5, vpos=12, vneg=-12),
        ])
        check(f"Vout for Vin {vin:+g} V", br["U1"].pin_voltages[2], rail, 1e-3)

    print("\nopamp: single-supply rails 0..5 V, follower of 2 V")
    br, _ = simulate([
        comp("V1", "vsource_dc", ["1", "0"], voltage=2),
        comp("U1", "opamp", ["1", "2", "2"], vpos=5, vneg=0),
        comp("RL", "resistor", ["2", "0"], resistance=1e3),
    ])
    check("Vout", br["U1"].pin_voltages[2], 2.0, 1e-3)

    print("\nopamp: AC inverting amplifier, 1 V peak at 1 kHz, gain -4.7")
    br, res = simulate([
        comp("V1", "vsource_ac", ["1", "0"], amplitude=1, frequency=1000),
        comp("RIN", "resistor", ["1", "2"], resistance=10e3),
        comp("RF", "resistor", ["2", "3"], resistance=47e3),
        comp("U1", "opamp", ["0", "2", "3"]),
    ], mode="ac")
    check("|Vout| peak", br["U1"].pin_voltages[2], 4.7, 1e-3)
    check("Iout magnitude", abs(br["U1"].pin_currents[2]), 0.1e-3, 1e-7)


def two_pin_unchanged():
    print("\ntwo-pin parts: pin arrays match the old fields")
    br, _ = simulate([
        comp("V1", "vsource_dc", ["1", "0"], voltage=10),
        comp("R1", "resistor", ["1", "2"], resistance=1e3),
        comp("R2", "resistor", ["2", "0"], resistance=4e3),
    ])
    r1 = br["R1"]
    check("R1 current_a", r1.current_a, 2e-3, 1e-12)
    check("R1 pin_currents[0]", r1.pin_currents[0], r1.current_a, 0)
    check("R1 pin_currents[1]", r1.pin_currents[1], -r1.current_a, 0)
    check("R1 pin_voltages[1]", r1.pin_voltages[1], 8.0, 1e-9)
    check_kcl(br, "divider", skip_nets=())


if __name__ == "__main__":
    bjt("bjt_npn")
    bjt("bjt_pnp")
    opamp()
    two_pin_unchanged()
    print(f"\n{'ALL PASSED' if not FAILS else f'{len(FAILS)} FAILED: ' + ', '.join(FAILS)}")
    raise SystemExit(1 if FAILS else 0)
