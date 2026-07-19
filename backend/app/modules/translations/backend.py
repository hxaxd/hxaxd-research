from __future__ import annotations

import os
import subprocess
from pathlib import Path

from app.core.config import Settings
from app.core.errors import TranslationExecutionError
from app.modules.artifacts.models import ArtifactKind


class Pdf2zhBackend:
    def __init__(self, settings: Settings):
        self.settings = settings

    def translate(
        self,
        original: Path,
        output_directory: Path,
        qps: int,
        workers: int,
    ) -> dict[ArtifactKind, Path]:
        if not self.settings.translate_script.is_file():
            raise TranslationExecutionError("PDF2zh 翻译脚本不存在")
        command = [
            "pwsh",
            "-NoProfile",
            "-File",
            str(self.settings.translate_script),
            "-InputPdf",
            str(original),
            "-OutputDir",
            str(output_directory),
            "-Qps",
            str(qps),
            "-Workers",
            str(workers),
        ]
        options: dict[str, object] = {
            "args": command,
            "cwd": str(self.settings.translate_script.parent.parent),
            "capture_output": True,
            "text": True,
            "encoding": "utf-8",
            "errors": "replace",
            "check": False,
            "env": os.environ.copy(),
        }
        if os.name == "nt":
            options["creationflags"] = subprocess.CREATE_NO_WINDOW
        result = subprocess.run(**options)
        if result.returncode != 0:
            output = (result.stderr or result.stdout or "PDF2zh failed").strip()
            raise TranslationExecutionError(output[-2000:])
        generated = {
            ArtifactKind.CHINESE: output_directory / "中文译文.pdf",
            ArtifactKind.BILINGUAL: output_directory / "双语对照.pdf",
        }
        missing = [kind.value for kind, path in generated.items() if not path.is_file()]
        if missing:
            raise TranslationExecutionError(f"PDF2zh 未生成完整译文文件：{', '.join(missing)}")
        return generated
