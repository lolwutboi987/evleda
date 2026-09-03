from __future__ import annotations

import unittest
from dataclasses import replace
from functools import lru_cache
from pathlib import Path

import pytest

from backend.canonical_import import (
    ComponentProvenanceRequest,
    ImportMappingInvariantError,
    TrustedComponentResolution,
    map_project_import,
)
from backend.canonical_import.mapper import (
    _parity_context,
    _payloads_for_graph,
    _proven_no_connect_board_net_ids,
    _root_sheet_board_net_name,
)
from backend.design_kernel import (
    CommandKind,
    Component,
    DesignCommand,
    DesignGraph,
    DesignKernel,
    FootprintHole,
    FootprintPad,
    FootprintPlacement,
    Net,
    PinDefinition,
    PinRef,
    PointNm,
    stable_hash,
)
from backend.kicad_compile import compile_design_graph
from backend.kicad_io import PadKind, canonical_net_id
from backend.kicad_project import (
    LabelKind,
    ProjectBundle,
    ProjectBundleInput,
    ProjectImportResult,
    UnsupportedPolicy,
    import_project_bundle,
)
from backend.reference_design.builder import build_reference_board

FIXTURES = Path(__file__).parents[1] / "fixtures"
PROJECT_FIXTURES = FIXTURES / "kicad_project"
BOARD_FIXTURES = FIXTURES / "kicad"
DATASHEET = "a" * 64
PIN_MAP = "b" * 64
TRUST_SNAPSHOT = "c" * 64


def _source(*, board_name: str = "supported_board.kicad_pcb", exact_stage: bool = False):
    board_payload = (BOARD_FIXTURES / board_name).read_bytes()
    if exact_stage:
        board_text = board_payload.decode("utf-8")
        board_text = board_text.replace("    (attr smd)\n", "")
        board_text = board_text.replace("    (attr through_hole)\n", "")
        board_text = board_text.replace('smd roundrect', 'smd rect')
        board_text = board_text.replace('      (roundrect_rratio 0.25)\n', '')
        board_text = board_text.replace(
            '(layers "F.Cu" "F.Paste" "F.Mask")', '(layers "F.Cu")'
        )
        board_text = board_text.replace(
            '(layers "*.Cu" "*.Mask")', '(layers "*.Cu")'
        )
        board_payload = board_text.encode("utf-8")
    return ProjectBundleInput(
        "supported_project",
        (PROJECT_FIXTURES / "supported_project.kicad_pro").read_bytes(),
        (PROJECT_FIXTURES / "supported_project.kicad_sch").read_bytes(),
        board_payload,
    )


def _import(*, board_name: str = "supported_board.kicad_pcb", exact_stage: bool = False):
    return import_project_bundle(
        _source(board_name=board_name, exact_stage=exact_stage),
        unsupported_policy=(
            UnsupportedPolicy.MANIFEST
            if board_name == "unsupported_zone.kicad_pcb"
            else UnsupportedPolicy.REJECT
        ),
    )


def _multipad_slot_source() -> ProjectBundleInput:
    source = _source(exact_stage=True)
    board_text = source.board_payload.decode("utf-8")
    original = '''    (pad "1" thru_hole circle
      (at 0 0)
      (size 1.8 1.8)
      (drill 0.9)
      (layers "*.Cu")
      (net 1 "GND")
      (pinfunction "GND")
      (pintype "passive")
      (uuid 00000000-0000-4000-8000-000000000211))'''

    def slot(at: str, suffix: int) -> str:
        return f'''    (pad "1" thru_hole oval
      (at {at})
      (size 1.2 1.7)
      (drill oval 0.6 1.1)
      (layers "*.Cu")
      (net 1 "GND")
      (pinfunction "GND")
      (pintype "passive")
      (uuid 00000000-0000-4000-8000-00000000021{suffix}))'''

    replacement = "\n".join(
        (
            slot("-2 -2", 1),
            slot("2 -2", 2),
            slot("-2 2", 3),
            slot("2 2", 4),
        )
    )
    if original not in board_text:
        raise AssertionError("expected exact-stage through-hole fixture block")
    return replace(
        source,
        board_payload=board_text.replace(original, replacement, 1).encode("utf-8"),
    )


def _canonical_local_prefix_source() -> ProjectBundleInput:
    source = _source(exact_stage=True)
    board_text = source.board_payload.decode("utf-8")
    old = '(net 2 "SIG")'
    if board_text.count(old) < 2:
        raise AssertionError("expected SIG net declaration and pad binding in fixture")
    return replace(
        source,
        board_payload=board_text.replace(old, '(net 2 "/SIG")').encode("utf-8"),
    )


@lru_cache(maxsize=1)
def _r2_source_and_import() -> tuple[ProjectBundleInput, ProjectImportResult]:
    payload = compile_design_graph(
        build_reference_board().graph,
        "reference_usb_c_3v3_r2",
    ).bundle
    return payload, import_project_bundle(payload)


def _rename_board_net(bundle: ProjectBundle, old_name: str, new_name: str) -> ProjectBundle:
    board = bundle.board
    old_net = next(item for item in board.nets if item.name == old_name)
    new_net_id = canonical_net_id(new_name)

    def remap(net_id: str | None) -> str | None:
        return new_net_id if net_id == old_net.net_id else net_id

    return replace(
        bundle,
        board=replace(
            board,
            nets=tuple(
                replace(item, net_id=new_net_id, name=new_name)
                if item.net_id == old_net.net_id
                else item
                for item in board.nets
            ),
            footprints=tuple(
                replace(
                    footprint,
                    pads=tuple(
                        replace(pad, net_id=remap(pad.net_id))
                        for pad in footprint.pads
                    ),
                )
                for footprint in board.footprints
            ),
            segments=tuple(
                replace(item, net_id=remap(item.net_id)) for item in board.segments
            ),
            vias=tuple(replace(item, net_id=remap(item.net_id)) for item in board.vias),
            zones=tuple(
                replace(
                    item,
                    net_id=remap(item.net_id),
                    net_name=new_name if item.net_id == old_net.net_id else item.net_name,
                )
                for item in board.zones
            ),
        ),
    )


def _reseal(imported: ProjectImportResult, bundle: ProjectBundle) -> ProjectImportResult:
    evidence = replace(
        imported.evidence,
        project_ir_sha256=bundle.manifest.normalized_ir_sha256,
        schematic_ir_sha256=bundle.schematic.normalized_ir_sha256,
        board_ir_sha256=bundle.board.normalized_ir_sha256,
        bundle_ir_sha256=bundle.normalized_ir_sha256,
        diagnostics_manifest_sha256=bundle.diagnostics.manifest_sha256,
    )
    return ProjectImportResult(bundle, evidence)


class FixtureResolver:
    def resolve(
        self, request: ComponentProvenanceRequest
    ) -> TrustedComponentResolution | None:
        component = Component(
            f"component-{request.reference.lower()}",
            request.reference,
            request.value,
            f"PROVEN-{request.reference}",
            request.footprint_library_id,
            request.schematic_library_id,
            request.footprint_library_id,
            DATASHEET,
            PIN_MAP,
            tuple(
                PinDefinition(
                    pin.pin_number,
                    pin.pin_name,
                    pin.electrical_type,
                    pin.pad_number,
                    required=not (
                        pin.electrical_type == "no_connect" and pin.net_name is None
                    ),
                )
                for pin in request.pins
            ),
        )
        return TrustedComponentResolution.create(
            request=request,
            evidence_id=f"evidence-{request.reference.lower()}",
            resolver_id="fixture-catalog-v1",
            trust_snapshot_sha256=TRUST_SNAPSHOT,
            component=component,
        )


class UnresolvedResolver:
    def resolve(self, request: ComponentProvenanceRequest):
        return None


class WrongRequestResolver(FixtureResolver):
    def resolve(self, request: ComponentProvenanceRequest):
        altered = replace(request, source_bundle_ir_sha256="d" * 64)
        return super().resolve(altered)


class WrongNoConnectTypeResolver(FixtureResolver):
    def resolve(
        self, request: ComponentProvenanceRequest
    ) -> TrustedComponentResolution | None:
        resolved = super().resolve(request)
        assert resolved is not None
        if not any(pin.electrical_type == "no_connect" for pin in request.pins):
            return resolved
        component = replace(
            resolved.component,
            pins=tuple(
                replace(pin, electrical_type="passive")
                if pin.electrical_type == "no_connect"
                else pin
                for pin in resolved.component.pins
            ),
        )
        return TrustedComponentResolution.create(
            request=request,
            evidence_id=resolved.evidence_id,
            resolver_id=resolved.resolver_id,
            trust_snapshot_sha256=resolved.trust_snapshot_sha256,
            component=component,
        )


class CanonicalProjectImportMappingTests(unittest.TestCase):
    def _mapping(self, imported, *, project_id="import-project", source_payload=None):
        empty = DesignKernel(DesignGraph(1, project_id))
        return map_project_import(
            imported,
            source_payload=_source() if source_payload is None else source_payload,
            project_id=project_id,
            base_revision=empty.head.revision_hash,
            transaction_id="transaction-import-1",
            actor="trusted-import-boundary",
            component_resolver=FixtureResolver(),
        )

    def test_maps_full_project_named_connectivity_and_reports_every_loss(self) -> None:
        result = self._mapping(_import())

        self.assertIsNotNone(result.candidate)
        assert result.candidate is not None
        graph = result.candidate.graph
        self.assertEqual(result.candidate.graph_sha256, graph.graph_hash)
        self.assertEqual({item.name for item in graph.nets}, {"GND", "SIG"})
        self.assertEqual(len(graph.schematic_wires), 4)
        self.assertEqual(len(graph.schematic_junctions), 1)
        self.assertEqual(graph.schematic_wires[0].vertices[0].x % 10_000, 0)
        self.assertEqual(len(result.candidate.provenance_bindings), 2)
        self.assertEqual(result.kicad_execution, "not-run")
        self.assertFalse(result.manufacturing_release_eligible)

        codes = {item.code for item in result.blockers}
        self.assertIn("footprint-attributes-source-retained", codes)
        self.assertIn("pad-fabrication-layers-source-retained", codes)
        self.assertIn("roundrect-ratio-source-retained", codes)
        self.assertNotIn("pcb-only-schematic-parity-unproven", codes)
        self.assertNotIn("net-membership-inferred-from-pcb-pads", codes)
        self.assertFalse(result.stage_eligible)
        self.assertIsNone(result.transaction_input)

    def test_root_sheet_namespace_truth_table_preserves_literal_slashes(self) -> None:
        local = frozenset({LabelKind.LOCAL})
        global_ = frozenset({LabelKind.GLOBAL})
        mixed = frozenset({LabelKind.LOCAL, LabelKind.GLOBAL})
        self.assertEqual(_root_sheet_board_net_name("SIG", local), "/SIG")
        self.assertEqual(_root_sheet_board_net_name("SIG", global_), "SIG")
        self.assertEqual(_root_sheet_board_net_name("SIG", mixed), "SIG")
        self.assertEqual(_root_sheet_board_net_name("/SIG", local), "//SIG")
        self.assertEqual(_root_sheet_board_net_name("/SIG", global_), "/SIG")

    def test_prefixed_root_local_source_maps_and_replays_as_logical_net(self) -> None:
        source_payload = _canonical_local_prefix_source()
        imported = import_project_bundle(source_payload)
        source_sig = next(item for item in imported.bundle.board.nets if item.name == "/SIG")
        logical_sig_id = canonical_net_id("SIG")
        self.assertNotEqual(source_sig.net_id, logical_sig_id)

        project_id = "prefixed-local-import"
        kernel = DesignKernel(DesignGraph(1, project_id))
        result = map_project_import(
            imported,
            source_payload=source_payload,
            project_id=project_id,
            base_revision=kernel.head.revision_hash,
            transaction_id="transaction-prefixed-local",
            actor="trusted-import-boundary",
            component_resolver=FixtureResolver(),
        )
        self.assertEqual(result.blockers, ())
        self.assertTrue(result.stage_eligible)
        self.assertIsNotNone(result.candidate)
        self.assertIsNotNone(result.transaction_input)
        assert result.candidate is not None and result.transaction_input is not None
        graph = result.candidate.graph
        self.assertEqual({item.name for item in graph.nets}, {"GND", "SIG"})
        self.assertEqual(
            next(item.net_id for item in graph.nets if item.name == "SIG"),
            logical_sig_id,
        )
        self.assertNotIn("/SIG", {item.name for item in graph.nets})
        self.assertEqual(
            {
                item.net_id
                for item in graph.pads
                if item.component_id == "component-u1" and item.pad_number == "2"
            },
            {logical_sig_id},
        )
        self.assertTrue(
            all(item.net_id == logical_sig_id for item in graph.tracks)
        )
        self.assertTrue(
            all(item.net_id == logical_sig_id for item in graph.vias)
        )
        sig_wire_ids = {
            item.wire_id
            for item in imported.bundle.schematic.nets
            if item.name == "SIG"
            for item in imported.bundle.schematic.wires
            if item.wire_id in next(
                net.wire_ids for net in imported.bundle.schematic.nets if net.name == "SIG"
            )
        }
        self.assertEqual(
            {item.net_id for item in graph.schematic_wires if item.wire_id in sig_wire_ids},
            {logical_sig_id},
        )
        u1_binding = next(
            item
            for item in result.candidate.provenance_bindings
            if item.request.reference == "U1"
        )
        self.assertEqual(
            next(item.net_name for item in u1_binding.request.pins if item.pin_number == "2"),
            "SIG",
        )
        self.assertNotIn('/SIG', "\n".join(
            command.payload_json for command in result.transaction_input.commands
        ))

        kernel.begin_transaction(
            result.transaction_input.transaction_id,
            base_revision=kernel.head.revision_hash,
        )
        for command in result.transaction_input.commands:
            transaction = kernel.stage(command)
        self.assertEqual(transaction.staged_graph, graph)

    @pytest.mark.restricted_evidence
    def test_r2_maps_local_aliases_and_proven_nc_auto_nets_to_logical_graph(self) -> None:
        source_payload, imported = _r2_source_and_import()
        self.assertEqual(len(imported.bundle.schematic.nets), 13)
        self.assertEqual(len(imported.bundle.board.nets), 21)
        self.assertEqual(len(_proven_no_connect_board_net_ids(imported)), 8)

        project_id = "reference-r2-canonical-import"
        kernel = DesignKernel(DesignGraph(1, project_id))
        result = map_project_import(
            imported,
            source_payload=source_payload,
            project_id=project_id,
            base_revision=kernel.head.revision_hash,
            transaction_id="transaction-reference-r2-import",
            actor="trusted-import-boundary",
            component_resolver=FixtureResolver(),
        )
        self.assertIsNotNone(result.candidate)
        assert result.candidate is not None
        graph = result.candidate.graph
        self.assertEqual(len(graph.components), 23)
        self.assertEqual(len(graph.nets), 13)
        self.assertEqual(sum(len(item.members) for item in graph.nets), 59)
        self.assertFalse(any(item.name.startswith("unconnected-(") for item in graph.nets))
        self.assertEqual(sum(item.net_id is None for item in graph.pads), 8)
        self.assertEqual(
            sum(
                pin.electrical_type == "no_connect" and not pin.required
                for component in graph.components
                for pin in component.pins
            ),
            8,
        )
        self.assertNotIn("named-net-population-mismatch", {item.code for item in result.blockers})
        self.assertNotIn("pin-pad-net-parity-mismatch", {item.code for item in result.blockers})
        self.assertNotIn(
            "schematic-no-connect-unrepresented",
            {item.code for item in result.blockers},
        )

        raw_name_by_id = {
            item.net_id: item.name for item in imported.bundle.board.nets
        }

        def expected_logical_net_id(raw_net_id: str | None) -> str | None:
            if raw_net_id is None:
                return None
            raw_name = raw_name_by_id[raw_net_id]
            if raw_name.startswith("unconnected-("):
                return None
            self.assertTrue(raw_name.startswith("/"), raw_name)
            return canonical_net_id(raw_name[1:])

        graph_pads_by_id = {item.pad_id: item for item in graph.pads}
        for footprint in imported.bundle.board.footprints:
            for source_pad in footprint.pads:
                if source_pad.kind is PadKind.NPTH or not source_pad.number:
                    continue
                self.assertEqual(
                    graph_pads_by_id[source_pad.pad_id].net_id,
                    expected_logical_net_id(source_pad.net_id),
                )
        graph_tracks_by_id = {item.track_id: item for item in graph.tracks}
        for source_segment in imported.bundle.board.segments:
            self.assertEqual(
                graph_tracks_by_id[source_segment.segment_id].net_id,
                expected_logical_net_id(source_segment.net_id),
            )
        graph_vias_by_id = {item.via_id: item for item in graph.vias}
        for source_via in imported.bundle.board.vias:
            self.assertEqual(
                graph_vias_by_id[source_via.via_id].net_id,
                expected_logical_net_id(source_via.net_id),
            )
        graph_zones_by_id = {item.zone_id: item for item in graph.zones}
        for source_zone in imported.bundle.board.zones:
            self.assertEqual(
                graph_zones_by_id[source_zone.zone_id].net_id,
                expected_logical_net_id(source_zone.net_id),
            )
        self.assertFalse(
            any(
                pin.net_name is not None and pin.net_name.startswith("/")
                for binding in result.candidate.provenance_bindings
                for pin in binding.request.pins
            )
        )

        nc_pad = next(item for item in graph.pads if item.net_id is None)
        forged_graph = replace(
            graph,
            pads=tuple(
                replace(item, net_id=graph.nets[0].net_id)
                if item.pad_id == nc_pad.pad_id
                else item
                for item in graph.pads
            ),
        ).normalized()
        with self.assertRaises(ImportMappingInvariantError):
            replace(
                result.candidate,
                graph=forged_graph,
                graph_sha256=forged_graph.graph_hash,
            )

    @pytest.mark.restricted_evidence
    def test_r2_namespace_and_routed_nc_adversaries_fail_closed(self) -> None:
        _source_payload, imported = _r2_source_and_import()

        wrong_prefix_bundle = _rename_board_net(imported.bundle, "/3V3", "//3V3")
        context, blockers = _parity_context(_reseal(imported, wrong_prefix_bundle))
        self.assertIsNone(context)
        self.assertIn("named-net-population-mismatch", {item.code for item in blockers})

        u2 = next(
            item for item in imported.bundle.schematic.symbols if item.reference == "U2"
        )
        wrong_type_u2 = replace(
            u2,
            pins=tuple(
                replace(pin, electrical_type="passive") if pin.number == "2" else pin
                for pin in u2.pins
            ),
        )
        wrong_type_bundle = replace(
            imported.bundle,
            schematic=replace(
                imported.bundle.schematic,
                symbols=tuple(
                    wrong_type_u2 if item.symbol_id == u2.symbol_id else item
                    for item in imported.bundle.schematic.symbols
                ),
            ),
        )
        wrong_type = _reseal(imported, wrong_type_bundle)
        context, blockers = _parity_context(wrong_type)
        self.assertIsNone(context)
        self.assertIn(
            "schematic-no-connect-pin-type-unrepresented",
            {item.code for item in blockers},
        )

        source_payload, imported = _r2_source_and_import()
        kernel = DesignKernel(DesignGraph(1, "r2-wrong-resolver-nc-type"))
        wrong_resolver = map_project_import(
            imported,
            source_payload=source_payload,
            project_id="r2-wrong-resolver-nc-type",
            base_revision=kernel.head.revision_hash,
            transaction_id="transaction-r2-wrong-resolver-nc-type",
            actor="trusted-import-boundary",
            component_resolver=WrongNoConnectTypeResolver(),
        )
        self.assertIsNone(wrong_resolver.candidate)
        self.assertIn(
            "component-provenance-parity-mismatch",
            {item.code for item in wrong_resolver.blockers},
        )

        labels = tuple(
            replace(item, kind=LabelKind.GLOBAL) if item.name == "3V3" else item
            for item in imported.bundle.schematic.labels
        )
        global_bundle = replace(
            imported.bundle,
            schematic=replace(imported.bundle.schematic, labels=labels),
        )
        context, blockers = _parity_context(_reseal(imported, global_bundle))
        self.assertIsNone(context)
        self.assertIn("named-net-population-mismatch", {item.code for item in blockers})

        nc_net_id = next(
            item.net_id
            for item in imported.bundle.board.nets
            if item.name == "unconnected-(U2-NC-Pad2)"
        )
        board = imported.bundle.board
        nc_name = next(item.name for item in board.nets if item.net_id == nc_net_id)
        routed_boards = {
            "segment": replace(
                board,
                segments=(
                    replace(board.segments[0], net_id=nc_net_id),
                    *board.segments[1:],
                ),
            ),
            "via": replace(
                board,
                vias=(replace(board.vias[0], net_id=nc_net_id), *board.vias[1:]),
            ),
            "zone": replace(
                board,
                zones=(
                    replace(board.zones[0], net_id=nc_net_id, net_name=nc_name),
                    *board.zones[1:],
                ),
            ),
        }
        for route_kind, routed_board in routed_boards.items():
            with self.subTest(route_kind=route_kind):
                routed = _reseal(imported, replace(imported.bundle, board=routed_board))
                self.assertNotIn(nc_net_id, _proven_no_connect_board_net_ids(routed))
                context, blockers = _parity_context(routed)
                self.assertIsNone(context)
                self.assertIn(
                    "named-net-population-mismatch",
                    {item.code for item in blockers},
                )

        malformed_bundle = _rename_board_net(
            imported.bundle,
            "unconnected-(U2-NC-Pad2)",
            "unconnected-(U2-NC-Pad2)-forged",
        )
        malformed = _reseal(imported, malformed_bundle)
        self.assertNotIn(
            canonical_net_id("unconnected-(U2-NC-Pad2)-forged"),
            _proven_no_connect_board_net_ids(malformed),
        )
        context, blockers = _parity_context(malformed)
        self.assertIsNone(context)
        self.assertIn("named-net-population-mismatch", {item.code for item in blockers})

    def test_blocker_free_subset_emits_deterministic_typed_commands_that_replay_exactly(
        self,
    ) -> None:
        imported = _import(exact_stage=True)
        project_id = "exact-import-project"
        kernel = DesignKernel(DesignGraph(1, project_id))
        arguments = {
            "source_payload": _source(exact_stage=True),
            "project_id": project_id,
            "base_revision": kernel.head.revision_hash,
            "transaction_id": "transaction-import-exact",
            "actor": "trusted-import-boundary",
            "component_resolver": FixtureResolver(),
        }
        first = map_project_import(imported, **arguments)
        second = map_project_import(imported, **arguments)

        self.assertEqual(first.mapping_sha256, second.mapping_sha256)
        self.assertEqual(first.blockers, ())
        self.assertTrue(first.stage_eligible)
        self.assertIsNotNone(first.candidate)
        self.assertIsNotNone(first.transaction_input)
        assert first.candidate is not None and first.transaction_input is not None
        self.assertEqual(
            first.transaction_input.commands_sha256,
            second.transaction_input.commands_sha256,  # type: ignore[union-attr]
        )
        self.assertEqual(
            first.transaction_input.expected_empty_graph_sha256,
            kernel.head.graph.graph_hash,
        )
        kernel.begin_transaction(
            first.transaction_input.transaction_id,
            base_revision=kernel.head.revision_hash,
        )
        for command in first.transaction_input.commands:
            transaction = kernel.stage(command)
        self.assertEqual(transaction.staged_graph, first.candidate.graph)
        self.assertEqual(
            transaction.staged_graph.graph_hash,
            first.transaction_input.prospective_graph_sha256,
        )

        pad = next(
            item
            for item in first.candidate.graph.pads
            if item.component_id == "component-u1" and item.pad_number == "1"
        )
        self.assertEqual((pad.center.x, pad.center.y), (10_000_000, 9_000_000))
        self.assertEqual(first.candidate.graph.vias[0].drill_nm, 400_000)

        graph = first.candidate.graph
        for field_name in ("tracks", "vias", "zones"):
            collection = getattr(graph, field_name)
            self.assertTrue(collection, field_name)
            subject = collection[0]
            wrong_net_id = next(
                item.net_id for item in graph.nets if item.net_id != subject.net_id
            )
            forged_collection = (
                replace(subject, net_id=wrong_net_id),
                *collection[1:],
            )
            forged_graph = replace(graph, **{field_name: forged_collection}).normalized()
            with (
                self.subTest(forged_net_bearing_collection=field_name),
                self.assertRaises(ImportMappingInvariantError),
            ):
                replace(
                    first.candidate,
                    graph=forged_graph,
                    graph_sha256=forged_graph.graph_hash,
                )

    def test_multipad_slot_and_shared_land_payloads_replay_without_collapse(self) -> None:
        project_id = "multipad-import-project"
        exact_component = Component(
            "component-j1",
            "J1",
            "Exact connector",
            "CONNECTOR-EXACT",
            "receptacle",
            "Connector:Exact",
            "Connector:Exact",
            DATASHEET,
            PIN_MAP,
            (
                PinDefinition("A1", "VBUS-A", "power_in", "A1"),
                PinDefinition("B12", "VBUS-B", "power_in", "B12"),
                PinDefinition("S1", "SHIELD", "passive", "S1"),
            ),
        )
        graph = DesignGraph(
            1,
            project_id,
            components=(exact_component,),
            nets=(
                Net(
                    "net-common",
                    "COMMON",
                    (
                        PinRef("component-j1", "A1"),
                        PinRef("component-j1", "B12"),
                        PinRef("component-j1", "S1"),
                    ),
                ),
            ),
            placements=(FootprintPlacement("component-j1", PointNm(0, 0)),),
            pads=(
                FootprintPad(
                    "pad-shell-left",
                    "component-j1",
                    "S1",
                    PointNm(-2_000_000, 0),
                    1_200_000,
                    1_700_000,
                    "oval",
                    90_000_000,
                    ("F.Cu", "B.Cu"),
                    600_000,
                    "net-common",
                    drill_x_nm=600_000,
                    drill_y_nm=1_100_000,
                    drill_rotation_udeg=90_000_000,
                ),
                FootprintPad(
                    "pad-shell-right",
                    "component-j1",
                    "S1",
                    PointNm(2_000_000, 0),
                    1_200_000,
                    1_700_000,
                    "oval",
                    90_000_000,
                    ("F.Cu", "B.Cu"),
                    600_000,
                    "net-common",
                    drill_x_nm=600_000,
                    drill_y_nm=1_100_000,
                    drill_rotation_udeg=90_000_000,
                ),
                FootprintPad(
                    "pad-a1",
                    "component-j1",
                    "A1",
                    PointNm(0, -2_000_000),
                    1_000_000,
                    600_000,
                    "rect",
                    0,
                    ("F.Cu",),
                    net_id="net-common",
                    shared_land_group_id="land-vbus",
                ),
                FootprintPad(
                    "pad-b12",
                    "component-j1",
                    "B12",
                    PointNm(0, -2_000_000),
                    1_000_000,
                    600_000,
                    "rect",
                    0,
                    ("F.Cu",),
                    net_id="net-common",
                    shared_land_group_id="land-vbus",
                ),
            ),
            holes=(
                FootprintHole(
                    "hole-shell-left",
                    "component-j1",
                    PointNm(-2_000_000, 0),
                    600_000,
                    True,
                    "pad-shell-left",
                    drill_x_nm=600_000,
                    drill_y_nm=1_100_000,
                    drill_rotation_udeg=90_000_000,
                ),
                FootprintHole(
                    "hole-shell-right",
                    "component-j1",
                    PointNm(2_000_000, 0),
                    600_000,
                    True,
                    "pad-shell-right",
                    drill_x_nm=600_000,
                    drill_y_nm=1_100_000,
                    drill_rotation_udeg=90_000_000,
                ),
            ),
        ).normalized()
        payloads = _payloads_for_graph(graph)
        self.assertEqual(
            sum(kind is CommandKind.FOOTPRINT_PAD_GROUP_ADD for kind, _ in payloads),
            1,
        )
        self.assertEqual(
            sum(kind is CommandKind.FOOTPRINT_PAD_ADD for kind, _ in payloads),
            2,
        )

        kernel = DesignKernel(DesignGraph(1, project_id))
        base_revision = kernel.head.revision_hash
        kernel.begin_transaction("transaction-multipad", base_revision=base_revision)
        commands: list[DesignCommand] = []
        for ordinal, (kind, payload) in enumerate(payloads, start=1):
            command = DesignCommand.create(
                command_id=f"command-multipad-{ordinal}",
                base_revision=base_revision,
                transaction_id="transaction-multipad",
                actor="trusted-import-boundary",
                kind=kind,
                payload=payload,
                idempotency_key=f"multipad-{ordinal}",
            )
            commands.append(command)
            transaction = kernel.stage(command)
        self.assertEqual(transaction.staged_graph, graph)
        self.assertEqual(transaction.staged_graph.graph_hash, graph.graph_hash)
        self.assertEqual(
            tuple(pad.pad_id for pad in transaction.staged_graph.pads if pad.pad_number == "S1"),
            ("pad-shell-left", "pad-shell-right"),
        )
        group_command = next(
            command
            for command in commands
            if command.kind is CommandKind.FOOTPRINT_PAD_GROUP_ADD
        )
        self.assertIn('"shared_land_group_id":"land-vbus"', group_command.payload_json)

    def test_full_project_mapping_preserves_four_repeated_plated_slots(self) -> None:
        source_payload = _multipad_slot_source()
        imported = import_project_bundle(
            source_payload,
            unsupported_policy=UnsupportedPolicy.REJECT,
        )
        project_id = "multipad-slot-source-project"
        kernel = DesignKernel(DesignGraph(1, project_id))
        result = map_project_import(
            imported,
            source_payload=source_payload,
            project_id=project_id,
            base_revision=kernel.head.revision_hash,
            transaction_id="transaction-multipad-source",
            actor="trusted-import-boundary",
            component_resolver=FixtureResolver(),
        )
        self.assertEqual(result.blockers, ())
        self.assertIsNotNone(result.candidate)
        self.assertIsNotNone(result.transaction_input)
        assert result.candidate is not None
        assert result.transaction_input is not None
        shell_pads = tuple(
            pad
            for pad in result.candidate.graph.pads
            if pad.component_id == "component-j1" and pad.pad_number == "1"
        )
        self.assertEqual(len(shell_pads), 4)
        self.assertEqual(len({pad.pad_id for pad in shell_pads}), 4)
        gnd_net_id = next(
            net.net_id for net in result.candidate.graph.nets if net.name == "GND"
        )
        self.assertEqual({pad.net_id for pad in shell_pads}, {gnd_net_id})
        self.assertEqual(
            {
                (
                    pad.size_x_nm,
                    pad.size_y_nm,
                    pad.drill_x_nm,
                    pad.drill_y_nm,
                    pad.drill_rotation_udeg,
                )
                for pad in shell_pads
            },
            {(1_200_000, 1_700_000, 600_000, 1_100_000, 0)},
        )
        shell_holes = tuple(
            hole
            for hole in result.candidate.graph.holes
            if hole.pad_id in {pad.pad_id for pad in shell_pads}
        )
        self.assertEqual(len(shell_holes), 4)
        self.assertTrue(all(hole.plated and hole.drill_is_slot for hole in shell_holes))

        kernel.begin_transaction(
            result.transaction_input.transaction_id,
            base_revision=kernel.head.revision_hash,
        )
        for command in result.transaction_input.commands:
            transaction = kernel.stage(command)
        self.assertEqual(transaction.staged_graph, result.candidate.graph)

    def test_unresolved_or_source_unbound_provenance_returns_structured_blockers(self) -> None:
        imported = _import(exact_stage=True)
        kernel = DesignKernel(DesignGraph(1, "blocked-project"))
        common = {
            "source_payload": _source(exact_stage=True),
            "project_id": "blocked-project",
            "base_revision": kernel.head.revision_hash,
            "transaction_id": "transaction-blocked",
            "actor": "trusted-import-boundary",
        }
        unresolved = map_project_import(
            imported,
            component_resolver=UnresolvedResolver(),
            **common,
        )
        self.assertIsNone(unresolved.candidate)
        self.assertEqual(
            {item.code for item in unresolved.blockers},
            {"component-provenance-unresolved"},
        )

        unbound = map_project_import(
            imported,
            component_resolver=WrongRequestResolver(),
            **common,
        )
        self.assertIsNone(unbound.candidate)
        self.assertEqual(
            {item.code for item in unbound.blockers},
            {"component-provenance-parity-mismatch"},
        )

    def test_rechecks_reference_value_pin_pad_and_named_net_parity_independently(self) -> None:
        imported = _import(exact_stage=True)
        board = imported.bundle.board
        first_footprint = board.footprints[0]
        first_pad = first_footprint.pads[0]
        other_net = next(item.net_id for item in board.nets if item.net_id != first_pad.net_id)
        bad_footprint = replace(
            first_footprint,
            value="WRONG-VALUE",
            pads=(replace(first_pad, net_id=other_net), *first_footprint.pads[1:]),
        )
        second_footprint = board.footprints[1]
        bad_second_footprint = replace(
            second_footprint,
            library_id="Wrong:Footprint",
            pads=(),
        )
        bad_board = replace(
            board,
            footprints=(bad_footprint, bad_second_footprint, *board.footprints[2:]),
        )
        bad_bundle = replace(imported.bundle, board=bad_board)
        context, parity_blockers = _parity_context(_reseal(imported, bad_bundle))

        self.assertIsNone(context)
        codes = {item.code for item in parity_blockers}
        self.assertIn("value-parity-mismatch", codes)
        self.assertIn("footprint-parity-mismatch", codes)
        self.assertIn("pin-pad-population-mismatch", codes)
        self.assertIn("pin-pad-net-parity-mismatch", codes)

    def test_parity_checks_every_repeated_physical_pad_without_last_wins_collapse(self) -> None:
        imported = _import(exact_stage=True)
        board = imported.bundle.board
        footprint = board.footprints[0]
        source_pad = footprint.pads[0]
        repeated = replace(
            source_pad,
            pad_id="00000000-0000-4000-8000-00000000f111",
            position=replace(
                source_pad.position,
                y=source_pad.position.y + 2_000_000,
            ),
        )
        repeated_footprint = replace(
            footprint,
            pads=footprint.pads + (repeated,),
        )
        repeated_board = replace(
            board,
            footprints=(repeated_footprint, *board.footprints[1:]),
        )
        repeated_bundle = replace(imported.bundle, board=repeated_board)
        context, blockers = _parity_context(_reseal(imported, repeated_bundle))
        self.assertIsNotNone(context)
        self.assertNotIn(
            "pin-pad-net-parity-mismatch",
            {item.code for item in blockers},
        )

        other_net_id = next(
            net.net_id for net in board.nets if net.net_id != source_pad.net_id
        )
        mixed = replace(repeated, net_id=other_net_id)
        mixed_footprint = replace(
            footprint,
            pads=footprint.pads + (mixed,),
        )
        mixed_board = replace(
            board,
            footprints=(mixed_footprint, *board.footprints[1:]),
        )
        mixed_bundle = replace(imported.bundle, board=mixed_board)
        context, blockers = _parity_context(_reseal(imported, mixed_bundle))
        self.assertIsNone(context)
        self.assertIn(
            "pin-pad-net-parity-mismatch",
            {item.code for item in blockers},
        )

    def test_tampered_codec_evidence_and_unsupported_constructs_fail_before_resolution(
        self,
    ) -> None:
        imported = _import(exact_stage=True)
        tampered = ProjectImportResult(
            imported.bundle,
            replace(imported.evidence, bundle_ir_sha256="e" * 64),
        )
        result = self._mapping(
            tampered,
            source_payload=_source(exact_stage=True),
        )
        self.assertIsNone(result.candidate)
        self.assertIn("source-evidence-mismatch", {item.code for item in result.blockers})

        unsupported = self._mapping(
            _import(board_name="unsupported_zone.kicad_pcb"),
            source_payload=_source(board_name="unsupported_zone.kicad_pcb"),
        )
        self.assertIsNone(unsupported.candidate)
        self.assertIn(
            "unsupported-source-construct",
            {item.code for item in unsupported.blockers},
        )

    def test_unproven_target_base_can_be_previewed_but_never_emits_stage_input(self) -> None:
        result = map_project_import(
            _import(exact_stage=True),
            source_payload=_source(exact_stage=True),
            project_id="existing-project",
            base_revision="f" * 64,
            transaction_id="transaction-existing",
            actor="trusted-import-boundary",
            component_resolver=FixtureResolver(),
        )
        self.assertIsNotNone(result.candidate)
        self.assertIsNone(result.transaction_input)
        self.assertFalse(result.stage_eligible)
        self.assertIn(
            "target-base-not-proven-empty",
            {item.code for item in result.blockers},
        )

    def test_forged_raw_source_digests_fail_before_candidate_or_stage(self) -> None:
        imported = _import(exact_stage=True)
        forged = ProjectImportResult(
            imported.bundle,
            replace(
                imported.evidence,
                project_source_sha256="f" * 64,
                schematic_source_sha256="e" * 64,
                board_source_sha256="d" * 64,
            ),
        )
        result = self._mapping(
            forged,
            source_payload=_source(exact_stage=True),
        )
        self.assertIsNone(result.candidate)
        self.assertIsNone(result.transaction_input)
        self.assertFalse(result.stage_eligible)
        self.assertEqual(
            3,
            sum(
                item.code == "raw-source-digest-mismatch"
                for item in result.blockers
            ),
        )
        self.assertIn(
            "raw-source-evidence-mismatch",
            {item.code for item in result.blockers},
        )

    def test_truth_fields_cannot_be_upgraded_by_construction(self) -> None:
        result = self._mapping(
            _import(exact_stage=True),
            source_payload=_source(exact_stage=True),
        )
        self.assertIsNotNone(result.candidate)
        self.assertIsNotNone(result.transaction_input)
        assert result.candidate is not None
        assert result.transaction_input is not None
        with self.assertRaises(ImportMappingInvariantError):
            replace(result.candidate, kicad_execution="passed")
        with self.assertRaises(ImportMappingInvariantError):
            replace(result, manufacturing_release_eligible=True)
        with self.assertRaises(ImportMappingInvariantError):
            replace(result, source_bundle_ir_sha256="f" * 64)

        mixed_actor_commands = (
            replace(
                result.transaction_input.commands[0],
                actor="attacker-actor",
            ),
            *result.transaction_input.commands[1:],
        )
        with self.assertRaises(ImportMappingInvariantError):
            replace(
                result.transaction_input,
                commands=mixed_actor_commands,
                commands_sha256=stable_hash(
                    tuple(item.command_hash for item in mixed_actor_commands),
                    domain="flux-clone-canonical-import-commands-v1",
                ),
            )

        attacker_commands = tuple(
            replace(item, actor="attacker-actor")
            for item in result.transaction_input.commands
        )
        attacker_transaction = replace(
            result.transaction_input,
            authorized_actor="attacker-actor",
            commands=attacker_commands,
            commands_sha256=stable_hash(
                tuple(item.command_hash for item in attacker_commands),
                domain="flux-clone-canonical-import-commands-v1",
            ),
        )
        with self.assertRaises(ImportMappingInvariantError):
            replace(result, transaction_input=attacker_transaction)

        attacker_candidate = replace(
            result.candidate,
            authorized_actor="attacker-actor",
        )
        attacker_transaction = replace(
            attacker_transaction,
            candidate_sha256=attacker_candidate.candidate_sha256,
        )
        with self.assertRaises(ImportMappingInvariantError):
            replace(
                result,
                candidate=attacker_candidate,
                transaction_input=attacker_transaction,
            )

        binding = result.candidate.provenance_bindings[0]
        forged_request_digest = "f" * 64
        forged_hash_only_evidence = stable_hash(
            {
                "request_sha256": forged_request_digest,
                "evidence_id": binding.component_evidence_id,
                "resolver_id": binding.resolver_id,
                "trust_snapshot_sha256": binding.trust_snapshot_sha256,
                "component": next(
                    item
                    for item in result.candidate.graph.components
                    if item.component_id == binding.component_id
                ),
            },
            domain="flux-clone-trusted-component-resolution-v1",
        )
        with self.assertRaises(ImportMappingInvariantError):
            replace(
                binding,
                request_sha256=forged_request_digest,
                evidence_sha256=forged_hash_only_evidence,
            )

        forged_request = replace(
            binding.request,
            source_footprint_id="forged-source-footprint",
        )
        forged_request_sha256 = forged_request.request_sha256
        component = next(
            item
            for item in result.candidate.graph.components
            if item.component_id == binding.component_id
        )
        forged_evidence_sha256 = stable_hash(
            {
                "request_sha256": forged_request_sha256,
                "evidence_id": binding.component_evidence_id,
                "resolver_id": binding.resolver_id,
                "trust_snapshot_sha256": binding.trust_snapshot_sha256,
                "component": component,
            },
            domain="flux-clone-trusted-component-resolution-v1",
        )
        forged_binding = replace(
            binding,
            source_footprint_id=forged_request.source_footprint_id,
            request=forged_request,
            request_sha256=forged_request_sha256,
            evidence_sha256=forged_evidence_sha256,
        )
        forged_bindings = tuple(
            sorted(
                (
                    forged_binding,
                    *result.candidate.provenance_bindings[1:],
                ),
                key=lambda item: (
                    item.source_footprint_id,
                    item.component_evidence_id,
                    item.component_id,
                ),
            )
        )
        with self.assertRaises(ImportMappingInvariantError):
            replace(
                result.candidate,
                provenance_bindings=forged_bindings,
                provenance_set_sha256=stable_hash(
                    forged_bindings,
                    domain="flux-clone-component-provenance-set-v1",
                ),
            )

        forged_prospective = replace(
            result.transaction_input,
            prospective_graph_sha256="f" * 64,
        )
        with self.assertRaises(ImportMappingInvariantError):
            replace(result, transaction_input=forged_prospective)

        forged_commands = tuple(
            replace(command, base_revision="e" * 64)
            for command in result.transaction_input.commands
        )
        forged_base = replace(
            result.transaction_input,
            base_revision="e" * 64,
            commands=forged_commands,
            commands_sha256=stable_hash(
                tuple(command.command_hash for command in forged_commands),
                domain="flux-clone-canonical-import-commands-v1",
            ),
        )
        with self.assertRaises(ImportMappingInvariantError):
            replace(result, transaction_input=forged_base)


if __name__ == "__main__":
    unittest.main()
