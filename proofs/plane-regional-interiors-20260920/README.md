# Regional drill-interior observations: source-qualified extension

The checker now applies its existing exact drill predicates separately to every
supported stored plane component. The public report retains each native polygon
index, every bore relation, local uncertainties, and a conservative retained-area
lower bound where proved. This addresses the single-component limitation without
asserting that physically separate regions are electrically connected.

The complete saved source, native geometry match and current-session fill witness
remain prerequisites. No historical observation is converted into fresh fill
authority. The original top-level topology result still requires one component;
contact continuity, physical widths, current and thermal suitability remain
separate, and no verification row is promoted by this additional observation.

Tests cover independent connected regions, a bore intersecting just one region,
complete per-region bore retention, privacy filtering, and both regional result
bounds. All regions share the existing four-million-predicate budget. More than
64 components or 16,384 component/bore relations yields an explicit unknown;
there is no silently truncated partial pass.

[Verification](verification.json) records the five-file regression run and the
final drill-topology suite after adding the independent result-size test. These
counts overlap and are not added together. Source typecheck and backend build
pass. The initial large-pad test fixture hit its own existing portable-value
limit; replacing those synthetic pads with vias exercised the intended branch
without changing any runtime limit.

**Not yet native-qualified or installed.** The production entry remains host55.
The RP2350's actual 10 supplemental regions have not received this new check.
[The measured build and native-run budget](disk-budget.json) did not fit the
available disk space while retaining the established reserve. No frozen build,
native session, board edit, lease change or evidence deletion was attempted.
