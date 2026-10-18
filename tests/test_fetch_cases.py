"""Local imports must preserve their source, including when paths alias each other."""
import contextlib
import io
from pathlib import Path
import tempfile
import unittest

from scripts.fetch_cases import NEEDED, from_dir


class FromDirTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.source = self.root / "source"
        self.cases = self.source / "cases"
        case = self.cases / "example"
        case.mkdir(parents=True)
        for name in NEEDED:
            (case / name).write_text("source " + name, encoding="utf-8")
        self.raw = self.source / "data" / "raw"
        self.raw.mkdir(parents=True)
        (self.raw / "sample.csv").write_text("id\n1\n", encoding="utf-8")

    def snapshot(self, directory):
        return {str(p.relative_to(directory)): p.read_bytes()
                for p in directory.rglob("*") if p.is_file()}

    def copy(self, source, destination, force=True):
        destination.mkdir(parents=True, exist_ok=True)
        with contextlib.redirect_stdout(io.StringIO()):
            from_dir(str(source), str(destination), force)

    def test_force_import_into_source_preserves_case_and_data(self):
        before = self.snapshot(self.source)
        for source in (self.source, self.cases):
            with self.subTest(source=source):
                self.copy(source, self.cases)
                self.assertEqual(self.snapshot(self.source), before)

    def test_force_import_through_symlink_preserves_source(self):
        alias = self.root / "alias"
        alias.symlink_to(self.source, target_is_directory=True)
        before = self.snapshot(self.source)
        self.copy(self.cases, alias / "cases")
        self.assertEqual(self.snapshot(self.source), before)

    def test_force_import_with_shared_data_directory_preserves_data(self):
        destination = self.source / "imported-cases"
        before = self.snapshot(self.raw)
        self.copy(self.cases, destination)
        self.assertEqual(self.snapshot(destination), self.snapshot(self.cases))
        self.assertEqual(self.snapshot(self.raw), before)

    def test_force_import_with_aliased_data_directory_preserves_data(self):
        target_root = self.root / "target"
        target_root.mkdir()
        (target_root / "data").symlink_to(self.source / "data", target_is_directory=True)
        before = self.snapshot(self.raw)
        self.copy(self.cases, target_root / "cases")
        self.assertEqual(self.snapshot(target_root / "cases"), self.snapshot(self.cases))
        self.assertEqual(self.snapshot(self.raw), before)

    def test_import_to_new_directory_copies_cases_and_data(self):
        destination = self.root / "target" / "cases"
        before = self.snapshot(self.source)
        self.copy(self.source, destination, force=False)
        self.assertEqual(self.snapshot(destination.parent), before)
        self.assertEqual(self.snapshot(self.source), before)

    def test_existing_destination_is_replaced_only_with_force(self):
        destination = self.root / "target" / "cases"
        self.copy(self.source, destination)
        (destination / "example" / "grader.py").write_text("old grader", encoding="utf-8")
        (destination / "example" / "obsolete.txt").write_text("old", encoding="utf-8")
        (destination.parent / "data" / "raw" / "sample.csv").write_text("old data", encoding="utf-8")
        old = self.snapshot(destination.parent)
        source = self.snapshot(self.source)
        self.copy(self.source, destination, force=False)
        self.assertEqual(self.snapshot(destination.parent), old)
        self.copy(self.source, destination)
        self.assertEqual(self.snapshot(destination.parent), source)
        self.assertEqual(self.snapshot(self.source), source)


if __name__ == "__main__":
    unittest.main()
