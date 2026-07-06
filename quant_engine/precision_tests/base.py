"""
quant_engine/precision_tests/base.py
精度基准测试基类

TV 对齐流程:
  1. 准备 mock OHLCV 数据（与 TV chart 相同 seed）
  2. Python 端跑指标计算，保存逐 bar 输出
  3. TV 端导出相同数据（用户操作或 API）
  4. 逐 bar diff，最大差值 ≤ 1e-6 才算通过
"""
from typing import Dict, List, Any
import pandas as pd
import numpy as np
from pathlib import Path


class PrecisionTestBase:
    """精度基准测试基类"""
    
    def __init__(self, indicator_name: str, tolerance: float = 1e-6):
        self.indicator_name = indicator_name
        self.tolerance = tolerance
        self.results_dir = Path(__file__).parent.parent / "docs" / "precision_reports"
        self.results_dir.mkdir(parents=True, exist_ok=True)
    
    def generate_mock_data(self, n_bars: int = 200, seed: int = 42) -> pd.DataFrame:
        """生成 deterministic mock OHLCV 数据"""
        np.random.seed(seed)
        close = 100 + np.cumsum(np.random.randn(n_bars) * 0.5)
        high = close + np.abs(np.random.randn(n_bars)) * 0.3
        low = close - np.abs(np.random.randn(n_bars)) * 0.3
        open_ = close + np.random.randn(n_bars) * 0.1
        volume = np.abs(np.random.randn(n_bars) * 1000) + 500
        return pd.DataFrame({
            "open": open_, "high": high, "low": low, "close": close, "volume": volume
        })
    
    def compare_bar_by_bar(self, py_values: List[float], tv_values: List[float]) -> Dict:
        """逐 bar 对比，返回最大差值、均值差值、通过率"""
        if len(py_values) != len(tv_values):
            return {"error": f"长度不匹配: py={len(py_values)} tv={len(tv_values)}"}
        
        diffs = [abs(p - t) for p, t in zip(py_values, tv_values)]
        max_diff = max(diffs)
        mean_diff = sum(diffs) / len(diffs)
        passed = sum(1 for d in diffs if d <= self.tolerance)
        
        return {
            "indicator": self.indicator_name,
            "tolerance": self.tolerance,
            "total_bars": len(py_values),
            "max_diff": round(max_diff, 10),
            "mean_diff": round(mean_diff, 10),
            "passed_bars": passed,
            "pass_rate": f"{passed/len(py_values)*100:.2f}%",
            "status": "PASS" if max_diff <= self.tolerance else "FAIL",
            "failures": [
                {"bar": i, "py": round(p, 6), "tv": round(t, 6), "diff": round(d, 10)}
                for i, (p, t, d) in enumerate(zip(py_values, tv_values, diffs))
                if d > self.tolerance
            ][:10]  # 只保留前 10 个失败 bar
        }
    
    def save_report(self, result: Dict):
        """保存精度报告"""
        report_path = self.results_dir / f"{self.indicator_name}.json"
        with open(report_path, "w") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        return report_path
