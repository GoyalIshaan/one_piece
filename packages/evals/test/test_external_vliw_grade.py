"""Regression tests for the VLIW adapter's handling of list and dict sort keys."""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ADAPTER = Path(__file__).resolve().parents[1] / "analysis/external-vliw-grade.py"


class VliwSortKeyTests(unittest.TestCase):
    def assemble(self, temporary, body):
        root = Path(temporary)
        source, candidate = root / "upstream", root / "candidate"
        (source / "tests").mkdir(parents=True)
        candidate.mkdir()
        (source / "problem.py").write_text("")
        (source / "perf_takehome.py").write_text(
            'class KernelBuilder:\n    def build_kernel(self):\n'
            '        """\n        Like reference_kernel2\n        """\n\nBASELINE = 0\n'
        )
        (candidate / "body.py").write_text(body)
        result = subprocess.run(
            [sys.executable, "-B", str(ADAPTER), str(source), str(candidate)],
            capture_output=True, text=True
        )
        return result, candidate

    def test_inline_and_named_sort_keys(self):
        body = """
ranks = [20, 1, 12]
indices = [0, 1, 2]
indices.sort(key=ranks.__getitem__)
table = {i: -i for i in indices}
lookup = table.__getitem__
self.instrs = [indices, sorted(indices, key=lookup), lookup(2)]
"""
        with tempfile.TemporaryDirectory() as t:
            result, path = self.assemble(t, body)
            self.assertEqual(result.returncode, 0, result.stderr)
            namespace = {}
            exec((path / "perf_takehome.py").read_text(), namespace)
            builder = namespace["KernelBuilder"]()
            builder.build_kernel()
            self.assertEqual(builder.instrs, [[1, 2, 0], [2, 1, 0], -2])

    def test_other_special_attributes_and_unknown_receivers_remain_rejected(self):
        for body in (
            "ranks = [1]\nvalue = ranks.__class__",
            "value = self.__getitem__",
            "ranks = [1]\nranks.__getitem__ = None",
        ):
            with self.subTest(body=body), tempfile.TemporaryDirectory() as t:
                result, _ = self.assemble(t, body)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Unsupported kernel attribute", result.stderr)


if __name__ == "__main__":
    unittest.main()
