import unittest

from src.targets import normalize_targets


class NormalizeTargetsTests(unittest.TestCase):
    def test_trims_and_removes_duplicates(self) -> None:
        self.assertEqual(
            normalize_targets([" src/main.py ", "tests/test_main.py", "src/main.py"]),
            ["src/main.py", "tests/test_main.py"],
        )

    def test_ignores_empty_values(self) -> None:
        self.assertEqual(normalize_targets(["", "  ", "src/main.py"]), ["src/main.py"])
