"""Stage 3B4C6: tradingagents_adapter.py flatten-top-level protocol tests.

Tests the request dispatch logic in main() without invoking TradingAgents or LLMs.
We replace HANDLERS with stubs that just echo the payload, allowing us to assert
exactly what payload the dispatcher passes for each request shape.
"""
import json
import sys
import io
import importlib
from pathlib import Path

# Add quant_engine to import path
TESTS_DIR = Path(__file__).resolve().parent  # tests/python
REPO_ROOT = TESTS_DIR.parent.parent          # repo root
sys.path.insert(0, str(REPO_ROOT))

# Import the adapter without triggering TradingAgents import (which requires LLM deps).
# We use a lightweight stub for tradingagents module.
import types


def _create_fake_tradingagents_module():
    """Provide stubs so adapter.py module-level imports succeed without real deps."""
    if 'tradingagents' in sys.modules:
        return  # already loaded
    ta_pkg = types.ModuleType('tradingagents')
    # __file__ must point to a path whose .parent.parent / '.env' is NOT a file,
    # so adapter.py:32 `_ta_env_file.is_file()` returns False and load_dotenv is skipped.
    ta_pkg.__file__ = str(REPO_ROOT / 'nonexistent' / 'tradingagents' / '__init__.py')
    ta_pkg.__path__ = [str(REPO_ROOT / 'nonexistent' / 'tradingagents')]
    ta_pkg.__package__ = 'tradingagents'
    ta_default = types.ModuleType('tradingagents.default_config')
    ta_default.DEFAULT_CONFIG = {
        'llm_provider': 'openai',
        'deep_think_llm': 'gpt-4o',
        'quick_think_llm': 'gpt-4o-mini',
    }
    ta_graph = types.ModuleType('tradingagents.graph')
    ta_graph_mod = types.ModuleType('tradingagents.graph.trading_graph')
    class _FakeGraph:
        def __init__(self, debug=False, config=None):
            self.config = config or {}
        def propagate(self, symbol, trade_date):
            return ({}, 'Buy')
    ta_graph_mod.TradingAgentsGraph = _FakeGraph
    ta_graph.trading_graph = ta_graph_mod
    ta_agents = types.ModuleType('tradingagents.agents')
    ta_schemas = types.ModuleType('tradingagents.agents.schemas')
    class _Base:  # mimics pydantic.BaseModel minimal interface
        def model_dump(self):
            return {}
    ta_schemas.PortfolioDecision = _Base
    ta_schemas.TraderProposal = _Base
    ta_schemas.PortfolioRating = _Base
    ta_agents.schemas = ta_schemas
    ta_pkg.default_config = ta_default
    ta_pkg.graph = ta_graph
    ta_pkg.agents = ta_agents
    sys.modules['tradingagents'] = ta_pkg
    sys.modules['tradingagents.default_config'] = ta_default
    sys.modules['tradingagents.graph'] = ta_graph
    sys.modules['tradingagents.graph.trading_graph'] = ta_graph_mod
    sys.modules['tradingagents.agents'] = ta_agents
    sys.modules['tradingagents.agents.schemas'] = ta_schemas


_create_fake_tradingagents_module()

# Now import adapter
spec = importlib.util.spec_from_file_location(
    'tradingagents_adapter',
    str(REPO_ROOT / 'quant_engine' / 'tradingagents_adapter.py'),
)
adapter_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter_mod)


# ── Tests ────────────────────────────────────────────────
def test_flatten_top_level_symbol():
    """Stage 3B4C6: flattened CALC request exposes symbol at top level."""
    captured = {}
    def fake_analyze(payload):
        captured.update(payload)
        return {'success': True, 'report': None}
    adapter_mod.HANDLERS['CALC'] = lambda p: fake_analyze(p)
    request = {'type': 'CALC', 'correlationId': 'c1', 'symbol': 'BTC/USDT', 'asset': 'BTC/USDT'}
    sys.stdin = io.StringIO(json.dumps(request) + '\n')
    sys.stdout = io.StringIO()
    adapter_mod.main()
    sys.stdin = sys.__stdin__
    sys.stdout = sys.__stdout__
    assert captured.get('symbol') == 'BTC/USDT', f'expected BTC/USDT, got {captured.get("symbol")}'


def test_nested_payload_preserved():
    """Stage 3B4C6: explicit nested payload is preserved; flat provides fallback."""
    captured = {}
    def fake_analyze(payload):
        captured.update(payload)
        return {'success': True, 'report': None}
    adapter_mod.HANDLERS['ANALYZE'] = lambda p: fake_analyze(p)
    # nested payload has symbol; flat has a different symbol; nested should win
    request = {
        'type': 'ANALYZE',
        'correlationId': 'c2',
        'symbol': 'ETH/USDT',  # flat
        'payload': {'symbol': 'BTC/USDT', 'asset': 'BTC/USDT'},  # nested wins
    }
    sys.stdin = io.StringIO(json.dumps(request) + '\n')
    sys.stdout = io.StringIO()
    adapter_mod.main()
    sys.stdin = sys.__stdin__
    sys.stdout = sys.__stdout__
    assert captured.get('symbol') == 'BTC/USDT', f'nested payload should override: {captured}'


def test_flat_only_request_works():
    """Stage 3B4C6: pure flat request (no nested payload) is supported."""
    captured = {}
    def fake_analyze(payload):
        captured.update(payload)
        return {'success': True, 'report': None}
    adapter_mod.HANDLERS['CALC'] = lambda p: fake_analyze(p)
    request = {'type': 'CALC', 'correlationId': 'c3', 'symbol': 'SOL/USDT', 'timestamp': '2026-07-22'}
    sys.stdin = io.StringIO(json.dumps(request) + '\n')
    sys.stdout = io.StringIO()
    adapter_mod.main()
    sys.stdin = sys.__stdin__
    sys.stdout = sys.__stdout__
    assert captured.get('symbol') == 'SOL/USDT'
    assert captured.get('timestamp') == '2026-07-22'


def test_correlation_id_echoed():
    """Stage 3B4C6: correlationId echoed back in response."""
    adapter_mod.HANDLERS['PING'] = lambda p: adapter_mod.handle_ping()
    request = {'type': 'PING', 'correlationId': 'abc-correlation-id-123'}
    sys.stdin = io.StringIO(json.dumps(request) + '\n')
    sys.stdout = io.StringIO()
    adapter_mod.main()
    sys.stdin = sys.__stdin__
    output = sys.stdout.getvalue()
    sys.stdout = sys.__stdout__
    response = json.loads(output)
    assert response.get('correlationId') == 'abc-correlation-id-123', f'correlationId not echoed: {response}'


def test_response_includes_correlation_id_even_on_error():
    """Stage 3B4C6: malformed JSON still produces error response with no correlationId."""
    # Note: malformed JSON has no correlationId to echo, but the dispatcher should
    # still produce a structured error response.
    sys.stdin = io.StringIO('not valid json\n')
    sys.stdout = io.StringIO()
    adapter_mod.main()
    sys.stdin = sys.__stdin__
    output = sys.stdout.getvalue()
    sys.stdout = sys.__stdout__
    response = json.loads(output)
    assert response.get('success') is False
    assert 'Invalid JSON' in response.get('error', '')


def test_payload_non_dict_safely_handled():
    """Stage 3B4C6: payload field that is not a dict is safely replaced with {}."""
    captured = {}
    def fake_analyze(payload):
        captured.update(payload)
        return {'success': True, 'report': None}
    adapter_mod.HANDLERS['CALC'] = lambda p: fake_analyze(p)
    # payload is a string, not a dict — adapter should not crash
    request = {
        'type': 'CALC',
        'correlationId': 'c4',
        'symbol': 'BTC/USDT',
        'payload': 'not-a-dict',
    }
    sys.stdin = io.StringIO(json.dumps(request) + '\n')
    sys.stdout = io.StringIO()
    adapter_mod.main()
    sys.stdin = sys.__stdin__
    sys.stdout = sys.__stdout__
    # Should not crash; symbol from flat field still propagated
    assert captured.get('symbol') == 'BTC/USDT'


def test_ping_does_not_require_payload():
    """Stage 3B4C6: PING request requires no symbol/payload fields."""
    adapter_mod.HANDLERS['PING'] = lambda p: adapter_mod.handle_ping()
    request = {'type': 'PING', 'correlationId': 'p1'}
    sys.stdin = io.StringIO(json.dumps(request) + '\n')
    sys.stdout = io.StringIO()
    adapter_mod.main()
    sys.stdin = sys.__stdin__
    output = sys.stdout.getvalue()
    sys.stdout = sys.__stdout__
    response = json.loads(output)
    assert response.get('success') is True
    assert response.get('pong') is True


def test_unknown_request_type_returns_not_implemented():
    """Stage 3B4C6: unknown request type returns NOT_IMPLEMENTED error."""
    request = {'type': 'UNKNOWN_TYPE', 'correlationId': 'u1', 'payload': {}}
    sys.stdin = io.StringIO(json.dumps(request) + '\n')
    sys.stdout = io.StringIO()
    adapter_mod.main()
    sys.stdin = sys.__stdin__
    output = sys.stdout.getvalue()
    sys.stdout = sys.__stdout__
    response = json.loads(output)
    assert response.get('success') is False
    assert response.get('error') == 'NOT_IMPLEMENTED'
    assert response.get('request_type') == 'UNKNOWN_TYPE'


if __name__ == '__main__':
    # Run all test_ functions
    tests = [
        test_flatten_top_level_symbol,
        test_nested_payload_preserved,
        test_flat_only_request_works,
        test_correlation_id_echoed,
        test_response_includes_correlation_id_even_on_error,
        test_payload_non_dict_safely_handled,
        test_ping_does_not_require_payload,
        test_unknown_request_type_returns_not_implemented,
    ]
    passed = 0
    failed = 0
    for t in tests:
        try:
            # Reload adapter module to get fresh HANDLERS dict each time
            spec2 = importlib.util.spec_from_file_location(
                f'tradingagents_adapter_{t.__name__}',
                str(REPO_ROOT / 'quant_engine' / 'tradingagents_adapter.py'),
            )
            fresh_mod = importlib.util.module_from_spec(spec2)
            spec2.loader.exec_module(fresh_mod)
            # Patch the global name used inside test functions
            # (test functions read module-level `adapter_mod` via closure)
            globals()['adapter_mod'] = fresh_mod
            t()
            print(f'PASS {t.__name__}')
            passed += 1
        except Exception as e:
            print(f'FAIL {t.__name__}: {e}')
            import traceback
            traceback.print_exc()
            failed += 1
    print(f'\nResults: {passed} passed, {failed} failed, {len(tests)} total')
    sys.exit(0 if failed == 0 else 1)
