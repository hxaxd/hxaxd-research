from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.config import Settings
from app.platform.processes import (
    ExecutableIdentity,
    ProcessOutcome,
    ProcessRunner,
    ProcessSpec,
)

PDF2ZH_VERSION = "2.9.0"
BABELDOC_VERSION = "0.6.2"
RAPIDOCR_VERSION = "3.9.2"
PROBE_SCHEMA_VERSION = 1


class PdfPipelineProbeResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    compatible: bool
    pdf2zh_version: str | None = None
    babeldoc_version: str | None = None
    rapidocr_version: str | None = None
    typed_high_level_api: bool = False
    translator_extension: bool = False
    page_coordinates: bool = False
    reading_order: bool = False
    paragraph_boundaries: bool = False
    block_classification: bool = False
    specialized_block_types: bool = False
    true_ocr: bool = False
    ocr_confidence: bool = False
    external_block_translation_injection: bool = False
    translated_pdf_from_external_blocks: bool = False
    message: str = Field(max_length=1000)

    @classmethod
    def unavailable(cls, message: str) -> PdfPipelineProbeResult:
        return cls(compatible=False, message=message)


class PdfPipelineCapabilityProbe:
    """Version-pinned, typed probe for the managed PDF processing environment."""

    def __init__(self, settings: Settings, runner: ProcessRunner) -> None:
        self.settings = settings
        self.runner = runner
        self._cache_key: tuple[int, int, int] | None = None
        self._cached: PdfPipelineProbeResult | None = None

    def get(self, *, refresh: bool = False) -> PdfPipelineProbeResult:
        python = self.settings.pdf2zh_python
        babeldoc = self.settings.babeldoc_executable
        rapidocr = self.settings.rapidocr_package_dir
        if not python.is_file() or not babeldoc.is_file() or rapidocr is None:
            return PdfPipelineProbeResult.unavailable("PDF 处理环境尚未完整安装")
        cache_key = (
            python.stat().st_mtime_ns,
            babeldoc.stat().st_mtime_ns,
            rapidocr.stat().st_mtime_ns,
        )
        if not refresh and cache_key == self._cache_key and self._cached is not None:
            return self._cached
        result = self._run(python)
        self._cache_key = cache_key
        self._cached = result
        return result

    def _run(self, python: Path) -> PdfPipelineProbeResult:
        self.runner.registry.register(
            ExecutableIdentity("pdf-pipeline-probe", python, python.parent)
        )
        self.settings.operation_staging_dir.mkdir(parents=True, exist_ok=True)
        worker = Path(__file__).with_name("capability_probe_worker.py").resolve()
        with tempfile.TemporaryDirectory(
            prefix="pdf-capability-probe-", dir=self.settings.operation_staging_dir
        ) as temporary:
            stage = Path(temporary)
            output = stage / "capabilities.json"
            process = self.runner.run(
                ProcessSpec(
                    executable="pdf-pipeline-probe",
                    argv=(str(worker), "--output", str(output)),
                    cwd=stage,
                    allowed_cwd_root=self.settings.operation_staging_dir,
                    timeout_seconds=30,
                    inherit_environment=(
                        "PATH",
                        "SYSTEMROOT",
                        "WINDIR",
                        "APPDATA",
                        "LOCALAPPDATA",
                        "TEMP",
                        "TMP",
                        "USERPROFILE",
                    ),
                    display_name="PDF pipeline capability probe",
                )
            )
            if process.outcome is ProcessOutcome.TIMED_OUT:
                return PdfPipelineProbeResult.unavailable("PDF 能力探针超时")
            if not process.succeeded:
                return PdfPipelineProbeResult.unavailable("PDF 能力探针执行失败")
            if not output.is_file() or output.stat().st_size > 64 * 1024:
                return PdfPipelineProbeResult.unavailable("PDF 能力探针没有返回有效结果")
            try:
                return PdfPipelineProbeResult.model_validate_json(
                    output.read_text(encoding="utf-8")
                )
            except (OSError, ValueError, json.JSONDecodeError):
                return PdfPipelineProbeResult.unavailable("PDF 能力探针结果不兼容")
