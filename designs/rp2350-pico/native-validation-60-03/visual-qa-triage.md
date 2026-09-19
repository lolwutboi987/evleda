# Scoped review of the 14 visual-QA rows

This note records the independent reviewer's read-only source and preview
comparison. It is derived commentary, not a replacement native verdict. The
[original public response](evidence/public-validation-response.json) retains
all eight WARN and six INFO rows and its WARN status.

The review bound PCB `f2444cd2…e3bed3` to the original
[top](../native-placement-60-03/previews/board-top.png) and
[assembly](../native-placement-60-03/previews/board-assembly.png) views. Their
[export receipts](../native-placement-60-03/evidence/public-top-preview-response-332.json)
and [assembly receipt](../native-placement-60-03/evidence/public-assembly-preview-response-337.json)
report unchanged sources. Compared with the independently verified pre-field
PCB `115a4565…0bf61`, all parsed source outside Reference/Value properties was
unchanged.

| Original QA claims | Source facts reported by the reviewer |
| --- | --- |
| Offboard J2, J3, J4 — three WARN | Courtyard bounds, in mm: J2 X=1.01–3.21, Y=4.77–55.23; J3 X=18.79–20.99, Y=4.77–55.23; J4 X=6.69–15.31, Y=55.43–58.97. All fit within 22 × 60 mm. |
| Reference overlap C1/R2, C18/C19, C6/U1, R13/R14, R18/Y1 — five WARN | Both Reference properties are hidden in the first, second and fourth pairs. C6 and R18 are hidden in the other two pairs; U1 and Y1 remain visible. These are not overlaps between two visible silkscreen Reference properties. |
| Body overlap C20/U2 and C21/U2 — two INFO | Each has a nominal F.Fab body gap of 1.00 mm and courtyard-centerline gap of 0.25 mm. |
| Body overlap J4/L2 and SW1/Y1 — two INFO | Respectively 0.92/0.90 mm nominal body gaps and 0.16/0.15 mm courtyard-centerline gaps. |
| Body overlap H1/J2 and H4/J3 — two INFO | Each has a 1.72 mm Y gap between the bore envelope and header courtyard. The bare bore is not a fastener-head/tool envelope. |

The inspected DOC11 producer collects unrotated all-layer graphics/pad extents
and discards their local offset (`tools/pcb.py`, lines 1295–1342). Its readability
helper centers those dimensions on the footprint anchor
(`utils/pcb_readability.py`, lines 66–73). The Reference check ignores hide/layer,
rotates the anchor with the positive footprint angle and adds root rotation to
the already absolute property angle (lines 76–102). These approximations explain
why the reported collisions are unsupported by the observed saved geometry.

This review addresses those 14 specific claims. It is not unrestricted geometric
clearance, a full font/stroke-box audit or a fabrication verdict. Small stock Fab
identifier readability, actual mating hardware and tool access, completed copper
routing, reference returns and electrical/thermal performance remain unqualified.
No native edit, new native check or checker-rule change was performed for this
triage.
