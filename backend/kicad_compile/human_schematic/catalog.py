"""Closed real-symbol metadata catalog for human-schematic planning."""

from __future__ import annotations

import hashlib
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import cast

from backend.design_kernel import stable_hash

from .model import (
    GridEnvelope,
    GridPoint,
    HumanSchematicError,
    PinPort,
    SemanticComponent,
    SourceVerification,
    SymbolSource,
    SymbolTemplate,
)

SourcePayloadResolver = Callable[[SymbolSource], bytes]
SourcePayloadProvider = Mapping[str, bytes] | SourcePayloadResolver


def _ports(*ports: PinPort) -> tuple[PinPort, ...]:
    return tuple(sorted(ports, key=lambda item: item.logical_number))


def _port(
    logical_number: str,
    emitted_number: str,
    electrical_type: str,
    x: int,
    y: int,
    direction: str,
    *,
    canonical_name: str | None = None,
    canonical_electrical_type: str | None = None,
    canonical_pad_number: str | None = None,
    canonical_required: bool = True,
) -> PinPort:
    return PinPort(
        logical_number,
        emitted_number,
        electrical_type,
        logical_number if canonical_name is None else canonical_name,
        electrical_type if canonical_electrical_type is None else canonical_electrical_type,
        emitted_number if canonical_pad_number is None else canonical_pad_number,
        canonical_required,
        GridPoint(x, y),
        direction,
    )


def _source(
    source_id: str,
    authority: str,
    revision: str,
    path: str,
    byte_length: int,
    sha256: str,
) -> SymbolSource:
    return SymbolSource(source_id, authority, revision, path, byte_length, sha256)


@dataclass(frozen=True, slots=True)
class SymbolCatalog:
    """Immutable closed catalog; resolution never consults host libraries."""

    sources: tuple[SymbolSource, ...]
    templates: tuple[SymbolTemplate, ...]

    def __post_init__(self) -> None:
        if type(self.sources) is not tuple or any(
            type(item) is not SymbolSource for item in self.sources
        ):
            raise TypeError("symbol catalog sources must be an exact immutable tuple")
        if type(self.templates) is not tuple or any(
            type(item) is not SymbolTemplate for item in self.templates
        ):
            raise TypeError("symbol catalog templates must be an exact immutable tuple")
        if self.sources != tuple(sorted(self.sources, key=lambda item: item.source_id)):
            raise ValueError("symbol catalog sources must be sorted by source ID")
        if self.templates != tuple(sorted(self.templates, key=lambda item: item.profile_id)):
            raise ValueError("symbol catalog templates must be sorted by profile ID")
        source_ids = tuple(item.source_id for item in self.sources)
        profile_ids = tuple(item.profile_id for item in self.templates)
        graph_symbol_ids = tuple(item.graph_symbol_id for item in self.templates)
        if len(source_ids) != len(set(source_ids)):
            raise ValueError("symbol catalog source IDs must be unique")
        if len(profile_ids) != len(set(profile_ids)):
            raise ValueError("symbol catalog profile IDs must be unique")
        if len(graph_symbol_ids) != len(set(graph_symbol_ids)):
            raise ValueError("symbol catalog graph symbol IDs must be unambiguous")
        source_set = set(source_ids)
        if any(
            source_id not in source_set
            for template in self.templates
            for source_id in template.source_ids
        ):
            raise ValueError("symbol catalog template references an unknown source")

    @property
    def catalog_digest(self) -> str:
        return stable_hash(self, domain="flux-clone-human-symbol-catalog-v1")

    def resolve(self, component: SemanticComponent) -> SymbolTemplate:
        """Resolve one exact profile or fail before any geometry is produced."""

        if type(component) is not SemanticComponent:
            raise TypeError("symbol resolution requires an exact SemanticComponent")
        matches = tuple(
            item for item in self.templates if item.graph_symbol_id == component.symbol_id
        )
        if len(matches) != 1:
            raise HumanSchematicError(
                "human-symbol-template-required",
                component.symbol_id.replace(" ", "_"),
                "the graph symbol has no single reviewed flattened real-symbol profile",
            )
        template = matches[0]
        expected_pins = tuple(item.canonical_definition for item in template.pin_ports)
        if expected_pins != component.pin_definitions:
            raise HumanSchematicError(
                "human-symbol-pin-profile-mismatch",
                component.component_id,
                "catalog canonical pin definitions do not equal the exact graph definitions",
            )
        return template

    def verify_sources(
        self,
        provider: SourcePayloadProvider,
        source_ids: frozenset[str] | None = None,
    ) -> tuple[SourceVerification, ...]:
        """Resolve and verify exact retained bytes without owning any I/O policy."""

        requested = (
            frozenset(item.source_id for item in self.sources) if source_ids is None else source_ids
        )
        known = {item.source_id for item in self.sources}
        if not requested or not requested.issubset(known):
            raise HumanSchematicError(
                "human-symbol-source-inventory-mismatch",
                "symbol-catalog",
                "requested source IDs must be a non-empty subset of the closed catalog",
            )
        mapping_provider = (
            cast(Mapping[str, bytes], provider) if isinstance(provider, Mapping) else None
        )
        resolver = None if mapping_provider is not None else cast(SourcePayloadResolver, provider)
        if mapping_provider is not None and set(mapping_provider) != set(requested):
            raise HumanSchematicError(
                "human-symbol-source-inventory-mismatch",
                "symbol-catalog",
                "provided payload keys must exactly equal the requested source inventory",
            )
        verified: list[SourceVerification] = []
        for source in self.sources:
            if source.source_id not in requested:
                continue
            try:
                payload: bytes = (
                    mapping_provider[source.source_id]
                    if mapping_provider is not None
                    else cast(SourcePayloadResolver, resolver)(source)
                )
            except Exception as exc:
                raise HumanSchematicError(
                    "human-symbol-source-unavailable",
                    source.source_id,
                    "the explicit source payload resolver did not return retained bytes",
                ) from exc
            if type(payload) is not bytes:
                raise TypeError("retained symbol source payloads must be exact bytes")
            if (
                len(payload) != source.byte_length
                or hashlib.sha256(payload).hexdigest() != source.sha256
            ):
                raise HumanSchematicError(
                    "human-symbol-source-digest-mismatch",
                    source.source_id,
                    "retained symbol source bytes differ from the reviewed source lock",
                )
            verified.append(SourceVerification(source.source_id, len(payload), source.sha256))
        return tuple(verified)

    def verify_source_payloads(
        self, payloads: Mapping[str, bytes]
    ) -> tuple[SourceVerification, ...]:
        """Compatibility wrapper for an exact complete in-memory inventory."""

        return self.verify_sources(payloads)


def _sources() -> tuple[SymbolSource, ...]:
    """Return exact retained KiCad 10.0.6 and derivation payload receipts."""

    return tuple(
        sorted(
            (
                _source(
                    "kicad-connector-testpoint-10.0.6",
                    "KiCad official symbol libraries",
                    "10.0.6",
                    "sources/testpoint.kicad_sym",
                    1_916,
                    "a99c9351636573fc092533783dd8d96ec4e763536b9612e83b9bcf6c7d4e23dc",
                ),
                _source(
                    "kicad-connector-usb-c-16p-10.0.6",
                    "KiCad official symbol libraries",
                    "10.0.6",
                    "sources/usb_c_receptacle_usb2_16p.kicad_sym",
                    10_388,
                    "e026d8b633e89570cb4de8f6342394c9cbbbc7ab5b7b6b218cc7b68c88f03625",
                ),
                _source(
                    "kicad-connector-generic-01x02-10.0.6",
                    "KiCad official symbol libraries",
                    "10.0.6",
                    "sources/conn_01x02.kicad_sym",
                    2_520,
                    "9eda143630d53c838cd2bffd987976e2293465617927e8b4c3c941a4791c2909",
                ),
                _source(
                    "kicad-device-c-10.0.6",
                    "KiCad official symbol libraries",
                    "10.0.6",
                    "sources/c.kicad_sym",
                    2_348,
                    "0969cf789adca14aaa0f31d08daa24c2e925fa41e83e2b2e8f5df968251e5ccd",
                ),
                _source(
                    "kicad-device-c-polarized-10.0.6",
                    "KiCad official symbol libraries",
                    "10.0.6",
                    "sources/c_polarized.kicad_sym",
                    2_686,
                    "5720a87a39ff00595d703abccb0ff62da1d3934b261e24f73bc8f43cf4988b99",
                ),
                _source(
                    "kicad-device-d-tvs-10.0.6",
                    "KiCad official symbol libraries",
                    "10.0.6",
                    "sources/d_tvs.kicad_sym",
                    2_606,
                    "ca4f4676392606ebd67b27ac6435c872b6ccb692de7c973f621b5427f3170bc1",
                ),
                _source(
                    "kicad-device-led-10.0.6",
                    "KiCad official symbol libraries",
                    "10.0.6",
                    "sources/led.kicad_sym",
                    3_099,
                    "87b5a650203e50e1d99b8b56ed59d2774fd0091ac0fba90da28782f34fea54a0",
                ),
                _source(
                    "kicad-device-r-10.0.6",
                    "KiCad official symbol libraries",
                    "10.0.6",
                    "sources/r.kicad_sym",
                    2_107,
                    "3a07e3319b4023f325e84c09a4089f0d86b5f93263dff7ea8fd74a56b0540cc3",
                ),
                _source(
                    "kicad-power-management-tps2596xx-10.0.6",
                    "KiCad official symbol libraries",
                    "10.0.6",
                    "sources/tps2596xx.kicad_sym",
                    4_014,
                    "e6283fc59bdbdd720f87d8d9542cb1cd239f0302cbd7dff2211dd1ad593d3bed",
                ),
                _source(
                    "lp38692-pinout-derivation-receipt",
                    "Flux reviewed derivation from Texas Instruments",
                    "R2 retained derivation receipt v1",
                    "sources/lp38692_pinout.receipt.json",
                    890,
                    "54dc2368dc4a31263590504ddb07e7e2656fca2874a61d486669f0b9bf283309",
                ),
            ),
            key=lambda item: item.source_id,
        )
    )


def _templates() -> tuple[SymbolTemplate, ...]:
    passive_vertical = _ports(
        _port("1", "1", "passive", 0, -3, "north"),
        _port("2", "2", "passive", 0, 3, "south"),
    )
    tvs_vertical = _ports(
        _port("1", "1", "passive", 0, -3, "north", canonical_name="K"),
        _port("2", "2", "passive", 0, 3, "south", canonical_name="A"),
    )
    return tuple(
        sorted(
            (
                SymbolTemplate(
                    "connector-testpoint",
                    "Connector:TestPoint",
                    "FluxHuman:TestPoint",
                    "flattened from the exact official KiCad TestPoint symbol",
                    GridEnvelope(GridPoint(-2, -4), GridPoint(2, -1)),
                    _ports(
                        _port(
                            "1",
                            "1",
                            "passive",
                            0,
                            0,
                            "south",
                            canonical_name="TEST",
                        )
                    ),
                    ("kicad-connector-testpoint-10.0.6",),
                ),
                SymbolTemplate(
                    "connector-usb4105-gf-a",
                    "Connector_Generic:USB_C_Receptacle_USB2.0_16P",
                    "FluxHuman:USB4105_GF_A",
                    "official USB-C 16P graphics flattened; shell SH renamed to logical S1",
                    GridEnvelope(GridPoint(-8, -16), GridPoint(8, 14)),
                    _ports(
                        _port("A1", "A1", "passive", 0, -18, "north", canonical_name="GND"),
                        _port(
                            "A4",
                            "A4",
                            "passive",
                            12,
                            12,
                            "east",
                            canonical_name="VBUS",
                            canonical_electrical_type="power_out",
                        ),
                        _port(
                            "A5",
                            "A5",
                            "bidirectional",
                            12,
                            8,
                            "east",
                            canonical_name="CC1",
                            canonical_electrical_type="passive",
                        ),
                        _port(
                            "A6",
                            "A6",
                            "bidirectional",
                            12,
                            -2,
                            "east",
                            canonical_name="D+",
                            canonical_electrical_type="no_connect",
                            canonical_required=False,
                        ),
                        _port(
                            "A7",
                            "A7",
                            "bidirectional",
                            12,
                            2,
                            "east",
                            canonical_name="D-",
                            canonical_electrical_type="no_connect",
                            canonical_required=False,
                        ),
                        _port(
                            "A8",
                            "A8",
                            "bidirectional",
                            12,
                            -10,
                            "east",
                            canonical_name="SBU1",
                            canonical_electrical_type="no_connect",
                            canonical_required=False,
                        ),
                        _port("A9", "A9", "passive", 12, 12, "east", canonical_name="VBUS"),
                        _port("A12", "A12", "passive", 0, -18, "north", canonical_name="GND"),
                        _port("B1", "B1", "passive", 0, -18, "north", canonical_name="GND"),
                        _port("B4", "B4", "passive", 12, 12, "east", canonical_name="VBUS"),
                        _port(
                            "B5",
                            "B5",
                            "bidirectional",
                            12,
                            6,
                            "east",
                            canonical_name="CC2",
                            canonical_electrical_type="passive",
                        ),
                        _port(
                            "B6",
                            "B6",
                            "bidirectional",
                            12,
                            -4,
                            "east",
                            canonical_name="D+",
                            canonical_electrical_type="no_connect",
                            canonical_required=False,
                        ),
                        _port(
                            "B7",
                            "B7",
                            "bidirectional",
                            12,
                            0,
                            "east",
                            canonical_name="D-",
                            canonical_electrical_type="no_connect",
                            canonical_required=False,
                        ),
                        _port(
                            "B8",
                            "B8",
                            "bidirectional",
                            12,
                            -12,
                            "east",
                            canonical_name="SBU2",
                            canonical_electrical_type="no_connect",
                            canonical_required=False,
                        ),
                        _port("B9", "B9", "passive", 12, 12, "east", canonical_name="VBUS"),
                        _port("B12", "B12", "passive", 0, -18, "north", canonical_name="GND"),
                        _port("S1", "S1", "passive", -6, -18, "north", canonical_name="SHIELD"),
                    ),
                    ("kicad-connector-usb-c-16p-10.0.6",),
                ),
                SymbolTemplate(
                    "connector-01x02",
                    "Connector_Generic:Conn_01x02",
                    "FluxHuman:Conn_01x02",
                    "flattened from the exact official KiCad one-by-two connector",
                    GridEnvelope(GridPoint(-3, -3), GridPoint(3, 3)),
                    _ports(
                        _port("1", "1", "passive", -4, 1, "west", canonical_name="3V3"),
                        _port("2", "2", "passive", -4, -1, "west", canonical_name="GND"),
                    ),
                    ("kicad-connector-generic-01x02-10.0.6",),
                ),
                SymbolTemplate(
                    "device-c",
                    "Device:C",
                    "FluxHuman:C",
                    "flattened from the exact official KiCad non-polarized capacitor",
                    GridEnvelope(GridPoint(-2, -1), GridPoint(2, 1)),
                    passive_vertical,
                    ("kicad-device-c-10.0.6",),
                ),
                SymbolTemplate(
                    "device-c-polarized-t598",
                    "Device:C_Polarized",
                    "FluxHuman:C_Polarized_T598",
                    "official polarized-capacitor graphics flattened with T598 polarity evidence",
                    GridEnvelope(GridPoint(-2, -1), GridPoint(2, 1)),
                    passive_vertical,
                    ("kicad-device-c-polarized-10.0.6",),
                ),
                SymbolTemplate(
                    "device-d-tvs",
                    "Device:D_TVS",
                    "FluxHuman:D_TVS",
                    "exact official TVS graphics flattened into the vertical branch orientation",
                    GridEnvelope(GridPoint(-2, -1), GridPoint(2, 1)),
                    tvs_vertical,
                    ("kicad-device-d-tvs-10.0.6",),
                ),
                SymbolTemplate(
                    "device-led",
                    "Device:LED",
                    "FluxHuman:LED",
                    "flattened from the exact official KiCad LED symbol",
                    GridEnvelope(GridPoint(-1, -2), GridPoint(1, 2)),
                    _ports(
                        _port("1", "1", "passive", 3, 0, "east", canonical_name="K"),
                        _port("2", "2", "passive", -3, 0, "west", canonical_name="A"),
                    ),
                    ("kicad-device-led-10.0.6",),
                ),
                SymbolTemplate(
                    "device-r",
                    "Device:R",
                    "FluxHuman:R",
                    "flattened from the exact official KiCad resistor symbol",
                    GridEnvelope(GridPoint(-2, -1), GridPoint(2, 1)),
                    passive_vertical,
                    ("kicad-device-r-10.0.6",),
                ),
                SymbolTemplate(
                    "regulator-lp38692mpx-3v3",
                    "Regulator_Linear:LP38692",
                    "FluxHuman:LP38692MPX_3V3",
                    "self-contained functional symbol derived from the exact TI NDC "
                    "five-pin pinout",
                    GridEnvelope(GridPoint(-6, -8), GridPoint(6, 4)),
                    _ports(
                        _port("1", "1", "input", -8, 2, "west", canonical_name="EN"),
                        _port(
                            "2",
                            "2",
                            "no_connect",
                            8,
                            0,
                            "east",
                            canonical_name="NC",
                            canonical_required=False,
                        ),
                        _port("3", "3", "power_out", 8, 6, "east", canonical_name="OUT"),
                        _port("4", "4", "power_in", -8, 6, "west", canonical_name="IN"),
                        _port(
                            "5",
                            "5",
                            "power_in",
                            0,
                            -10,
                            "north",
                            canonical_name="GND/TAB",
                            canonical_electrical_type="passive",
                        ),
                    ),
                    ("lp38692-pinout-derivation-receipt",),
                ),
                SymbolTemplate(
                    "power-management-tps259620ddar",
                    "Power_Management:TPS259620",
                    "FluxHuman:TPS259620DDAR",
                    "official TPS2596xx functional graphics flattened; logical EP maps to pin 9",
                    GridEnvelope(GridPoint(-6, -8), GridPoint(6, 4)),
                    _ports(
                        _port(
                            "1",
                            "1",
                            "power_in",
                            0,
                            -10,
                            "north",
                            canonical_name="GND",
                            canonical_electrical_type="passive",
                        ),
                        _port("2", "2", "passive", -8, -6, "west", canonical_name="dVdt"),
                        _port("3", "3", "input", -8, 2, "west", canonical_name="EN/UVLO"),
                        _port("4", "4", "power_in", -8, 6, "west", canonical_name="IN"),
                        _port("5", "5", "power_out", 8, 6, "east", canonical_name="OUT"),
                        _port(
                            "6",
                            "6",
                            "open_collector",
                            8,
                            2,
                            "east",
                            canonical_name="FLT",
                            canonical_electrical_type="no_connect",
                            canonical_required=False,
                        ),
                        _port(
                            "7",
                            "7",
                            "output",
                            8,
                            -6,
                            "east",
                            canonical_name="ILM",
                            canonical_electrical_type="passive",
                        ),
                        _port(
                            "8",
                            "8",
                            "input",
                            -8,
                            -2,
                            "west",
                            canonical_name="OVCSEL",
                            canonical_electrical_type="passive",
                        ),
                        _port("EP", "9", "passive", 0, -10, "north", canonical_name="EXPOSED_PAD"),
                    ),
                    ("kicad-power-management-tps2596xx-10.0.6",),
                ),
            ),
            key=lambda item: item.profile_id,
        )
    )


def default_symbol_catalog() -> SymbolCatalog:
    """Return a fresh immutable catalog covering the exact R2 symbol population."""

    return SymbolCatalog(_sources(), _templates())


__all__ = (
    "SourcePayloadProvider",
    "SourcePayloadResolver",
    "SymbolCatalog",
    "default_symbol_catalog",
)
