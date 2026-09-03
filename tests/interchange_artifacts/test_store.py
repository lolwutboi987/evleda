from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import hashlib
from io import BytesIO
import os
from pathlib import Path
import sqlite3
import stat
import struct
import tempfile
import unittest
import warnings
import zipfile

from backend.interchange_artifacts import (
    STORE_SCHEMA_VERSION,
    ArtifactDigestMismatch,
    ArtifactIdempotencyConflict,
    ArtifactIntegrityError,
    ArtifactKind,
    ArtifactNotFound,
    ArtifactTooLarge,
    InvalidArtifactRequest,
    KiCadArtifactSyntaxError,
    KiCadArtifactVersionUnsupported,
    QuarantineArtifactStore,
    UnsafeArtifactStorage,
    UnsupportedArtifactMediaType,
)


FIXTURE = Path(__file__).parents[1] / "fixtures" / "kicad" / "supported_board.kicad_pcb"
PROJECT_FIXTURES = Path(__file__).parents[1] / "fixtures" / "kicad_project"


def project_entries(stem: str = "supported_project") -> dict[str, bytes]:
    project_name = (
        "supported_project.kicad_pro"
        if stem == "supported_project"
        else "unsupported_settings.kicad_pro"
    )
    return {
        f"{stem}.kicad_pro": (PROJECT_FIXTURES / project_name).read_bytes(),
        f"{stem}.kicad_sch": (
            PROJECT_FIXTURES / "supported_project.kicad_sch"
        ).read_bytes(),
        f"{stem}.kicad_pcb": FIXTURE.read_bytes(),
    }


def zip_payload(
    entries: dict[str, bytes] | list[tuple[zipfile.ZipInfo | str, bytes]],
    *,
    compression: int = zipfile.ZIP_DEFLATED,
) -> bytes:
    stream = BytesIO()
    with zipfile.ZipFile(stream, mode="w", compression=compression) as archive:
        items = entries.items() if isinstance(entries, dict) else entries
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            for name, payload in items:
                archive.writestr(name, payload)
    return stream.getvalue()


def mark_first_entry_encrypted(payload: bytes) -> bytes:
    changed = bytearray(payload)
    local = changed.index(b"PK\x03\x04")
    central = changed.index(b"PK\x01\x02")
    local_flags = struct.unpack_from("<H", changed, local + 6)[0]
    central_flags = struct.unpack_from("<H", changed, central + 8)[0]
    struct.pack_into("<H", changed, local + 6, local_flags | 1)
    struct.pack_into("<H", changed, central + 8, central_flags | 1)
    return bytes(changed)


class QuarantineArtifactStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "quarantine"
        self.payload = FIXTURE.read_bytes()
        self.digest = hashlib.sha256(self.payload).hexdigest()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _put(
        self,
        store: QuarantineArtifactStore,
        *,
        payload: bytes | None = None,
        key: str = "upload-1",
        digest: str | None = None,
        actor: str = "user-1",
    ):
        body = self.payload if payload is None else payload
        return store.put(
            body,
            actor_id=actor,
            source_sha256=hashlib.sha256(body).hexdigest() if digest is None else digest,
            declared_length=len(body),
            idempotency_key=key,
        )

    @staticmethod
    def _put_bundle(
        store: QuarantineArtifactStore,
        payload: bytes,
        *,
        key: str = "bundle-1",
    ):
        return store.put(
            payload,
            actor_id="user-1",
            source_sha256=hashlib.sha256(payload).hexdigest(),
            declared_length=len(payload),
            idempotency_key=key,
            kind=ArtifactKind.KICAD_PROJECT_BUNDLE,
            media_type="application/zip",
        )

    def test_stores_exact_opaque_bytes_and_returns_path_free_contract_metadata(self) -> None:
        with QuarantineArtifactStore(self.root) as store:
            record = self._put(store)
            self.assertRegex(record.artifact_id, r"^artifact_[0-9a-f]{32}$")
            self.assertEqual(record.actor_id, "user-1")
            self.assertEqual(record.source.value, "user-upload")
            self.assertEqual(record.sha256, self.digest)
            self.assertEqual(record.size_bytes, len(self.payload))
            self.assertEqual(record.quarantine_status.value, "stored-uninspected")
            self.assertEqual(
                set(record.api_payload()),
                {
                    "artifactId",
                    "kind",
                    "mediaType",
                    "sizeBytes",
                    "sha256",
                    "quarantineStatus",
                    "createdAt",
                },
            )
            self.assertNotIn("path", str(record.api_payload()).lower())
            loaded = store.read(record.artifact_id, record.sha256, actor_id="user-1")
            self.assertEqual(loaded.payload, self.payload)
            self.assertEqual(loaded.record, record)

    def test_restart_preserves_identity_metadata_and_verified_content(self) -> None:
        first = QuarantineArtifactStore(self.root)
        record = self._put(first)
        first.close()

        with QuarantineArtifactStore(self.root) as restarted:
            loaded = restarted.read(record.artifact_id, record.sha256, actor_id="user-1")
            self.assertEqual(loaded.record, record)
            self.assertEqual(loaded.payload, self.payload)
            retry = self._put(restarted)
            self.assertEqual(retry, record)

    def test_project_bundle_stores_exact_zip_and_survives_restart_in_manifest_review_mode(
        self,
    ) -> None:
        payload = zip_payload(project_entries("unsupported_settings"))
        first = QuarantineArtifactStore(self.root)
        record = self._put_bundle(first, payload)
        first.close()

        self.assertIs(record.kind, ArtifactKind.KICAD_PROJECT_BUNDLE)
        self.assertEqual(record.media_type, "application/zip")
        self.assertEqual(record.quarantine_status.value, "stored-uninspected")
        self.assertEqual(record.sha256, hashlib.sha256(payload).hexdigest())
        with QuarantineArtifactStore(self.root) as restarted:
            loaded = restarted.read(record.artifact_id, record.sha256, actor_id="user-1")
            self.assertEqual(loaded.payload, payload)
            self.assertEqual(loaded.record, record)
            self.assertEqual(self._put_bundle(restarted, payload), record)

    def test_project_bundle_rejects_unsafe_names_duplicate_names_and_wrong_membership(
        self,
    ) -> None:
        base = project_entries()
        project = base["supported_project.kicad_pro"]
        unsafe_names = (
            "../supported_project.kicad_pro",
            "/supported_project.kicad_pro",
            "C:supported_project.kicad_pro",
            "folder/supported_project.kicad_pro",
            r"folder\supported_project.kicad_pro",
        )
        with QuarantineArtifactStore(self.root) as store:
            for index, unsafe_name in enumerate(unsafe_names):
                entries = dict(base)
                del entries["supported_project.kicad_pro"]
                entries[unsafe_name] = project
                with self.subTest(name=unsafe_name), self.assertRaises(
                    KiCadArtifactSyntaxError
                ):
                    self._put_bundle(
                        store,
                        zip_payload(entries),
                        key=f"unsafe-name-{index}",
                    )

            duplicate = [
                ("Supported_Project.kicad_pro", project),
                ("supported_project.kicad_pro", project),
                ("supported_project.kicad_pcb", base["supported_project.kicad_pcb"]),
            ]
            with self.assertRaises(KiCadArtifactSyntaxError):
                self._put_bundle(store, zip_payload(duplicate), key="duplicate-casefold")

            wrong_stem = dict(base)
            wrong_stem["other.kicad_sch"] = wrong_stem.pop(
                "supported_project.kicad_sch"
            )
            with self.assertRaises(KiCadArtifactSyntaxError):
                self._put_bundle(store, zip_payload(wrong_stem), key="wrong-stem")

            reserved = {
                name.replace("supported_project", "CON"): content
                for name, content in base.items()
            }
            with self.assertRaises(KiCadArtifactSyntaxError):
                self._put_bundle(store, zip_payload(reserved), key="reserved-stem")

            nested = dict(base)
            nested["nested.zip"] = zip_payload({"payload.txt": b"nested"})
            with self.assertRaises(KiCadArtifactSyntaxError):
                self._put_bundle(store, zip_payload(nested), key="nested-archive")

            directory = dict(base)
            del directory["supported_project.kicad_pro"]
            directory["supported_project.kicad_pro/"] = b""
            with self.assertRaises(KiCadArtifactSyntaxError):
                self._put_bundle(store, zip_payload(directory), key="directory-entry")

    def test_project_bundle_rejects_encryption_special_files_and_crc_failures(self) -> None:
        base = project_entries()
        encrypted = mark_first_entry_encrypted(zip_payload(base))

        symlink = zipfile.ZipInfo("supported_project.kicad_pro")
        symlink.create_system = 3
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        symlink_entries = [
            (symlink, b"outside"),
            ("supported_project.kicad_sch", base["supported_project.kicad_sch"]),
            ("supported_project.kicad_pcb", base["supported_project.kicad_pcb"]),
        ]

        fifo = zipfile.ZipInfo("supported_project.kicad_pro")
        fifo.create_system = 3
        fifo.external_attr = (stat.S_IFIFO | 0o600) << 16
        fifo_entries = [
            (fifo, base["supported_project.kicad_pro"]),
            ("supported_project.kicad_sch", base["supported_project.kicad_sch"]),
            ("supported_project.kicad_pcb", base["supported_project.kicad_pcb"]),
        ]

        crc_failure = bytearray(zip_payload(base, compression=zipfile.ZIP_STORED))
        project_offset = crc_failure.index(base["supported_project.kicad_pro"])
        crc_failure[project_offset] ^= 1

        with QuarantineArtifactStore(self.root) as store:
            for key, payload in (
                ("encrypted", encrypted),
                ("symlink", zip_payload(symlink_entries)),
                ("fifo", zip_payload(fifo_entries)),
                ("crc", bytes(crc_failure)),
            ):
                with self.subTest(case=key), self.assertRaises(
                    KiCadArtifactSyntaxError
                ):
                    self._put_bundle(store, payload, key=key)

    def test_project_bundle_enforces_per_entry_and_compression_ratio_limits(self) -> None:
        oversized_project = project_entries()
        oversized_project["supported_project.kicad_pro"] += b" " * (
            4 * 1024 * 1024
        )
        compression_bomb = project_entries()
        compression_bomb["supported_project.kicad_pcb"] += b" " * (2 * 1024 * 1024)

        with QuarantineArtifactStore(self.root) as store:
            with self.assertRaises(ArtifactTooLarge):
                self._put_bundle(
                    store,
                    zip_payload(oversized_project),
                    key="project-entry-limit",
                )
            with self.assertRaises(ArtifactTooLarge):
                self._put_bundle(
                    store,
                    zip_payload(compression_bomb),
                    key="compression-ratio",
                )

    def test_project_bundle_content_must_pass_full_three_artifact_round_trip(self) -> None:
        invalid = project_entries()
        invalid["supported_project.kicad_sch"] = b"(kicad_sch)"
        with QuarantineArtifactStore(self.root) as store:
            with self.assertRaises(KiCadArtifactSyntaxError):
                self._put_bundle(store, zip_payload(invalid), key="invalid-project")

    def test_digest_length_limits_media_kind_and_envelope_fail_closed(self) -> None:
        with QuarantineArtifactStore(self.root, maximum_bytes=len(self.payload) + 10) as store:
            with self.assertRaises(ArtifactDigestMismatch) as digest_error:
                self._put(store, digest="0" * 64)
            self.assertEqual(digest_error.exception.code, "artifact_digest_mismatch")

            with self.assertRaises(InvalidArtifactRequest):
                store.put(
                    self.payload,
                    actor_id="user-1",
                    source_sha256=self.digest,
                    declared_length=len(self.payload) - 1,
                    idempotency_key="length-mismatch",
                )
            with self.assertRaises(ArtifactTooLarge) as large_error:
                store.put(
                    self.payload,
                    actor_id="user-1",
                    source_sha256=self.digest,
                    declared_length=len(self.payload),
                    idempotency_key="lower-limit",
                    maximum_bytes=len(self.payload) - 1,
                )
            self.assertEqual(large_error.exception.code, "upload_too_large")
            with self.assertRaises(UnsupportedArtifactMediaType):
                store.put(
                    self.payload,
                    actor_id="user-1",
                    source_sha256=self.digest,
                    declared_length=len(self.payload),
                    idempotency_key="kind-media-mismatch",
                    kind="kicad_project_bundle",
                    media_type="application/x-kicad-pcb",
                )
            with self.assertRaises(UnsupportedArtifactMediaType):
                store.put(
                    self.payload,
                    actor_id="user-1",
                    source_sha256=self.digest,
                    declared_length=len(self.payload),
                    idempotency_key="unknown-kind",
                    kind="gerber_bundle",
                    media_type="application/zip",
                )

            malformed = b"(kicad_pcb (generator_version 10.0.0)"
            with self.assertRaises(KiCadArtifactSyntaxError):
                self._put(store, payload=malformed, key="malformed")
            bom = b"\xef\xbb\xbf" + self.payload
            with self.assertRaises(KiCadArtifactSyntaxError):
                self._put(store, payload=bom, key="bom")
            wrong_version = self.payload.replace(b"10.0.0", b"9.0.0", 1)
            with self.assertRaises(KiCadArtifactVersionUnsupported):
                self._put(store, payload=wrong_version, key="wrong-version")

    def test_idempotency_is_actor_scoped_and_conflicts_on_changed_input(self) -> None:
        changed = self.payload.replace(b"10.0.0", b"10.0.1", 1)
        with QuarantineArtifactStore(self.root) as store:
            original = self._put(store)
            self.assertEqual(self._put(store), original)
            other_actor = self._put(store, actor="user-2")
            self.assertNotEqual(other_actor.artifact_id, original.artifact_id)
            with self.assertRaises(ArtifactIdempotencyConflict) as conflict:
                self._put(store, payload=changed)
            self.assertEqual(conflict.exception.code, "idempotency_conflict")

    def test_concurrent_idempotent_uploads_have_one_identity_and_clean_temporary_files(
        self,
    ) -> None:
        stores = [QuarantineArtifactStore(self.root) for _ in range(4)]
        try:
            with ThreadPoolExecutor(max_workers=12) as executor:
                futures = [executor.submit(self._put, stores[index % 4]) for index in range(24)]
                records = [future.result() for future in futures]
            self.assertEqual(len({record.artifact_id for record in records}), 1)
            self.assertEqual(len({record.sha256 for record in records}), 1)
            self.assertEqual(list((self.root / "temporary").iterdir()), [])
            blobs = list((self.root / "objects").glob("*/*.blob"))
            self.assertEqual(len(blobs), 1)
        finally:
            for store in stores:
                store.close()

    def test_concurrent_changed_reuse_never_rebinds_the_winning_idempotency_key(self) -> None:
        alternate = self.payload.replace(b"10.0.0", b"10.0.2", 1)
        stores = [QuarantineArtifactStore(self.root) for _ in range(2)]
        try:
            def upload(index: int) -> tuple[str, str]:
                body = self.payload if index % 2 == 0 else alternate
                try:
                    record = self._put(stores[index % 2], payload=body)
                except ArtifactIdempotencyConflict:
                    return "conflict", hashlib.sha256(body).hexdigest()
                return record.artifact_id, record.sha256

            with ThreadPoolExecutor(max_workers=10) as executor:
                results = list(executor.map(upload, range(20)))
            successes = [item for item in results if item[0] != "conflict"]
            conflicts = [item for item in results if item[0] == "conflict"]
            self.assertTrue(successes)
            self.assertTrue(conflicts)
            self.assertEqual(len({item[0] for item in successes}), 1)
            self.assertEqual(len({item[1] for item in successes}), 1)
        finally:
            for store in stores:
                store.close()

    def test_blob_tamper_wrong_actor_and_wrong_digest_are_detected_on_every_read(self) -> None:
        with QuarantineArtifactStore(self.root) as store:
            record = self._put(store)
            with self.assertRaises(ArtifactNotFound):
                store.read(record.artifact_id, record.sha256, actor_id="user-2")
            with self.assertRaises(ArtifactDigestMismatch):
                store.read(record.artifact_id, "0" * 64, actor_id="user-1")

            blob = next((self.root / "objects").glob("*/*.blob"))
            blob.write_bytes(b"x" * len(self.payload))
            with self.assertRaises(ArtifactIntegrityError):
                store.read(record.artifact_id, record.sha256, actor_id="user-1")

    def test_metadata_is_sqlite_immutable_and_digest_bound_after_restart(self) -> None:
        store = QuarantineArtifactStore(self.root)
        record = self._put(store)
        store.close()
        database = sqlite3.connect(self.root / "artifacts.sqlite3")
        try:
            with self.assertRaises(sqlite3.IntegrityError):
                database.execute(
                    """
                    UPDATE quarantine_artifacts
                    SET size_bytes = size_bytes + 1
                    WHERE artifact_id = ?
                    """,
                    (record.artifact_id,),
                )
        finally:
            database.close()

        with QuarantineArtifactStore(self.root) as restarted:
            self.assertEqual(
                restarted.read(record.artifact_id, record.sha256, actor_id="user-1").payload,
                self.payload,
            )

    def test_v1_store_migrates_without_rebinding_existing_pcb_records(self) -> None:
        store = QuarantineArtifactStore(self.root)
        record = self._put(store)
        store.close()
        database = sqlite3.connect(self.root / "artifacts.sqlite3")
        try:
            database.executescript(
                """
                DROP TRIGGER quarantine_artifacts_no_update;
                DROP TRIGGER quarantine_artifacts_no_delete;
                ALTER TABLE quarantine_artifacts RENAME TO quarantine_artifacts_v2;
                CREATE TABLE quarantine_artifacts (
                    artifact_id TEXT PRIMARY KEY,
                    sha256 TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK (kind = 'kicad_pcb'),
                    media_type TEXT NOT NULL
                        CHECK (media_type = 'application/x-kicad-pcb'),
                    size_bytes INTEGER NOT NULL
                        CHECK (size_bytes BETWEEN 1 AND 33554432),
                    quarantine_status TEXT NOT NULL
                        CHECK (quarantine_status = 'stored-uninspected'),
                    actor_id TEXT NOT NULL,
                    source TEXT NOT NULL CHECK (source = 'user-upload'),
                    idempotency_key TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    metadata_sha256 TEXT NOT NULL,
                    UNIQUE (actor_id, source, idempotency_key)
                ) STRICT;
                INSERT INTO quarantine_artifacts SELECT * FROM quarantine_artifacts_v2;
                DROP TABLE quarantine_artifacts_v2;
                CREATE TRIGGER quarantine_artifacts_no_update
                BEFORE UPDATE ON quarantine_artifacts
                BEGIN
                    SELECT RAISE(ABORT, 'quarantine artifacts are immutable');
                END;
                CREATE TRIGGER quarantine_artifacts_no_delete
                BEFORE DELETE ON quarantine_artifacts
                BEGIN
                    SELECT RAISE(ABORT, 'quarantine artifacts are immutable');
                END;
                UPDATE artifact_store_meta SET schema_version = 1 WHERE singleton = 1;
                PRAGMA user_version = 1;
                """
            )
        finally:
            database.close()

        with QuarantineArtifactStore(self.root) as migrated:
            loaded = migrated.read(record.artifact_id, record.sha256, actor_id="user-1")
            self.assertEqual(loaded.payload, self.payload)
            bundle = zip_payload(project_entries())
            bundle_record = self._put_bundle(migrated, bundle)
            self.assertIs(bundle_record.kind, ArtifactKind.KICAD_PROJECT_BUNDLE)
        database = sqlite3.connect(self.root / "artifacts.sqlite3")
        try:
            self.assertEqual(
                database.execute("PRAGMA user_version").fetchone()[0],
                STORE_SCHEMA_VERSION,
            )
        finally:
            database.close()

    def test_traversal_and_symlink_objects_are_never_followed(self) -> None:
        with QuarantineArtifactStore(self.root) as store:
            record = self._put(store)
            with self.assertRaises(InvalidArtifactRequest):
                store.read("../artifacts.sqlite3", record.sha256, actor_id="user-1")

            blob = next((self.root / "objects").glob("*/*.blob"))
            target = self.root / "outside-target"
            target.write_bytes(self.payload)
            blob.unlink()
            try:
                os.symlink(target, blob)
            except OSError:
                self.skipTest("symlink creation is unavailable on this host")
            with self.assertRaises(UnsafeArtifactStorage):
                store.read(record.artifact_id, record.sha256, actor_id="user-1")


if __name__ == "__main__":
    unittest.main()
