from __future__ import annotations

import copy
import unittest
from dataclasses import replace

from backend.canonical_import import MappingEvidenceStoreUnavailable
from backend.import_integration import (
    ImportSubjectIntegrityError,
    ImportSubjectStale,
    ImportSubjectUnavailable,
)
from backend.interchange_artifacts import ArtifactStoreUnavailable
from backend.kicad_import_candidates import (
    CandidateNotFound,
    CandidateStoreUnavailable,
)

from .fixtures import LoaderFixture


class ResolvedImportSubjectLoaderFaultTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = LoaderFixture()

    def tearDown(self) -> None:
        self.fixture.close()

    def test_typed_store_outages_are_sanitized_as_unavailable(self) -> None:
        self.fixture.artifact_reader.outputs = [ArtifactStoreUnavailable("hidden artifact detail")]
        with self.assertRaises(ImportSubjectUnavailable):
            self.fixture.loader().load(self.fixture.request)

        self.fixture.candidate_reader.get_outputs = [
            CandidateStoreUnavailable("hidden candidate detail")
        ]
        with self.assertRaises(ImportSubjectUnavailable):
            self.fixture.loader().load(self.fixture.request)

        self.fixture.authority_provider.outputs = [RuntimeError("hidden authority detail")]
        with self.assertRaises(ImportSubjectUnavailable):
            self.fixture.loader().load(self.fixture.request)

        self.fixture.mapping_reader.list_outputs = [
            MappingEvidenceStoreUnavailable("hidden mapping detail")
        ]
        with self.assertRaises(ImportSubjectUnavailable):
            self.fixture.loader().load(self.fixture.request)

    def test_initial_candidate_absence_differs_from_post_read_disappearance(
        self,
    ) -> None:
        self.fixture.candidate_reader.get_outputs = [CandidateNotFound("missing")]
        from backend.import_integration import ImportSubjectNotFound

        with self.assertRaises(ImportSubjectNotFound):
            self.fixture.loader().load(self.fixture.request)

        self.fixture.candidate_reader.get_outputs = [
            self.fixture.candidate,
            CandidateNotFound("deleted despite append-only contract"),
        ]
        with self.assertRaises(ImportSubjectIntegrityError):
            self.fixture.loader().load(self.fixture.request)

    def test_hostile_exact_candidate_and_mapping_mutations_are_revalidated(
        self,
    ) -> None:
        candidate = copy.deepcopy(self.fixture.candidate)
        object.__setattr__(candidate, "generation", True)
        self.fixture.candidate_reader.get_outputs = [candidate]
        with self.assertRaises(ImportSubjectIntegrityError):
            self.fixture.loader().load(self.fixture.request)

    def test_nonconcrete_repository_and_authority_outputs_fail_integrity(
        self,
    ) -> None:
        self.fixture.candidate_reader.get_outputs = [object()]
        with self.assertRaises(ImportSubjectIntegrityError):
            self.fixture.loader().load(self.fixture.request)

        self.fixture.mapping_reader.list_outputs = [object()]
        with self.assertRaises(ImportSubjectIntegrityError):
            self.fixture.loader().load(self.fixture.request)

        self.fixture.authority_provider.outputs = [object()]
        with self.assertRaises(ImportSubjectIntegrityError):
            self.fixture.loader().load(self.fixture.request)

        evidence = copy.deepcopy(self.fixture.mapping_evidence)
        object.__setattr__(
            evidence,
            "transaction_commands",
            tuple(reversed(evidence.transaction_commands)),
        )
        self.fixture.mapping_reader.list_outputs = [(evidence,)]
        with self.assertRaises(ImportSubjectIntegrityError):
            self.fixture.loader().load(self.fixture.request)

    def test_mapping_lifecycle_race_after_remap_is_stale(self) -> None:
        def invalidate_mapping(*_: object) -> None:
            current = self.fixture.mapping_store.get(
                self.fixture.mapping_evidence.mapping_evidence_id
            )
            self.fixture.mapping_store.invalidate(
                current.mapping_evidence_id,
                expected_generation=current.generation,
                actor_id=self.fixture.mapping.authorized_actor,
                reason="mapping changed during remap",
            )

        self.fixture.remapper.hook = invalidate_mapping  # type: ignore[assignment]
        with self.assertRaises(ImportSubjectStale):
            self.fixture.loader().load(self.fixture.request)

    def test_remapper_failure_and_postconstruction_mutation_fail_closed(
        self,
    ) -> None:
        self.fixture.remapper.result = RuntimeError("hidden mapper detail")
        with self.assertRaises(ImportSubjectIntegrityError):
            self.fixture.loader().load(self.fixture.request)

        mapping = copy.deepcopy(self.fixture.mapping)
        object.__setattr__(
            mapping,
            "source_bundle_ir_sha256",
            "e" * 64,
        )
        self.fixture.remapper.result = mapping
        with self.assertRaises(ImportSubjectIntegrityError):
            self.fixture.loader().load(self.fixture.request)

    def test_initial_authority_mismatch_is_stale(self) -> None:
        self.fixture.authority_provider.outputs = [
            replace(
                self.fixture.authority,
                project_event_head_sha256="f" * 64,
            )
        ]
        with self.assertRaises(ImportSubjectStale):
            self.fixture.loader().load(self.fixture.request)

    def test_every_second_phase_dependency_outage_fails_closed(self) -> None:
        scenarios = (
            "artifact",
            "candidate",
            "mapping",
            "authority",
        )
        for scenario in scenarios:
            with self.subTest(dependency=scenario):
                fixture = LoaderFixture()
                try:
                    if scenario == "artifact":
                        fixture.artifact_reader.outputs = [
                            fixture.artifact,
                            ArtifactStoreUnavailable("hidden second artifact failure"),
                        ]
                    elif scenario == "candidate":
                        fixture.candidate_reader.get_outputs = [
                            fixture.candidate,
                            CandidateStoreUnavailable("hidden second candidate failure"),
                        ]
                    elif scenario == "mapping":
                        fixture.mapping_reader.list_outputs = [
                            (fixture.mapping_evidence,),
                            MappingEvidenceStoreUnavailable("hidden second mapping failure"),
                        ]
                    else:
                        fixture.authority_provider.outputs = [
                            fixture.authority,
                            RuntimeError("hidden second authority failure"),
                        ]
                    with self.assertRaises(ImportSubjectUnavailable):
                        fixture.loader().load(fixture.request)
                finally:
                    fixture.close()

    def test_mapper_receives_detached_snapshots_not_repository_objects(
        self,
    ) -> None:
        durable_candidate = self.fixture.candidate_store.get(self.fixture.candidate.candidate_id)

        def mutate_mapper_inputs(
            _artifact: object,
            candidate: object,
            authority: object,
        ) -> None:
            object.__setattr__(candidate, "generation", True)
            object.__setattr__(authority, "run_revision", True)

        self.fixture.remapper.hook = mutate_mapper_inputs  # type: ignore[assignment]
        with self.assertRaises(ImportSubjectStale):
            self.fixture.loader().load(self.fixture.request)

        self.assertEqual(
            durable_candidate,
            self.fixture.candidate_store.get(durable_candidate.candidate_id),
        )


if __name__ == "__main__":
    unittest.main()
