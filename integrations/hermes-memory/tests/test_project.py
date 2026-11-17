from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


def _load_provider():
    path = Path(__file__).parents[1] / "__init__.py"
    spec = importlib.util.spec_from_file_location("comem_hermes_project_provider", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(cwd), *args],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def _init_repository(path: Path) -> None:
    path.mkdir(parents=True)
    _git(path, "init", "-q")
    _git(path, "config", "user.email", "fixture@example.invalid")
    _git(path, "config", "user.name", "Fixture")


class ProjectResolutionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.module = _load_provider()
        cls.vectors = json.loads(
            (Path(__file__).parents[2] / "tests" / "project-vectors.json").read_text(
                encoding="utf-8"
            )
        )

    def test_shared_cross_language_vectors(self) -> None:
        for vector in self.vectors["explicit"]:
            self.assertEqual(
                self.module.normalize_explicit_project_id(vector["input"]),
                vector["expected"],
            )
        for vector in self.vectors["remote"]:
            identity = self.module.normalize_remote_identity(vector["input"])
            self.assertEqual(identity, vector["identity"])
            self.assertEqual(
                self.module.project_id_from_remote_identity(identity),
                vector["projectId"],
            )
        for vector in self.vectors["root"]:
            self.assertEqual(
                self.module.project_id_from_git_root(vector["path"]),
                vector["projectId"],
            )

    def test_remote_forms_match_without_credentials(self) -> None:
        project_ids = [
            self.module.project_id_from_remote_identity(
                self.module.normalize_remote_identity(vector["input"])
            )
            for vector in self.vectors["remote"][:3]
        ]
        self.assertEqual(len(set(project_ids)), 1)
        self.assertNotIn("fixture-token", project_ids[0])
        self.assertNotIn("access_token", project_ids[0])

    def test_explicit_config_wins_and_invalid_config_does_not_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory) / "repo"
            nested = repo / "src" / "feature"
            _init_repository(repo)
            _git(repo, "remote", "add", "origin", "https://github.com/acme/rocket.git")
            nested.mkdir(parents=True)
            config = repo / "src" / ".comem" / "config.json"
            config.parent.mkdir()
            config.write_text(
                json.dumps({"version": 1, "project": {"id": "explicit-project"}}),
                encoding="utf-8",
            )
            self.assertEqual(self.module.resolve_project_id(str(nested)), "explicit-project")
            config.write_text(
                json.dumps({"version": 1, "project": {"id": "../escape"}}),
                encoding="utf-8",
            )
            with self.assertRaises(self.module.ProjectConfigError) as raised:
                self.module.resolve_project_id(str(nested))
            self.assertEqual(raised.exception.code, "PROJECT_CONFIG_INVALID")
            self.assertIn("project.id", str(raised.exception))
            self.assertNotIn("../escape", str(raised.exception))
            self.assertNotIn(str(config), str(raised.exception))

    def test_clone_worktree_subdir_and_root_hash(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            repo = base / "repo"
            _init_repository(repo)
            _git(repo, "remote", "add", "origin", "git@github.com:Acme/Rocket.git")
            _git(repo, "commit", "--allow-empty", "-m", "fixture")
            nested = repo / "nested" / "deeper"
            nested.mkdir(parents=True)
            expected = self.vectors["remote"][0]["projectId"]
            self.assertEqual(self.module.resolve_project_id(str(repo)), expected)
            self.assertEqual(self.module.resolve_project_id(str(nested)), expected)

            clone = base / "clone"
            worktree = base / "worktree"
            subprocess.run(
                ["git", "clone", "-q", str(repo), str(clone)],
                check=True,
                capture_output=True,
                text=True,
            )
            _git(clone, "remote", "set-url", "origin", "ssh://git@github.com/acme/rocket.git")
            _git(repo, "worktree", "add", "-q", str(worktree), "-b", "fixture-worktree")
            self.assertEqual(self.module.resolve_project_id(str(clone)), expected)
            self.assertEqual(self.module.resolve_project_id(str(worktree)), expected)

            first = base / "first" / "same-name"
            second = base / "second" / "same-name"
            _init_repository(first)
            _init_repository(second)
            first_id = self.module.resolve_project_id(str(first))
            second_id = self.module.resolve_project_id(str(second))
            self.assertRegex(first_id, r"^root-[0-9a-f]{16}$")
            self.assertRegex(second_id, r"^root-[0-9a-f]{16}$")
            self.assertNotEqual(first_id, second_id)

    def test_no_git_has_no_project_and_long_id_fits_segment_limit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            self.assertIsNone(self.module.resolve_project_id(directory))
        identity = self.module.normalize_remote_identity(
            f"https://example.com/owner/{'very-long-repository-name-' * 20}.git"
        )
        project_id = self.module.project_id_from_remote_identity(identity)
        self.assertLessEqual(len(project_id.encode("utf-8")), 255)
        self.assertTrue(project_id.startswith("remote-example.com-owner-"))


if __name__ == "__main__":
    unittest.main()
