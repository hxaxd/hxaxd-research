from __future__ import annotations

import subprocess
from pathlib import Path

from app.modules.resources.models import ResourceRepresentation
from app.modules.translations.backend import Pdf2zhBackend
from tests.sample_data import PDF


def test_translation_runs_pdf2zh_directly_and_commits_outputs(
    app_settings,
    tmp_path,
    monkeypatch,
):
    executable = app_settings.pdf2zh_executable
    executable.parent.mkdir(parents=True)
    executable.touch()
    original = tmp_path / "original.pdf"
    original.write_bytes(PDF)
    output_directory = tmp_path / "output"
    output_directory.mkdir()
    (output_directory / "中文译文.pdf").write_bytes(b"old mono")
    (output_directory / "双语对照.pdf").write_bytes(b"old dual")
    observed_command: list[str] = []

    def fake_run(**options):
        command = options["args"]
        observed_command.extend(command)
        stage = Path(command[command.index("--output") + 1])
        (stage / "paper.mono.pdf").write_bytes(PDF + b" mono")
        (stage / "paper.dual.pdf").write_bytes(PDF + b" dual")
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setenv("PDF2ZH_DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(subprocess, "run", fake_run)

    result = Pdf2zhBackend(app_settings).translate(original, output_directory, 4, 3)

    assert observed_command[0] == str(executable)
    assert "pwsh" not in observed_command
    assert observed_command[observed_command.index("--qps") + 1] == "4"
    assert observed_command[observed_command.index("--pool-max-workers") + 1] == "3"
    assert result == {
        ResourceRepresentation.TRANSLATED: output_directory / "中文译文.pdf",
        ResourceRepresentation.BILINGUAL: output_directory / "双语对照.pdf",
    }
    assert result[ResourceRepresentation.TRANSLATED].read_bytes().endswith(b" mono")
    assert result[ResourceRepresentation.BILINGUAL].read_bytes().endswith(b" dual")
