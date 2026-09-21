# Trace topology and RP2350 loop correction

Host63 adds source-bound trace topology to the existing V2 assessment. It checks
exact source spines, finite pad/via/track contacts, all enabled copper layers,
drill geometry, connectivity, loops and unsupported contacts without substituting
plane copper. Current native clearance evidence is still required for a final pass.

It caught an actual 3V3 routing loop. Removing nine redundant segments through
the public routing operation preserves all remaining tracks, vias, components
and rules. The [R3 native candidate](../../designs/rp2350-pico/native-r3-trace/README.md)
passes configured ERC/DRC, strict portable parity, GPIO strip and 45-degree checks.

The [fresh-fill report](fresh-fill-report.json) gives **559 pass, 15 unknown,
0 fail; accepted=false**, including 64 trace topology passes. The live native
roundrect ratios on XIN/XTAL_OUT are unsupported and remain unknown. Earlier
offline geometry replay did not establish those live native results.
The [read-only report](read-only-report.json) gives 330 pass, 244 unknown, 0 fail;
all six sources and the top preview are unchanged on reopen. Both sessions close
normally. R2 is preserved as the prior portable package and exact pre-edit snapshot;
the same managed project now holds R3.

[375 tests in 10 files](verification.json), source/UI typechecks and the frozen
backend build pass. No full-suite claim is made. Host63 and the matching skill are
installed; a fresh actual Codex client exposes 19 initial tools. Activation in an
already-connected desktop session is not established. D: must stay mounted.

Read [the scope guide](../../docs/toolbox-trace-topology.md) and
[remaining requirements](remaining-requirements.json). Native connectivity and
topology do not establish USB startup, component suitability, thermal/current
capacity, interface performance or manufacturing readiness.
