# Candidate 60-03: completed native check collection

**Host 19 completed all four checks on the saved 60-03 board. The board still
fails DRC with 192 unconnected errors.** This is a successful result-collection
follow-up, not a validation pass or design acceptance.

The [native placement snapshot](../native-placement-60-03/README.md) remains
unchanged: PCB SHA-256
`f2444cd203bea55d68a24a309992b8ef88a665dba5466cebd39d306110e3bed3`
(253,192 bytes). Its 22 × 60 mm board contains 66 footprints and **zero tracks,
vias or zones**. Routing, returns, filled reference copper and final functional
labels remain unfinished.

## What returned

The exact [public response](evidence/public-validation-response.json) was
recorded on 19 September 2026 at 01:17:57 UTC in session 29.

| Check | Observed result |
| --- | --- |
| ERC | PASS; zero violations in the retained native report. |
| DRC | FAIL; 192 unconnected errors, zero other violation rows and zero schematic-parity rows. |
| Board summary | PASS as an inventory read: 66 footprints, zero tracks, vias and zones. |
| Visual QA | WARN; all 14 rows retained: eight WARN and six INFO. |

The DRC public summary explicitly returns eight sampled findings and omits 184
from that sample. All 192 ordered findings were retained privately and verified;
repeated producer finding IDs are not deduplicated. The complete native
[DRC JSON](evidence/native-drc-report.json) and
[ERC JSON](evidence/native-erc-report.json) are included here. The private full
MCP response is not included. The compact embedded DRC report identity differs
from the pretty-printed CLI file's byte hash; their parsed report content agrees.

The [verification receipt](evidence/verification-receipt.json) records
the public/private/report comparison. The public response reports
`sourceUnchanged: true` and `recoveryRequired: false`. Its practice analysis ran,
but had no reviewed profile: width, via and net-class checks remain unverified,
as do electrical suitability and manufacturing readiness. Zero measured turns
on an unrouted board establishes no routed-geometry qualification.

The live summary reports 70 nets; saved-source inspection identifies 69 names:
67 functional nets and the two declared J1 no-connect names. The remaining live
entry is not identified by this evidence; no observed "net 0" row is claimed.

## Why collection can finish now

The earlier [32,000-byte result-limit failure](../native-placement-60-03/evidence/validation/public-validation-response.json)
remains a failed historical call. Later host changes retain the complete native
check evidence privately before returning a bounded summary with the original
verdict, totals, explicit sample coverage and artifact identity. They do not
raise the generic result limit or discard blocking errors.

For schematics with power annotations, the read-check guard now sends internal
ERC/DRC replies to that full-report verifier without first forcing them through
the generic text-size classifier. Source checks still run after a design FAIL.
Redaction preserves the two exact public KiCad ERC/DRC schema URLs needed to
validate the report type; private paths and unrelated diagnostic content remain
subject to redaction. These corrections change result handling, not the board or
numerical design rules. The retained
[host 19 release record](evidence/host19-release.json) identifies the build used;
its build qualification alone is not a native result or board approval.

## Warnings and coverage

All 14 visual-QA rows and the WARN verdict remain unchanged in the public
response. A separate read-only source/preview review found that these particular
claims arise from hidden-field and bounding-box approximations:
[visual-QA triage](visual-qa-triage.md). That scoped explanation does not waive
general clearance, assembly readability, mating-header or fastener/tool checks.

Native reports included error, warning and exclusion severities. DRC ignored
`missing_courtyard`, `track_not_centered_on_via`, `tuning_profile_track_geometries`,
`footprint_filters_mismatch` and `footprint_type_mismatch`. ERC ignored
`single_global_label`, `four_way_junction`, `simulation_model_issue` and
`footprint_filter`. Their exact coverage metadata is preserved in the raw files.
The intrinsic J1 pad-to-NPTH finding of approximately 0.194 mm against the 0.25 mm
screen remains unwaived and was not detected by native DRC. Zero other native
violations does not resolve that source-level finding.

## Sources and normal close

The [before](evidence/before-host19-source-check.json) and
[after](evidence/after-host19-validation-source-check.json) checks match all six
authored native files and the workflow report. The
[source-continuity receipt](evidence/source-continuity.json) independently
reproduces the protected-source fingerprint; its private-source entries are
identities only. The
[public normal-close response](evidence/public-normal-close-response-106.json)
reports `closed`; [post-close verification](evidence/normal-close-verification.json)
matches the saved sources and records no remaining lease, unsafe-state or
editor-lock paths under the allocation. Checkpoint hashes appearing in that
receipt are provenance only; no checkpoint is shipped as authority.
The verifier also retains a [compact close summary](evidence/normal-close-summary.json).

[manifest.json](manifest.json) binds the exact copied receipts and raw reports.
No private full MCP response, checkpoint, lease, runtime, process log, credential
or vendor file is included. The earlier placement delivery and its historical
failure evidence were not edited.
