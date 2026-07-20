from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from pypdf import PdfReader

from app.core.config import REPOSITORY_ROOT


def _latexmk() -> Path | None:
    windows = REPOSITORY_ROOT / ".tools" / "tex" / "texlive" / "bin" / "windows" / "latexmk.exe"
    if windows.is_file():
        return windows
    for candidate in (REPOSITORY_ROOT / ".tools" / "tex" / "texlive" / "bin").glob("*/latexmk"):
        if candidate.is_file():
            return candidate
    return None


@pytest.mark.skipif(_latexmk() is None, reason="managed TeX tool is not installed")
def test_managed_tex_tool_compiles_a_readable_pdf(tmp_path):
    executable = _latexmk()
    assert executable is not None
    source = Path(__file__).parent / "fixtures" / "tex-source" / "main.tex"
    result = subprocess.run(
        [
            str(executable),
            "-pdf",
            "-interaction=nonstopmode",
            "-halt-on-error",
            f"-outdir={tmp_path}",
            str(source),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
        check=False,
    )
    assert result.returncode == 0, (result.stdout + result.stderr)[-3000:]
    output = tmp_path / "main.pdf"
    assert output.is_file()
    assert len(PdfReader(output, strict=True).pages) == 1
