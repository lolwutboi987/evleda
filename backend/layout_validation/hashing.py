"""Schema-specific hash helpers for candidate and replay sealing."""

from __future__ import annotations

import hashlib
from dataclasses import replace

from .canonical import stable_hash
from .model import (
    CandidateManifest,
    ReplayRecord,
    TrustedValidationAttestation,
    ValidationContract,
)


def contract_hash(contract: ValidationContract) -> str:
    return stable_hash(contract, domain="layout-validation/contract/v1")


def manifest_hash(manifest: CandidateManifest) -> str:
    return stable_hash(
        replace(manifest, manifest_hash=""),
        domain="layout-validation/candidate-manifest/v1",
    )


def replay_hash(replay: ReplayRecord) -> str:
    return stable_hash(
        replace(replay, replay_hash=""),
        domain="layout-validation/replay-record/v1",
    )


def candidate_artifact_hash(artifact: bytes) -> str:
    """Hash exact canonical candidate bytes at the validator trust boundary."""

    if type(artifact) is not bytes or not artifact:
        raise ValueError("candidate artifact must be non-empty exact bytes")
    digest = hashlib.sha256()
    digest.update(b"layout-validation/candidate-artifact/v1\x00")
    digest.update(artifact)
    return digest.hexdigest()


def attestation_hash(attestation: TrustedValidationAttestation) -> str:
    return stable_hash(attestation, domain="layout-validation/trusted-attestation/v1")


def seal_manifest(manifest: CandidateManifest) -> CandidateManifest:
    """Return a copy carrying its calculated integrity hash."""

    return replace(manifest, manifest_hash=manifest_hash(manifest))


def seal_replay(replay: ReplayRecord) -> ReplayRecord:
    """Return a copy carrying its calculated replay hash."""

    return replace(replay, replay_hash=replay_hash(replay))
