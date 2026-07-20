"""Contract tests for daemon indicator result envelopes."""

import unittest
from unittest.mock import patch

from quant_engine.daemon import (
    INDICATOR_DISPATCH,
    _with_authoritative_name,
    handle_calc,
)


class IndicatorResultEnvelopeTests(unittest.TestCase):
    @staticmethod
    def _packet(name):
        return {
            "asset": "BTC/USDT",
            "series": [
                {
                    "open": 100,
                    "high": 110,
                    "low": 90,
                    "close": 105,
                    "volume": 10,
                },
            ],
            "indicators": [{"name": name, "params": {}}],
        }

    def test_injects_dispatch_name_without_mutating_source(self):
        source = {"composite_score": 80}

        result = _with_authoritative_name("CompositeMomentum", source)

        self.assertEqual(result["name"], "CompositeMomentum")
        self.assertNotIn("name", source)
        self.assertIsNot(result, source)

    def test_dispatch_name_overrides_inner_name(self):
        result = _with_authoritative_name(
            "SmartOrderBlock",
            {"name": "WrongName", "has_active_ob": False},
        )

        self.assertEqual(result["name"], "SmartOrderBlock")

    def test_failure_result_receives_dispatch_name(self):
        result = _with_authoritative_name("UnknownIndicator", {"error": "not implemented"})

        self.assertEqual(
            result,
            {"error": "not implemented", "name": "UnknownIndicator"},
        )

    def test_non_mapping_result_is_preserved_for_downstream_validation(self):
        self.assertIsNone(_with_authoritative_name("BrokenIndicator", None))

    def test_handle_calc_normalizes_dispatched_result(self):
        source = {"value": 42}
        with patch.dict(
            INDICATOR_DISPATCH,
            {"ContractIndicator": lambda _df, _params: source},
        ):
            results = handle_calc(self._packet("ContractIndicator"))

        self.assertEqual(
            results["ContractIndicator"],
            {"value": 42, "name": "ContractIndicator"},
        )
        self.assertNotIn("name", source)

    def test_handle_calc_unknown_indicator_returns_named_failure(self):
        results = handle_calc(self._packet("UnknownIndicator"))

        self.assertEqual(results["UnknownIndicator"]["name"], "UnknownIndicator")
        self.assertIn("error", results["UnknownIndicator"])


if __name__ == "__main__":
    unittest.main()
