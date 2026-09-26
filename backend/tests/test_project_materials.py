"""Materials tests: same-name conflicts, duplicate skipping, atomicity."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.projects.errors import ProjectValidationError
from app.projects.materials import add_material, next_free_name, sanitize_material_name


def test_stores_a_new_file_atomically(tmp_path: Path) -> None:
    result = add_material(tmp_path, "paper.pdf", [b"%PDF-1.4 ", b"body"])
    assert result.name == "paper.pdf"
    assert result.size == 13
    assert result.duplicate is False
    assert (tmp_path / "paper.pdf").read_bytes() == b"%PDF-1.4 body"
    assert [p.name for p in tmp_path.iterdir()] == ["paper.pdf"]


def test_identical_content_under_the_same_name_is_a_duplicate(tmp_path: Path) -> None:
    add_material(tmp_path, "paper.pdf", [b"%PDF-1.4 body"])
    result = add_material(tmp_path, "paper.pdf", [b"%PDF-1.4 ", b"body"])
    assert result.duplicate is True
    assert result.name == "paper.pdf"
    assert list(tmp_path.iterdir()) == [tmp_path / "paper.pdf"]


def test_same_name_different_content_is_saved_alongside(tmp_path: Path) -> None:
    add_material(tmp_path, "paper.pdf", [b"first"])
    second = add_material(tmp_path, "paper.pdf", [b"second-content"])
    third = add_material(tmp_path, "paper.pdf", [b"third"])

    assert second.name == "paper (1).pdf"
    assert third.name == "paper (2).pdf"
    assert (tmp_path / "paper.pdf").read_bytes() == b"first"
    assert (tmp_path / "paper (1).pdf").read_bytes() == b"second-content"
    assert not any(p.name.startswith(".") for p in tmp_path.iterdir())


def test_next_free_name_continues_existing_series(tmp_path: Path) -> None:
    (tmp_path / "notes.txt").touch()
    (tmp_path / "notes (1).txt").touch()
    assert next_free_name(tmp_path, "notes.txt") == "notes (2).txt"
    assert next_free_name(tmp_path, "notes (1).txt") == "notes (2).txt"


def test_names_are_reduced_to_safe_basenames() -> None:
    assert sanitize_material_name("../../etc/passwd") == "passwd"
    assert sanitize_material_name("..\\..\\evil.pdf") == "evil.pdf"
    assert sanitize_material_name("  ok.md ") == "ok.md"
    with pytest.raises(ProjectValidationError):
        sanitize_material_name("")
    with pytest.raises(ProjectValidationError):
        sanitize_material_name("..")
    long = "x" * 300 + ".pdf"
    assert len(sanitize_material_name(long)) == 200
    assert sanitize_material_name(long).endswith(".pdf")
