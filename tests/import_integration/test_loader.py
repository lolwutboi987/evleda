from __future__ import annotations

import copy
import unittest
from dataclasses import FrozenInstanceError, fields, replace

from backend.canonical_import import MappingEvidenceDraft
from backend.import_integration import (
    ImportIntegrationConfigurationError,
    ImportSubjectIntegrityError,
    ImportSubjectInvalidRequest,
    ImportSubjectStale,
    ResolvedImportSubject,
    ResolvedImportSubjectLoader,
    ResolvedImportSubjectRequestIssuer,
)
from backend.import_integration.models import resolved_import_subject_sha256
from backend.interchange_artifacts import ArtifactContent
from backend.kicad_import_candidates import CandidateTransitionEvent

from .fixtures import LoaderFixture


class ResolvedImportSubjectLoaderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = LoaderFixture()

    def tearDown(self) -> None:
        self.fixture.close()

    def test_load_returns_exact_inert_subject_after_two_phase_rereads(
        self,
    ) -> None:
        subject = self.fixture.loader().load(self.fixture.request)

        self.assertIs(type(subject), ResolvedImportSubject)
        self.assertEqual(self.fixture.candidate, subject.candidate)
        self.assertEqual(
            self.fixture.mapping_evidence,
            subject.mapping_evidence,
        )
        self.assertEqual(
            self.fixture.mapping.transaction_input,
            subject.transaction_input,
        )
        self.assertEqual(
            self.fixture.mapping_evidence.transaction_commands,
            subject.transaction_input.commands,
        )
        self.assertEqual(
            self.fixture.request.preview_digest,
            subject.preview_digest,
        )
        self.assertEqual(
            self.fixture.request.prospective_revision_sha256,
            subject.prospective_revision_sha256,
        )
        self.assertFalse(subject.authorizes_approval)
        self.assertFalse(subject.authorizes_staging)
        self.assertFalse(subject.authorizes_internal_commit)
        self.assertFalse(subject.authorizes_manufacturing_release)
        for forbidden in (
            "approve",
            "authorize",
            "stage",
            "commit",
            "manufacture",
            "repository",
            "callback",
        ):
            self.assertFalse(hasattr(subject, forbidden))

        self.assertEqual(2, len(self.fixture.artifact_reader.calls))
        self.assertEqual(2, self.fixture.candidate_reader.get_calls)
        self.assertEqual(2, self.fixture.candidate_reader.event_calls)
        self.assertEqual(2, self.fixture.mapping_reader.list_calls)
        self.assertEqual(2, self.fixture.mapping_reader.get_calls)
        self.assertEqual(2, self.fixture.mapping_reader.event_calls)
        self.assertEqual(1, len(self.fixture.remapper.calls))
        self.assertEqual(2, len(self.fixture.authority_provider.calls))

    def test_missing_or_invalid_adapters_fail_before_any_read(self) -> None:
        with self.assertRaises(ImportIntegrationConfigurationError):
            ResolvedImportSubjectLoader()
        with self.assertRaises(ImportIntegrationConfigurationError):
            ResolvedImportSubjectLoader(
                request_issuer=self.fixture.issuer,
                artifact_reader=object(),  # type: ignore[arg-type]
                candidate_repository=self.fixture.candidate_reader,
                mapping_repository=self.fixture.mapping_reader,
                remapper=self.fixture.remapper,
                authority_provider=self.fixture.authority_provider,
            )
        self.assertEqual([], self.fixture.artifact_reader.calls)
        self.assertEqual(0, self.fixture.candidate_reader.get_calls)
        self.assertEqual(0, self.fixture.mapping_reader.list_calls)
        self.assertEqual([], self.fixture.authority_provider.calls)

    def test_request_must_be_exact_unmodified_and_from_captured_issuer(
        self,
    ) -> None:
        loader = self.fixture.loader()
        with self.assertRaises(ImportSubjectInvalidRequest):
            loader.load({})

        forged = copy.deepcopy(self.fixture.request)
        object.__setattr__(
            forged,
            "candidate_last_event_sha256",
            "f" * 64,
        )
        with self.assertRaises(ImportSubjectInvalidRequest):
            loader.load(forged)

        other_issuer = ResolvedImportSubjectRequestIssuer(
            issuer_id="other-request-issuer",
            issuer_incarnation="other-request-incarnation",
        )
        other_request = other_issuer.issue(
            candidate=self.fixture.candidate,
            mapping_evidence=self.fixture.mapping_evidence,
            authority=self.fixture.authority,
        )
        with self.assertRaises(ImportSubjectInvalidRequest):
            loader.load(other_request)

    def test_issuer_and_witness_claims_are_immutable_and_rechecked(self) -> None:
        issuer_id_field = "issuer_id"
        with self.assertRaises(FrozenInstanceError):
            setattr(
                self.fixture.issuer,
                issuer_id_field,
                "mutated-issuer",
            )

        loader = self.fixture.loader()
        object.__setattr__(
            self.fixture.issuer,
            "issuer_incarnation",
            "hostile-incarnation-change",
        )
        with self.assertRaises(ImportSubjectInvalidRequest):
            loader.load(self.fixture.request)

    def test_request_issuance_rejects_cross_subject_authority_and_lifecycle(
        self,
    ) -> None:
        with self.assertRaises(ImportSubjectInvalidRequest):
            self.fixture.issuer.issue(
                candidate=self.fixture.candidate,
                mapping_evidence=self.fixture.mapping_evidence,
                authority=replace(
                    self.fixture.authority,
                    project_id="another-project",
                ),
            )
        with self.assertRaises(ImportSubjectInvalidRequest):
            self.fixture.issuer.issue(
                candidate=self.fixture.pending_candidate,
                mapping_evidence=self.fixture.mapping_evidence,
                authority=self.fixture.authority,
            )

    def test_candidate_request_and_event_chain_are_exact(self) -> None:
        pending = self.fixture.pending_candidate
        self.fixture.candidate_reader.get_outputs = [pending]
        with self.assertRaises(ImportSubjectStale):
            self.fixture.loader().load(self.fixture.request)

        self.fixture.candidate_reader.get_outputs = []
        events = self.fixture.candidate_store.list_events(self.fixture.candidate.candidate_id)
        self.fixture.candidate_reader.event_outputs = [tuple(reversed(events))]
        with self.assertRaises(ImportSubjectIntegrityError):
            self.fixture.loader().load(self.fixture.request)

    def test_resolution_event_actor_must_be_the_durable_mapping_actor(
        self,
    ) -> None:
        root, resolved = self.fixture.candidate_store.list_events(
            self.fixture.candidate.candidate_id
        )
        forged_resolution = CandidateTransitionEvent.build(
            candidate_id=resolved.candidate_id,
            sequence=resolved.sequence,
            kind=resolved.kind,
            previous_state=resolved.previous_state,
            state=resolved.state,
            actor_id="different-mapping-actor",
            receipt_digest=resolved.receipt_digest,
            reason=resolved.reason,
            transitioned_at=resolved.transitioned_at,
            previous_event_digest=resolved.previous_event_digest,
        )
        forged_candidate = replace(
            self.fixture.candidate,
            last_event_digest=forged_resolution.event_digest,
        )
        forged_request = self.fixture.issuer.issue(
            candidate=forged_candidate,
            mapping_evidence=self.fixture.mapping_evidence,
            authority=self.fixture.authority,
        )
        self.fixture.candidate_reader.get_outputs = [forged_candidate]
        self.fixture.candidate_reader.event_outputs = [(root, forged_resolution)]

        with self.assertRaises(ImportSubjectIntegrityError):
            self.fixture.loader().load(forged_request)

    def test_mapping_receipt_must_name_one_active_exact_record(self) -> None:
        self.fixture.mapping_reader.list_outputs = [()]
        with self.assertRaises(ImportSubjectIntegrityError):
            self.fixture.loader().load(self.fixture.request)

        self.fixture.mapping_reader.list_outputs = [
            (
                self.fixture.mapping_evidence,
                self.fixture.mapping_evidence,
            )
        ]
        with self.assertRaises(ImportSubjectIntegrityError):
            self.fixture.loader().load(self.fixture.request)

        self.fixture.mapping_store.invalidate(
            self.fixture.mapping_evidence.mapping_evidence_id,
            expected_generation=self.fixture.mapping_evidence.generation,
            actor_id=self.fixture.mapping.authorized_actor,
            reason="fixture invalidation",
        )
        with self.assertRaises(ImportSubjectStale):
            self.fixture.loader().load(self.fixture.request)

    def test_unrelated_active_mapping_is_inert_when_receipt_match_is_unique(
        self,
    ) -> None:
        alternate = self.fixture.alternate_mapping()
        orphan = self.fixture.mapping_store.create(
            MappingEvidenceDraft.from_mapping(
                self.fixture.pending_candidate,
                alternate,
            )
        )
        self.assertNotEqual(
            orphan.mapping_evidence_digest,
            self.fixture.candidate.resolution_receipt_digest,
        )

        subject = self.fixture.loader().load(self.fixture.request)

        self.assertEqual(
            self.fixture.mapping_evidence.mapping_evidence_id,
            subject.mapping_evidence.mapping_evidence_id,
        )

    def test_artifact_owner_and_immutable_second_read_are_required(self) -> None:
        wrong_owner = ArtifactContent(
            replace(
                self.fixture.artifact.record,
                actor_id="another-artifact-owner",
            ),
            self.fixture.artifact.payload,
        )
        self.fixture.artifact_reader.outputs = [wrong_owner]
        with self.assertRaises(ImportSubjectIntegrityError):
            self.fixture.loader().load(self.fixture.request)

        changed_metadata = ArtifactContent(
            replace(
                self.fixture.artifact.record,
                idempotency_key="another-upload-operation",
            ),
            self.fixture.artifact.payload,
        )
        self.fixture.artifact_reader.outputs = [
            self.fixture.artifact,
            changed_metadata,
        ]
        with self.assertRaises(ImportSubjectIntegrityError):
            self.fixture.loader().load(self.fixture.request)

        hostile_content = copy.deepcopy(self.fixture.artifact)
        object.__setattr__(hostile_content, "payload", b"altered")
        self.fixture.artifact_reader.outputs = [hostile_content]
        with self.assertRaises(ImportSubjectIntegrityError):
            self.fixture.loader().load(self.fixture.request)

    def test_fresh_mapper_result_must_match_full_v2_command_bodies(
        self,
    ) -> None:
        self.fixture.remapper.result = self.fixture.alternate_mapping()
        with self.assertRaises(ImportSubjectIntegrityError):
            self.fixture.loader().load(self.fixture.request)

        hostile = copy.deepcopy(self.fixture.mapping)
        transaction = hostile.transaction_input
        assert transaction is not None
        command = copy.deepcopy(transaction.commands[0])
        object.__setattr__(
            command,
            "payload_json",
            '{"hostile":"payload"}',
        )
        object.__setattr__(
            transaction,
            "commands",
            (command, *transaction.commands[1:]),
        )
        self.fixture.remapper.result = hostile
        with self.assertRaises(ImportSubjectIntegrityError):
            self.fixture.loader().load(self.fixture.request)

        self.fixture.remapper.result = object()
        with self.assertRaises(ImportSubjectIntegrityError):
            self.fixture.loader().load(self.fixture.request)

    def test_repeat_load_and_durable_reader_restart_are_idempotent(self) -> None:
        events_before = self.fixture.candidate_store.list_events(
            self.fixture.candidate.candidate_id
        )
        mapping_events_before = self.fixture.mapping_store.list_events(
            self.fixture.mapping_evidence.mapping_evidence_id
        )
        duplicate_request = self.fixture.issuer.issue(
            candidate=self.fixture.candidate,
            mapping_evidence=self.fixture.mapping_evidence,
            authority=self.fixture.authority,
        )
        self.assertEqual(
            self.fixture.request.request_digest,
            duplicate_request.request_digest,
        )
        self.assertEqual(
            self.fixture.request.request_id,
            duplicate_request.request_id,
        )

        first = self.fixture.loader().load(self.fixture.request)
        second = self.fixture.loader().load(duplicate_request)
        self.assertEqual(first, second)

        self.fixture.restart_durable_readers()
        after_restart = self.fixture.loader().load(self.fixture.request)
        self.assertEqual(first, after_restart)
        self.assertEqual(
            first.transaction_input.commands,
            self.fixture.mapping_evidence.transaction_commands,
        )
        self.assertEqual(
            events_before,
            self.fixture.candidate_store.list_events(self.fixture.candidate.candidate_id),
        )
        self.assertEqual(
            mapping_events_before,
            self.fixture.mapping_store.list_events(
                self.fixture.mapping_evidence.mapping_evidence_id
            ),
        )

    def test_server_restart_requires_reissue_from_durable_evidence(self) -> None:
        self.fixture.restart_durable_readers()
        restarted_issuer = ResolvedImportSubjectRequestIssuer(
            issuer_id=self.fixture.issuer.issuer_id,
            issuer_incarnation="fixture-request-restarted-incarnation",
        )
        restarted_loader = self.fixture.loader(request_issuer=restarted_issuer)
        with self.assertRaises(ImportSubjectInvalidRequest):
            restarted_loader.load(self.fixture.request)

        restarted_request = restarted_issuer.issue(
            candidate=self.fixture.candidate,
            mapping_evidence=self.fixture.mapping_evidence,
            authority=self.fixture.authority,
        )
        subject = restarted_loader.load(restarted_request)

        self.assertNotEqual(
            self.fixture.request.request_digest,
            restarted_request.request_digest,
        )
        self.assertEqual(
            self.fixture.mapping_evidence.transaction_commands,
            subject.transaction_input.commands,
        )
        self.assertFalse(subject.authorizes_staging)

    def test_subject_constructor_rejects_hash_consistent_cross_binding_drift(
        self,
    ) -> None:
        subject = self.fixture.loader().load(self.fixture.request)
        altered_mapping_result = "f" * 64
        altered_subject_digest = resolved_import_subject_sha256(
            request_digest=subject.request_digest,
            artifact=subject.artifact,
            candidate=subject.candidate,
            candidate_events=subject.candidate_events,
            mapping_evidence=subject.mapping_evidence,
            mapping_events=subject.mapping_events,
            canonical_candidate=subject.canonical_candidate,
            transaction_input=subject.transaction_input,
            mapping_result_sha256=altered_mapping_result,
            authority=subject.authority,
            preview_digest=subject.preview_digest,
            prospective_revision_digest=(subject.prospective_revision_sha256),
        )
        with self.assertRaises(ImportSubjectIntegrityError):
            replace(
                subject,
                mapping_result_sha256=altered_mapping_result,
                subject_sha256=altered_subject_digest,
            )

    def test_candidate_and_mapping_races_are_stale_not_accepted(self) -> None:
        def invalidate_candidate(*_: object) -> None:
            current = self.fixture.candidate_store.get(self.fixture.candidate.candidate_id)
            self.fixture.candidate_store.invalidate(
                current.candidate_id,
                expected_generation=current.generation,
                actor_id="fixture-stale-writer",
                reason="candidate changed during remap",
            )

        self.fixture.remapper.hook = invalidate_candidate  # type: ignore[assignment]
        with self.assertRaises(ImportSubjectStale):
            self.fixture.loader().load(self.fixture.request)

    def test_every_authority_field_is_rechecked_after_remap(self) -> None:
        replacements: dict[str, object] = {
            "project_id": "another-project",
            "project_head_revision": "1" * 64,
            "project_event_head_sha256": "2" * 64,
            "run_id": "another-run",
            "run_revision": self.fixture.authority.run_revision + 1,
            "run_incarnation": "another-run-incarnation",
            "run_event_head_sha256": "3" * 64,
            "coordination_context_digest": "4" * 64,
            "coordination_incarnation": "another-coordination-incarnation",
            "coordination_event_head_sha256": "5" * 64,
            "target_store_id": "another-project-store",
            "target_store_incarnation": "another-store-incarnation",
        }
        authority_fields = {item.name for item in fields(self.fixture.authority)}
        self.assertEqual(authority_fields, set(replacements))
        for name, value in replacements.items():
            with self.subTest(field=name):
                changed = replace(
                    self.fixture.authority,
                    **{name: value},
                )
                self.fixture.authority_provider.outputs = [
                    self.fixture.authority,
                    changed,
                ]
                with self.assertRaises(ImportSubjectStale):
                    self.fixture.loader().load(self.fixture.request)


if __name__ == "__main__":
    unittest.main()
