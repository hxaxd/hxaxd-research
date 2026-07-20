from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

from app.core.config import Settings
from app.core.errors import TranslationExecutionError
from app.modules.resources.models import ResourceRepresentation


class Pdf2zhBackend:
    def __init__(self, settings: Settings):
        self.settings = settings

    def translate(
        self,
        original: Path,
        output_directory: Path,
        qps: int,
        workers: int,
    ) -> dict[ResourceRepresentation, Path]:
        executable = self.settings.pdf2zh_executable
        if not executable.is_file():
            raise TranslationExecutionError("PDF2zh 尚未安装，请先在工作台首页完成安装")
        if not os.environ.get("PDF2ZH_DEEPSEEK_API_KEY", "").strip():
            raise TranslationExecutionError("后端没有读取到 PDF2ZH_DEEPSEEK_API_KEY")
        self._validate_pdf(original, "原文")
        output_directory.mkdir(parents=True, exist_ok=True)

        with tempfile.TemporaryDirectory(prefix=".pdf2zh-", dir=output_directory) as temporary:
            stage = Path(temporary)
            log_path = stage / "pdf2zh.log"
            command = [
                str(executable),
                str(original),
                "--output",
                str(stage),
                "--deepseek",
                "--deepseek-model",
                "deepseek-v4-flash",
                "--deepseek-thinking-mode",
                "disabled",
                "--lang-in",
                "en",
                "--lang-out",
                "zh-CN",
                "--watermark-output-mode",
                "no_watermark",
                "--qps",
                str(qps),
                "--pool-max-workers",
                str(workers),
            ]
            options: dict[str, object] = {
                "args": command,
                "cwd": str(self.settings.tools_dir.parent),
                "stderr": subprocess.STDOUT,
                "check": False,
                "env": os.environ.copy(),
            }
            if os.name == "nt":
                options["creationflags"] = subprocess.CREATE_NO_WINDOW
            try:
                with log_path.open("w", encoding="utf-8", errors="replace") as log:
                    result = subprocess.run(stdout=log, **options)
            except OSError as error:
                raise TranslationExecutionError(f"无法启动 PDF2zh：{error}") from error
            if result.returncode != 0:
                raise TranslationExecutionError(
                    f"PDF2zh 退出码 {result.returncode}：{self._log_tail(log_path)}"
                )

            mono_files = list(stage.rglob("*.mono.pdf"))
            dual_files = list(stage.rglob("*.dual.pdf"))
            if len(mono_files) != 1 or len(dual_files) != 1:
                raise TranslationExecutionError(
                    f"PDF2zh 输出数量异常：mono={len(mono_files)}, dual={len(dual_files)}"
                )
            self._validate_pdf(mono_files[0], "中文译文")
            self._validate_pdf(dual_files[0], "双语译文")
            targets = {
                ResourceRepresentation.TRANSLATED: output_directory / "中文译文.pdf",
                ResourceRepresentation.BILINGUAL: output_directory / "双语对照.pdf",
            }
            self._commit_outputs(
                {
                    ResourceRepresentation.TRANSLATED: mono_files[0],
                    ResourceRepresentation.BILINGUAL: dual_files[0],
                },
                targets,
                stage,
            )
            return targets

    @staticmethod
    def _validate_pdf(path: Path, label: str) -> None:
        if not path.is_file() or path.stat().st_size <= 4:
            raise TranslationExecutionError(f"{label}不是有效 PDF")
        with path.open("rb") as stream:
            if stream.read(4) != b"%PDF":
                raise TranslationExecutionError(f"{label}缺少 PDF 文件头")

    @staticmethod
    def _log_tail(path: Path) -> str:
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return "没有可读取的日志"
        return "\n".join(lines[-40:])[-2000:]

    @staticmethod
    def _commit_outputs(
        sources: dict[ResourceRepresentation, Path],
        targets: dict[ResourceRepresentation, Path],
        backup_directory: Path,
    ) -> None:
        backups: dict[ResourceRepresentation, Path] = {}
        committed: list[ResourceRepresentation] = []
        try:
            for kind, target in targets.items():
                if target.exists():
                    backup = backup_directory / f"previous-{kind.value}.pdf"
                    target.replace(backup)
                    backups[kind] = backup
            for kind, source in sources.items():
                source.replace(targets[kind])
                committed.append(kind)
        except Exception as error:
            for kind in committed:
                targets[kind].unlink(missing_ok=True)
            for kind, backup in backups.items():
                if backup.exists():
                    backup.replace(targets[kind])
            raise TranslationExecutionError(f"提交译文文件失败：{error}") from error
