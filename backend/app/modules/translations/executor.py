from __future__ import annotations

import os
import shutil
import subprocess
import tarfile
import tempfile
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from app.modules.resources.models import ResourceFormat, ResourceRepresentation
from app.modules.resources.repository import SqliteResourceRepository
from app.modules.resources.service import ResourceService
from app.modules.resources.storage import LocalResourceStorage
from app.modules.tools.models import ToolName, ToolStatus
from app.modules.tools.service import ToolService
from app.utils.time import utc_now

from .backend import Pdf2zhBackend
from .models import JobOperation, JobStatus
from .repository import SqliteJobRepository


class ThreadedJobExecutor:
    def __init__(
        self,
        jobs: SqliteJobRepository,
        resources: SqliteResourceRepository,
        storage: LocalResourceStorage,
        registrar: ResourceService,
        backend: Pdf2zhBackend,
        tools: ToolService,
    ):
        self.jobs = jobs
        self.resources = resources
        self.storage = storage
        self.registrar = registrar
        self.backend = backend
        self.tools = tools
        self.pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="resource-job")

    def submit(self, job_id: str) -> None:
        self.pool.submit(self._run, job_id)

    def shutdown(self) -> None:
        self.pool.shutdown(wait=False, cancel_futures=False)

    def _run(self, job_id: str) -> None:
        job = self.jobs.get(job_id)
        running = job.model_copy(
            update={
                "status": JobStatus.RUNNING,
                "progress": 10,
                "message": "正在编译" if job.operation == JobOperation.COMPILE else "正在翻译",
                "started_at": utc_now(),
            }
        )
        self.jobs.save(running)
        try:
            if running.operation == JobOperation.COMPILE:
                log_excerpt, version = self._compile(running.id, running.input_resource_id)
            else:
                log_excerpt, version = self._translate(
                    running.id, running.input_resource_id, running.options
                )
            self.jobs.save(
                running.model_copy(
                    update={
                        "status": JobStatus.SUCCEEDED,
                        "progress": 100,
                        "tool_version": version,
                        "message": "编译完成"
                        if running.operation == JobOperation.COMPILE
                        else "翻译完成",
                        "log_excerpt": log_excerpt,
                        "error_summary": None,
                        "finished_at": utc_now(),
                    }
                )
            )
        except Exception as error:
            self.jobs.save(
                running.model_copy(
                    update={
                        "status": JobStatus.FAILED,
                        "progress": 100,
                        "message": "编译失败"
                        if running.operation == JobOperation.COMPILE
                        else "翻译失败",
                        "error_summary": str(error)[-2000:],
                        "finished_at": utc_now(),
                    }
                )
            )

    def _compile(self, job_id: str, resource_id: str | None) -> tuple[str, str | None]:
        if resource_id is None:
            raise ValueError("compile job has no input resource")
        resource = self.resources.get(resource_id)
        if resource.format != ResourceFormat.TEX:
            raise ValueError("compile input is not TeX")
        tool = self.tools.get(ToolName.TEX)
        if tool.status != ToolStatus.INSTALLED or not tool.executable_path:
            raise RuntimeError("TeX 编译环境尚未就绪")
        archive_path = self.storage.resolve(self.resources.relative_path(resource_id))
        with tempfile.TemporaryDirectory(prefix="tex-compile-") as temporary:
            stage = Path(temporary)
            source_dir = stage / "source"
            output_dir = stage / "output"
            source_dir.mkdir()
            output_dir.mkdir()
            self._extract(archive_path, source_dir)
            main = self._find_main_tex(source_dir)
            command = [
                tool.executable_path,
                "-pdf",
                "-interaction=nonstopmode",
                "-halt-on-error",
                f"-outdir={output_dir}",
                main.name,
            ]
            options: dict[str, object] = {
                "args": command,
                "cwd": str(main.parent),
                "capture_output": True,
                "text": True,
                "encoding": "utf-8",
                "errors": "replace",
                "timeout": 180,
                "check": False,
            }
            if os.name == "nt":
                options["creationflags"] = subprocess.CREATE_NO_WINDOW
            result = subprocess.run(**options)
            log = ((result.stdout or "") + "\n" + (result.stderr or ""))[-4000:]
            pdf = output_dir / f"{main.stem}.pdf"
            if result.returncode != 0 or not pdf.is_file():
                raise RuntimeError(f"latexmk 退出码 {result.returncode}: {log[-1800:]}")
            generated = stage / "compiled.pdf"
            shutil.copyfile(pdf, generated)
            self.registrar.register_generated(
                resource.paper_id,
                generated,
                f"{main.stem}.pdf",
                ResourceRepresentation.ORIGINAL,
                resource.id,
                job_id,
            )
            return log, tool.version

    def _translate(
        self, job_id: str, resource_id: str | None, options: dict
    ) -> tuple[str | None, str | None]:
        if resource_id is None:
            raise ValueError("translate job has no input resource")
        resource = self.resources.get(resource_id)
        original = self.storage.resolve(self.resources.relative_path(resource_id))
        tool = self.tools.get(ToolName.PDF2ZH)
        with tempfile.TemporaryDirectory(prefix="pdf-translate-") as temporary:
            output_dir = Path(temporary)
            generated = self.backend.translate(
                original,
                output_dir,
                int(options.get("qps", 4)),
                int(options.get("workers", 4)),
            )
            for representation, path in generated.items():
                self.registrar.register_generated(
                    resource.paper_id,
                    path,
                    path.name,
                    representation,
                    resource.id,
                    job_id,
                )
        return None, tool.version

    @staticmethod
    def _extract(archive_path: Path, target: Path) -> None:
        LocalResourceStorage._validate_tex_archive(archive_path)
        if zipfile.is_zipfile(archive_path):
            with zipfile.ZipFile(archive_path) as archive:
                archive.extractall(target)
        else:
            with tarfile.open(archive_path) as archive:
                archive.extractall(target, filter="data")

    @staticmethod
    def _find_main_tex(source_dir: Path) -> Path:
        candidates = []
        for path in source_dir.rglob("*.tex"):
            try:
                content = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if "\\documentclass" in content and "\\begin{document}" in content:
                candidates.append(path)
        if not candidates:
            raise RuntimeError("TeX 源码包中没有可识别的主文档")
        candidates.sort(
            key=lambda item: (item.name.lower() != "main.tex", len(item.parts), item.name)
        )
        return candidates[0]
