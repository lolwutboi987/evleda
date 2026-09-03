"""Fail-closed KiCad 10 package-3D catalog for the fitted reference board.

This module is deliberately a catalog, not compiler integration.  In
particular, an unavailable body is represented here but never resolved to a
nearby package model.  This keeps an assembly render from asserting geometry
that the evidence does not support.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from hashlib import sha256
from math import isfinite
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import Final

from .specification import components

KICAD10_3DMODEL_DIR: Final = "KICAD10_3DMODEL_DIR"
KICAD_PACKAGES3D_REPOSITORY: Final = "kicad/libraries/kicad-packages3d"
KICAD_PACKAGES3D_SNAPSHOT: Final = "e62ed1fc7862da83f789bd562671b5e4b82afcdf"
KICAD_PACKAGES3D_LICENSE: Final = "CC BY-SA 4.0 with KiCad design-file exception"
KICAD_PACKAGES3D_LICENSE_URL: Final = (
    "https://gitlab.com/kicad/libraries/kicad-packages3d/-/blob/"
    "a675312deeb94a0f41a734c95b39749692d68b46/LICENSE.md"
)


class Model3DError(ValueError):
    """Raised when a model path or transform violates the catalog policy."""


class ModelConfidence(StrEnum):
    """What the recorded body can truthfully claim to represent."""

    EXACT_COMPONENT = "exact_component"
    PACKAGE_SPECIFIC_CASE = "package_specific_case"
    PACKAGE_CLASS = "package_class"
    UNAVAILABLE = "unavailable"


class ModelStatus(StrEnum):
    """Result of a model lookup against a particular KiCad installation."""

    AVAILABLE = "available"
    UNAVAILABLE = "unavailable"
    MISSING_ROOT = "missing_root"
    MISSING_FILE = "missing_file"
    UNSAFE_PATH = "unsafe_path"
    DIGEST_MISMATCH = "digest_mismatch"


@dataclass(frozen=True, slots=True)
class ModelTransform:
    """The explicit KiCad package-model transform, in KiCad units."""

    offset_mm: tuple[float, float, float] = (0.0, 0.0, 0.0)
    scale: tuple[float, float, float] = (1.0, 1.0, 1.0)
    rotate_deg: tuple[float, float, float] = (0.0, 0.0, 0.0)

    def __post_init__(self) -> None:
        vectors = (self.offset_mm, self.scale, self.rotate_deg)
        if any(
            len(vector) != 3 or not all(isfinite(value) for value in vector) for vector in vectors
        ):
            raise Model3DError("3D model transforms must contain three finite values")
        if any(value <= 0.0 for value in self.scale):
            raise Model3DError("3D model scale must be strictly positive")


IDENTITY_TRANSFORM: Final = ModelTransform()


@dataclass(frozen=True, slots=True)
class Model3DBinding:
    """Evidence-bound model policy for one exact fitted component ID."""

    component_id: str
    reference: str
    footprint_id: str
    source_sha256: str
    confidence: ModelConfidence
    model_relative_path: str | None
    model_sha256: str | None
    transform: ModelTransform = IDENTITY_TRANSFORM
    reason: str | None = None
    repository: str = KICAD_PACKAGES3D_REPOSITORY
    snapshot: str = KICAD_PACKAGES3D_SNAPSHOT
    license: str = KICAD_PACKAGES3D_LICENSE
    license_url: str = KICAD_PACKAGES3D_LICENSE_URL

    def __post_init__(self) -> None:
        _validate_sha256(self.source_sha256, "source_sha256")
        if self.confidence is ModelConfidence.UNAVAILABLE:
            if self.model_sha256 is not None:
                raise Model3DError("unavailable 3D model bindings must not carry a model digest")
            if not self.reason:
                raise Model3DError("unavailable 3D model bindings require a reason")
        elif self.model_relative_path is None or self.model_sha256 is None:
            raise Model3DError("renderable 3D model bindings require an exact path and digest")
        if self.model_sha256 is not None:
            _validate_sha256(self.model_sha256, "model_sha256")
        if self.model_relative_path is not None:
            _validate_relative_model_path(self.model_relative_path)

    @property
    def kicad_reference(self) -> str | None:
        """A portable KiCad variable reference, only when it is safe to emit."""

        if self.confidence is ModelConfidence.UNAVAILABLE or self.model_relative_path is None:
            return None
        return "${" + KICAD10_3DMODEL_DIR + "}/" + self.model_relative_path


@dataclass(frozen=True, slots=True)
class ResolvedModel3D:
    """A lookup receipt; non-available results intentionally have no path."""

    binding: Model3DBinding
    status: ModelStatus
    path: Path | None
    diagnostic: str | None

    @property
    def kicad_reference(self) -> str | None:
        """Return the path-independent reference only for a verified model."""

        return self.binding.kicad_reference if self.status is ModelStatus.AVAILABLE else None


def _validate_sha256(value: str, name: str) -> None:
    if len(value) != 64 or any(character not in "0123456789abcdef" for character in value):
        raise Model3DError(f"{name} must be a lowercase SHA-256 digest")


def _validate_relative_model_path(value: str) -> None:
    path = PurePosixPath(value)
    if (
        not value
        or "\\" in value
        or path.is_absolute()
        or ".." in path.parts
        or path.suffix.lower() not in {".step", ".wrl"}
    ):
        raise Model3DError("3D model path must be a traversal-free relative STEP or WRL path")


def _binding(
    component_id: str,
    confidence: ModelConfidence,
    model_relative_path: str | None,
    model_sha256: str | None,
    reason: str | None = None,
) -> Model3DBinding:
    component = _COMPONENTS_BY_ID[component_id]
    return Model3DBinding(
        component_id=component.component_id,
        reference=component.reference,
        footprint_id=component.footprint_id,
        source_sha256=component.datasheet_sha256,
        confidence=confidence,
        model_relative_path=model_relative_path,
        model_sha256=model_sha256,
        reason=reason,
    )


_COMPONENTS_BY_ID: Final = MappingProxyType(
    {component.component_id: component for component in components()}
)

# These are the exact KiCad 10.0.6 installed package3D file digests recorded by
# work/official_3d_model_map.  A digest mismatch is deliberately not tolerated.
_CATALOG_ENTRIES: Final = (
    _binding(
        "usb-j1",
        ModelConfidence.EXACT_COMPONENT,
        "Connector_USB.3dshapes/USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal.step",
        "6338ce740fa231c2d3dcc6384e0576994a47240a312a21413cb85d76990a69a0",
    ),
    _binding(
        "efuse-u1",
        ModelConfidence.PACKAGE_SPECIFIC_CASE,
        "Package_SO.3dshapes/HTSOP-8-1EP_3.9x4.9mm_P1.27mm.step",
        "801dd3a2b815a7eb830be234b2f0a2c87fadd58bb8db7b1f2d50f17e9dcaf732",
        "Reviewed filename migration from the missing Pitch1.27 path to the P1.27 "
        "KiCad 10 snapshot file. The retained TI source bounds TPS259620DDAR to the "
        "DDA 8-pin SO PowerPAD case; this package-case model does not establish exact "
        "component marking.",
    ),
    _binding(
        "ldo-u2",
        ModelConfidence.UNAVAILABLE,
        None,
        None,
        "LP38692 is NDC/SOT-223 5-pin; neither SOT-223 nor SOT-223-8 is a safe substitute.",
    ),
    _binding(
        "tvs-d1",
        ModelConfidence.UNAVAILABLE,
        None,
        None,
        "No exact official model is accepted for the PTVS5V5Z1UPC DFN1610-2 body.",
    ),
    *(
        _binding(
            component_id,
            ModelConfidence.PACKAGE_CLASS,
            "Resistor_SMD.3dshapes/R_0603_1608Metric.step",
            "1875571c326d0d9e96f36b4efeb8094068ef7619f0a449c781caf0b49c2e5861",
        )
        for component_id in (
            "cc-r1",
            "cc-r2",
            "ilim-r3",
            "ovc-r4",
            "ovc-r5",
            "en-hi-r6",
            "en-lo-r7",
            "led-r8",
        )
    ),
    _binding(
        "cout-esr-r9",
        ModelConfidence.UNAVAILABLE,
        None,
        None,
        "The generic R0603 body does not establish WSLP0603 terminations, marking, "
        "or thermal geometry.",
    ),
    *(
        _binding(
            component_id,
            ModelConfidence.PACKAGE_CLASS,
            "Capacitor_SMD.3dshapes/C_0805_2012Metric.step",
            "9a669c1a2f1ea25b88b401acef6efeaa80a067bd7da9db6993de719a7fbe155c",
        )
        for component_id in ("cin-c1", "cldo-c2")
    ),
    _binding(
        "cout-c3",
        ModelConfidence.PACKAGE_SPECIFIC_CASE,
        "Capacitor_Tantalum_SMD.3dshapes/CP_EIA-3528-21_Kemet-B.step",
        "dfe18bc321e2772dd597027a289d8e13b7b6f0320cfdd8f41c4492bdfe9f7f0c",
    ),
    _binding(
        "dvdt-c4",
        ModelConfidence.PACKAGE_CLASS,
        "Capacitor_SMD.3dshapes/C_1206_3216Metric.step",
        "11e948c72c90e2b6322436b72745f40ff4e8ba0da64fb2a0df943dfa61e89c1a",
    ),
    _binding(
        "led-d2",
        ModelConfidence.PACKAGE_CLASS,
        "LED_SMD.3dshapes/LED_0603_1608Metric.step",
        "98343205ec260ec165026ba2d44329a23096779ac36c553ea84aa7b370242e6d",
    ),
    _binding(
        "out-j2",
        ModelConfidence.PACKAGE_CLASS,
        "Connector_PinHeader_2.54mm.3dshapes/PinHeader_1x02_P2.54mm_Vertical.step",
        "ea4d0799007ebdd3945072bf255d673d2fe87eb05fda85fd8d7993ad9397da41",
    ),
    *(
        _binding(
            component_id,
            ModelConfidence.UNAVAILABLE,
            None,
            None,
            "The exact Keystone 5015 model is absent; Keystone 5005-5009 is not a substitute.",
        )
        for component_id in ("tp-1", "tp-2", "tp-3", "tp-4")
    ),
)

MODEL3D_BY_COMPONENT_ID: Final[Mapping[str, Model3DBinding]] = MappingProxyType(
    {entry.component_id: entry for entry in _CATALOG_ENTRIES}
)
MODEL3D_BY_REFERENCE: Final[Mapping[str, Model3DBinding]] = MappingProxyType(
    {entry.reference: entry for entry in _CATALOG_ENTRIES}
)

if len(MODEL3D_BY_COMPONENT_ID) != len(_COMPONENTS_BY_ID) or set(MODEL3D_BY_COMPONENT_ID) != set(
    _COMPONENTS_BY_ID
):
    raise RuntimeError("3D model catalog must cover every exact fitted component ID")
if len(MODEL3D_BY_REFERENCE) != len(_CATALOG_ENTRIES):
    raise RuntimeError("3D model catalog references must be unique")


def catalog() -> tuple[Model3DBinding, ...]:
    """Return all catalog entries in the source BOM's deterministic order."""

    return _CATALOG_ENTRIES


def model_for_component_id(component_id: str) -> Model3DBinding:
    """Return a binding only for an exact fitted component ID."""

    try:
        return MODEL3D_BY_COMPONENT_ID[component_id]
    except KeyError as exc:
        raise KeyError(f"unknown reference-board component ID: {component_id}") from exc


def model_for_reference(reference: str) -> Model3DBinding:
    """Return a binding only for an exact fitted reference designator."""

    try:
        return MODEL3D_BY_REFERENCE[reference]
    except KeyError as exc:
        raise KeyError(f"unknown reference-board reference: {reference}") from exc


def model_root_from_environment(environ: Mapping[str, str] | None = None) -> Path:
    """Read the sole approved KiCad package-model root variable.

    The catalog never embeds a machine-specific install path.  Callers may
    resolve the returned path on their own host, but only model digests in this
    catalog establish whether the result is trusted.
    """

    value = (os.environ if environ is None else environ).get(KICAD10_3DMODEL_DIR)
    if value is None or not value.strip():
        raise Model3DError(f"{KICAD10_3DMODEL_DIR} is required")
    root = Path(value)
    if not root.is_absolute():
        raise Model3DError(f"{KICAD10_3DMODEL_DIR} must be an absolute path")
    return root


def resolve_model(binding: Model3DBinding, model_root: Path) -> ResolvedModel3D:
    """Verify one exact model file beneath ``model_root`` without fallbacks."""

    if binding.confidence is ModelConfidence.UNAVAILABLE:
        return ResolvedModel3D(binding, ModelStatus.UNAVAILABLE, None, binding.reason)
    if binding.model_relative_path is None or binding.model_sha256 is None:
        raise Model3DError("renderable binding is incomplete")
    try:
        root = model_root.resolve(strict=True)
    except OSError:
        return ResolvedModel3D(binding, ModelStatus.MISSING_ROOT, None, "model root is unavailable")
    if not root.is_dir():
        return ResolvedModel3D(
            binding, ModelStatus.MISSING_ROOT, None, "model root is not a directory"
        )
    relative = PurePosixPath(binding.model_relative_path)
    candidate = root.joinpath(*relative.parts)
    try:
        resolved = candidate.resolve(strict=True)
    except OSError:
        return ResolvedModel3D(
            binding, ModelStatus.MISSING_FILE, None, "declared model file is absent"
        )
    if not resolved.is_relative_to(root) or not resolved.is_file():
        return ResolvedModel3D(
            binding,
            ModelStatus.UNSAFE_PATH,
            None,
            "declared model path escapes the approved model root or is not a regular file",
        )
    digest = sha256(resolved.read_bytes()).hexdigest()
    if digest != binding.model_sha256:
        return ResolvedModel3D(
            binding,
            ModelStatus.DIGEST_MISMATCH,
            None,
            "declared model digest does not match the approved KiCad 10 snapshot",
        )
    return ResolvedModel3D(binding, ModelStatus.AVAILABLE, resolved, None)


def resolve_from_environment(
    component_id: str, environ: Mapping[str, str] | None = None
) -> ResolvedModel3D:
    """Resolve an exact component binding through ``KICAD10_3DMODEL_DIR``."""

    return resolve_model(model_for_component_id(component_id), model_root_from_environment(environ))


__all__ = (
    "IDENTITY_TRANSFORM",
    "KICAD10_3DMODEL_DIR",
    "KICAD_PACKAGES3D_LICENSE",
    "KICAD_PACKAGES3D_LICENSE_URL",
    "KICAD_PACKAGES3D_REPOSITORY",
    "KICAD_PACKAGES3D_SNAPSHOT",
    "MODEL3D_BY_COMPONENT_ID",
    "MODEL3D_BY_REFERENCE",
    "Model3DBinding",
    "Model3DError",
    "ModelConfidence",
    "ModelStatus",
    "ModelTransform",
    "ResolvedModel3D",
    "catalog",
    "model_for_component_id",
    "model_for_reference",
    "model_root_from_environment",
    "resolve_from_environment",
    "resolve_model",
)
