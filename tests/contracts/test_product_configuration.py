from __future__ import annotations

import json
import unittest
from pathlib import Path
from typing import Any, cast


class ProductConfigurationTests(unittest.TestCase):
    @staticmethod
    def _load() -> dict[str, Any]:
        def exact_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
            result: dict[str, Any] = {}
            for key, value in pairs:
                if key in result:
                    raise AssertionError(f"duplicate product configuration key: {key}")
                result[key] = value
            return result

        value = json.loads(
            Path("config/product.json").read_text(encoding="utf-8"),
            object_pairs_hook=exact_object,
            parse_constant=lambda token: (_ for _ in ()).throw(
                AssertionError(f"non-finite JSON constant: {token}")
            ),
        )
        if not isinstance(value, dict):
            raise AssertionError("product configuration root must be an object")
        return cast(dict[str, Any], value)

    def test_public_profile_has_conservative_finite_resource_limits(self) -> None:
        config = self._load()
        orchestration = config["orchestration"]
        runtime = config["model_runtime"]

        self.assertEqual(8, orchestration["max_concurrent_agents"])
        self.assertEqual(8, orchestration["wave_size"])
        self.assertEqual(48, orchestration["total_agent_dispatch_limit"])
        self.assertEqual(1_000_000, orchestration["token_limit"])
        self.assertEqual(500, orchestration["tool_call_limit"])
        self.assertFalse(orchestration["unsafe_resource_override_opt_in"])
        self.assertEqual(32_768, runtime["max_output_tokens"])
        self.assertEqual("max", runtime["reasoning_effort"])

    def test_resource_limits_do_not_disable_coordination_or_verification(self) -> None:
        config = self._load()
        coordination = config["coordination"]
        orchestration = config["orchestration"]
        verification = config["verification"]

        self.assertTrue(all(coordination.values()))
        self.assertTrue(orchestration["require_independent_critic"])
        self.assertFalse(verification["unknown_is_pass"])
        self.assertTrue(verification["require_native_engine"])
        self.assertTrue(verification["require_kicad_engine"])
        self.assertTrue(verification["engine_disagreement_is_blocking"])
        self.assertTrue(verification["require_exact_revision"])
        self.assertTrue(verification["require_algorithm_replay_hash"])


if __name__ == "__main__":
    unittest.main()
