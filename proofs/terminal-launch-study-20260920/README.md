# RP2350 debug-terminal launch study

J4 has 1.7 mm signal pads, 1 mm plated holes and a centre ground pin, 2.54 mm
from each signal. The saved native assessment records J4.2 as a direct eligible
anchor on In1 ground. R19/R20 are 100 ohms; their MCU-side traces are approximately
4.90 mm and 8.36 mm. The project targets 10 MHz SWD, shared ground, at most
100 mm cable and at most 15 pF external loading. These remain design targets.

Raspberry Pi specifies clock/ground/data and recommends 100-ohm resistors near
the host and target ICs. Its specified JST-SH connector differs from this
candidate's 2.54 mm header; signal correspondence does not establish mechanical
compatibility or transfer an electrical test.
[Raspberry Pi debug connector specification, pp.1-3](https://datasheets.raspberrypi.com/debug/debug-connector-specification.pdf).

The complete trace ribbons fail the unchanged reference requirement at the
terminal approaches. Ground must clear the signal pads. A separate prospective
study retains the 0.25 mm margin and all other segments:

| Signal | Maximum approach length from pad centre | Remainder |
| --- | ---: | --- |
| SWCLK_HDR | 1.9 mm | All 11 selected segment remainders covered |
| SWDIO_HDR | 1.5 mm | All 10 selected segment remainders covered |

These lengths include the portion inside the signal pad.
[Clock](SWCLK_HDR.json) and [data](SWDIO_HDR.json) reports retain
the original uncovered results, exact cut points and complete selections.

The optional [toolbox study](../../docs/reference-terminal-launch-study.md)
returns hypothetical results separately. It changes no acceptance or
requirement and does not approve the omitted launch. Pin correspondence and
distance alone do not prove electrical return continuity. The full native
report remains failed/incomplete at 141 pass, 429 unknown and 2 fail.
The board is unchanged at SHA-256
`5fd653d353838cdc4a2dfb36b856d18de65c55d3911aa57cbc9595bac812f05d`.

Run `node --import tsx replay.mjs <qualified-helper.exe> <new-output-directory>`.
This exercises the saved-source capability and actual pinned geometry helper;
it neither opens KiCad nor restores native fill authority. Software/protocol
evidence is separate from a managed session or installed-client qualification.

## Native and installed qualification

[Host49/DOC17](delivery.json) now exposes the study through the actual public
tool in a read-only resumed RP2350 session. Both returned diagnostic resources
were read through MCP and hash-verified; [normal close](native-session.json)
preserved all six native files. [Clock](native-SWCLK_HDR.json) and
[data](native-SWDIO_HDR.json) native-session reports retain both original failures.
No refill or acceptance reassessment was performed during that read-only session.

[Software verification](verification.json) records **56 tests in two files**,
source typecheck and backend compilation. The frozen build reused those exact
source-pinned checks and received fresh backend/helper packaging. This is not
a full-suite claim. [Installation](client-verification.json) verifies host49,
the exact updated PCB skill and 18 tools in a fresh actual Codex client. Existing
desktop connections are not claimed to have reloaded.
