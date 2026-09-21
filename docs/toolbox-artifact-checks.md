# Native and saved-source artifact checks

The V2 plane assessment can include `artifactChecks` for components and net
classes. These use the original authenticated bundle and verification rows;
no routed-V1 contract or replacement acceptance plan is constructed.

The component group compares the complete current approved library inventory,
all embedded selected symbol pins and graphics, an actual source-bound native
netlist, and the complete collected native physical-pad inventory. It checks
library, schematic-component, schematic-net, derived-power, PCB-component and
board-feature requirements. Repeated physical pads, paste apertures and mechanical
holes retain their separate roles. Native singleton NC dispositions and physical
NC isolation keep their existing independent checks.

The source-only symbol comparison does not invent native live-pin positions or
claim rendered readability. Complete native power-annotation groups remain
required for schematic/derived-power acceptance. A source-verified power flag
is an annotation, not proof of available or suitable electrical power.

Net-class evidence re-reads the canonical rules and current project settings
under the existing pinned KiCad semantic model. It checks exclusive assignments,
trace-width preferences and configured clearance floors. Historical preparation
receipts are compared against the fresh read, not promoted directly to a pass.
Plane clearance and current capacity remain separate.

Both groups are bound to all six current files, the native source scope, approved
libraries and original verification plan. Copied/unbranded evidence, changed
schematics or library tables, duplicate groups and omitted rows reject. The host
checks the full source inventory again after assessment.

These facts do not require fresh plane fill. Their original rows remain available
on read-only reopening, including explicit source failures. A board-feature
source pass still needs the qualified current native hole/clearance check before
its full row passes. Public output separates `sourceStatus` from the effective
row `status` and retains the native-clearance requirement.

Artifact passes establish exact design data and configuration, not component
suitability, current/thermal behavior, signal integrity, rendered readability or
manufacturing readiness. Overall `accepted` and `fabricationAuthorized` remain
false while required engineering work is unfinished.
