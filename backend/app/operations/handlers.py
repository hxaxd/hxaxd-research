from __future__ import annotations

import ipaddress
import os
import shutil
import socket
import tarfile
import tempfile
import urllib.request
import zipfile
from collections.abc import Callable, Iterator
from contextlib import contextmanager, suppress
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlparse
from uuid import uuid4

from pydantic import BaseModel, ValidationError

from app.core.config import Settings
from app.jobs.models import JobAttachment, JobExecutionResult, JobFailure
from app.jobs.scheduler import JobExecutionContext, JobRegistry
from app.library.models import (
    Attachment,
    AttachmentFormat,
    AttachmentOrigin,
    AttachmentType,
    GeneratedAttachment,
    LanguageMode,
)
from app.library.service import AttachmentService
from app.platform.processes import (
    ExecutableIdentity,
    ProcessLogEvent,
    ProcessOutcome,
    ProcessRunner,
    ProcessSpec,
)

from .models import (
    AttachmentDownloadJobInput,
    CompileJobInput,
    TranslationJobInput,
)

PDF2ZH_VERSION = "2.9.0"
TEX_REPOSITORY = "https://mirror.ctan.org/systems/texlive/tlnet"
TEX_INSTALLER_URL = f"{TEX_REPOSITORY}/install-tl.zip"
MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_ARCHIVE_MEMBER_BYTES = 64 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 20_000
MAX_COMPRESSION_RATIO = 1000


class OperationHandlers:
    def __init__(
        self,
        settings: Settings,
        attachments: AttachmentService,
        runner: ProcessRunner,
    ) -> None:
        self.settings = settings
        self.attachments = attachments
        self.runner = runner

    def register(self, registry: JobRegistry) -> None:
        registry.register("attachment.download", self.download)
        registry.register("attachment.compile", self.compile)
        registry.register("attachment.translate", self.translate)
        registry.register("tool.install.pdf2zh", self.install_pdf2zh)
        registry.register("tool.install.tex", self.install_tex)
        registry.register("tool.verify.pdf2zh", self.verify_pdf2zh)
        registry.register("tool.verify.tex", self.verify_tex)

    def download(self, context: JobExecutionContext) -> JobExecutionResult:
        request = _validated_input(AttachmentDownloadJobInput, context.claimed.job.input)
        item_id = request.item_id
        prior = self.attachments.outputs_for_job(context.claimed.job.id, ["output"])
        if "output" in prior:
            context.emit(
                "download.reused",
                {"attachment_id": prior["output"].id},
                "info",
            )
            return _attachment_result(context, [prior["output"]], roles=["output"])
        with self._stage("download") as stage:
            filename = request.filename or _url_filename(str(request.url))
            target = stage / "download"
            context.emit("download.started", {"url": str(request.url)}, "info")
            _download_https(
                str(request.url),
                target,
                cancellation=lambda: context.cancellation.is_cancelled,
            )
            if context.cancellation.is_cancelled:
                raise JobFailure("canceled", "下载已取消", retryable=True)
            attachment = self.attachments.register_generated_batch(
                item_id,
                [
                    (
                        target,
                        GeneratedAttachment(
                            filename=filename,
                            attachment_type=request.attachment_type,
                            language_mode=request.language_mode,
                            origin=request.origin,
                            source_url=str(request.url),
                            preferred_for=request.preferred_for,
                        ),
                    )
                ],
                parent_attachment_id=None,
                job_id=context.claimed.job.id,
                operation_roles=["output"],
            )[0]
        context.emit(
            "download.completed",
            {"attachment_id": attachment.id, "bytes": attachment.size},
            "info",
        )
        return _attachment_result(context, [attachment], roles=["output"])

    def compile(self, context: JobExecutionContext) -> JobExecutionResult:
        request = _validated_input(CompileJobInput, context.claimed.job.input)
        input_id = request.attachment_id
        source, archive_path = self.attachments.locate(input_id)
        if request.item_id != source.item_id:
            raise JobFailure("subject_mismatch", "任务中的文献与源码附件不一致")
        if (
            source.attachment_type is not AttachmentType.SOURCE_ARCHIVE
            or source.format is not AttachmentFormat.TEX
        ):
            raise JobFailure("invalid_attachment", "只有 TeX 源码附件可以编译")
        prior = self.attachments.outputs_for_job(context.claimed.job.id, ["output"])
        if "output" in prior:
            context.emit(
                "compile.reused",
                {"attachment_id": prior["output"].id},
                "info",
            )
            return _attachment_result(
                context,
                [prior["output"]],
                roles=["output"],
                input_attachment=source,
            )
        executable = self._tex_executable()
        if executable is None:
            raise JobFailure("tool_missing", "TeX 编译环境尚未安装")
        self.runner.registry.register(
            ExecutableIdentity("latexmk", executable, executable.parent)
        )
        with self._stage("compile") as stage:
            source_dir = stage / "source"
            output_dir = stage / "output"
            source_dir.mkdir()
            output_dir.mkdir()
            _extract_archive(
                archive_path,
                source_dir,
                cancellation=lambda: context.cancellation.is_cancelled,
            )
            main = _select_main_tex(source_dir, request.main_tex)
            spec = ProcessSpec(
                executable="latexmk",
                argv=(
                    "-pdf",
                    "-interaction=nonstopmode",
                    "-halt-on-error",
                    "-no-shell-escape",
                    f"-outdir={output_dir}",
                    f"./{main.name}",
                ),
                cwd=main.parent,
                allowed_cwd_root=source_dir,
                timeout_seconds=600,
                inherit_environment=(
                    "PATH",
                    "SYSTEMROOT",
                    "WINDIR",
                    "TEMP",
                    "TMP",
                ),
                display_name="latexmk",
            )
            result = self.runner.run(
                spec,
                cancellation=context.cancellation,
                observer=_log_observer(context),
            )
            context.record_process(result.pid, "latexmk", result.returncode)
            pdf = output_dir / f"{main.stem}.pdf"
            _require_success(result, pdf, "TeX 编译")
            _require_safe_output(pdf, output_dir)
            _raise_if_cancelled(context, "TeX 编译")
            attachment = self.attachments.register_generated_batch(
                source.item_id,
                [
                    (
                        pdf,
                        GeneratedAttachment(
                            filename=f"{main.stem}.pdf",
                            language_mode=LanguageMode.ORIGINAL,
                            origin=AttachmentOrigin.GENERATED,
                            preferred_for=["pdf:original"],
                        ),
                    )
                ],
                parent_attachment_id=source.id,
                job_id=context.claimed.job.id,
                operation_roles=["output"],
            )[0]
        return _attachment_result(
            context,
            [attachment],
            roles=["output"],
            input_attachment=source,
        )

    def translate(self, context: JobExecutionContext) -> JobExecutionResult:
        request = _validated_input(TranslationJobInput, context.claimed.job.input)
        input_id = request.attachment_id
        source, source_path = self.attachments.locate(input_id)
        if request.item_id != source.item_id:
            raise JobFailure("subject_mismatch", "任务中的文献与 PDF 附件不一致")
        if (
            source.attachment_type is not AttachmentType.FULLTEXT
            or source.format is not AttachmentFormat.PDF
            or source.language_mode is not LanguageMode.ORIGINAL
        ):
            raise JobFailure("invalid_attachment", "只有原文 PDF 全文附件可以翻译")
        roles = ["translated", "bilingual"]
        prior = self.attachments.outputs_for_job(context.claimed.job.id, roles)
        if len(prior) == len(roles):
            context.emit(
                "translate.reused",
                {"attachment_ids": [prior[role].id for role in roles]},
                "info",
            )
            return _attachment_result(
                context,
                [prior[role] for role in roles],
                roles=roles,
                input_attachment=source,
            )
        executable = self.settings.pdf2zh_executable
        if not executable.is_file():
            raise JobFailure("tool_missing", "PDF2zh 尚未安装")
        api_key = os.environ.get("PDF2ZH_DEEPSEEK_API_KEY", "").strip()
        if not api_key:
            raise JobFailure("credential_missing", "没有配置 PDF2ZH_DEEPSEEK_API_KEY")
        self.runner.registry.register(
            ExecutableIdentity("pdf2zh", executable, executable.parent)
        )
        with self._stage("translate") as stage:
            output_dir = stage / "output"
            output_dir.mkdir()
            spec = ProcessSpec(
                executable="pdf2zh",
                argv=(
                    str(source_path),
                    "--output",
                    str(output_dir),
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
                    str(request.qps),
                    "--pool-max-workers",
                    str(request.workers),
                ),
                cwd=stage,
                allowed_cwd_root=self.settings.operation_staging_dir,
                timeout_seconds=7_200,
                environment={"PDF2ZH_DEEPSEEK_API_KEY": api_key},
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
                sensitive_values=(api_key,),
                display_name="pdf2zh",
            )
            result = self.runner.run(
                spec,
                cancellation=context.cancellation,
                observer=_log_observer(context),
            )
            context.record_process(result.pid, "pdf2zh", result.returncode)
            _require_success(result, None, "PDF 翻译")
            mono = list(output_dir.rglob("*.mono.pdf"))
            dual = list(output_dir.rglob("*.dual.pdf"))
            if len(mono) != 1 or len(dual) != 1:
                raise JobFailure(
                    "unexpected_output",
                    f"PDF2zh 输出数量异常：mono={len(mono)}, dual={len(dual)}",
                )
            _require_safe_output(mono[0], output_dir)
            _require_safe_output(dual[0], output_dir)
            _raise_if_cancelled(context, "PDF 翻译")
            generated = self.attachments.register_generated_batch(
                source.item_id,
                [
                    (
                        mono[0],
                        GeneratedAttachment(
                            filename="中文译文.pdf",
                            language_mode=LanguageMode.TRANSLATED,
                            origin=AttachmentOrigin.GENERATED,
                            preferred_for=["pdf:translated"],
                        ),
                    ),
                    (
                        dual[0],
                        GeneratedAttachment(
                            filename="双语对照.pdf",
                            language_mode=LanguageMode.BILINGUAL,
                            origin=AttachmentOrigin.GENERATED,
                            preferred_for=["pdf:bilingual"],
                        ),
                    ),
                ],
                parent_attachment_id=source.id,
                job_id=context.claimed.job.id,
                operation_roles=["translated", "bilingual"],
            )
        return _attachment_result(
            context,
            generated,
            roles=["translated", "bilingual"],
            input_attachment=source,
        )

    def install_pdf2zh(self, context: JobExecutionContext) -> JobExecutionResult:
        uv = shutil.which("uv")
        if not uv:
            raise JobFailure("installer_missing", "没有找到 uv")
        uv_path = Path(uv).resolve()
        self.runner.registry.register(ExecutableIdentity("uv", uv_path, uv_path.parent))
        self.settings.tools_dir.mkdir(parents=True, exist_ok=True)
        with self._tool_stage("pdf2zh-install") as stage:
            candidate = stage / "pdf2zh"
            candidate.mkdir()
            virtual_environment = candidate / ".venv"
            self._run_installer(
                context,
                "uv",
                ("venv", "--python", "3.12", str(virtual_environment)),
                timeout=600,
            )
            python = _virtual_environment_python(virtual_environment)
            if not python.is_file():
                raise JobFailure("installation_incomplete", "uv 没有创建 Python 环境")
            self._run_installer(
                context,
                "uv",
                (
                    "pip",
                    "install",
                    "--python",
                    str(python),
                    "--upgrade",
                    f"pdf2zh-next=={PDF2ZH_VERSION}",
                ),
                timeout=1_800,
            )
            if not _pdf2zh_executable_at(candidate).is_file():
                raise JobFailure("installation_incomplete", "PDF2zh 安装后未找到可执行文件")
            _raise_if_cancelled(context, "PDF2zh 安装")
            _activate_tool_directory(candidate, self.settings.pdf2zh_dir)
        if not self.settings.pdf2zh_executable.is_file():
            raise JobFailure("installation_incomplete", "PDF2zh 安装后未找到可执行文件")
        return JobExecutionResult(
            result={"tool": "pdf2zh", "version": PDF2ZH_VERSION},
            commit_point_reached=True,
        )

    def install_tex(self, context: JobExecutionContext) -> JobExecutionResult:
        executable = self._tex_executable()
        if executable is not None:
            return JobExecutionResult(result={"tool": "tex", "ready": True})
        if os.name != "nt":
            raise JobFailure("unsupported_platform", "TeX 自动安装目前只支持 Windows")
        if not str(self.settings.tex_dir).isascii():
            raise JobFailure("unsafe_install_path", "TeX 安装路径必须只包含 ASCII 字符")
        cmd = Path(os.environ.get("COMSPEC", "C:/Windows/System32/cmd.exe")).resolve()
        if not cmd.is_file():
            raise JobFailure("installer_missing", "没有找到 cmd.exe")
        self.runner.registry.register(ExecutableIdentity("cmd", cmd, cmd.parent))
        self.settings.tools_dir.mkdir(parents=True, exist_ok=True)
        with self._tool_stage("tex-install") as stage:
            candidate = stage / "tex"
            candidate.mkdir()
            tex_root = candidate / "texlive"
            archive_path = stage / "install-tl.zip"
            _download_https(
                TEX_INSTALLER_URL,
                archive_path,
                cancellation=lambda: context.cancellation.is_cancelled,
                max_bytes=256 * 1024 * 1024,
            )
            installer_dir = stage / "installer"
            installer_dir.mkdir()
            _extract_zip_safely(
                archive_path,
                installer_dir,
                cancellation=lambda: context.cancellation.is_cancelled,
            )
            installer = next(installer_dir.rglob("install-tl-windows.bat"), None)
            if installer is None:
                raise JobFailure("invalid_installer", "TeX 安装包缺少安装脚本")
            profile = stage / "texlive.profile"
            profile.write_text(_tex_profile(tex_root), encoding="utf-8")
            install_line = (
                f'"{installer}" -profile "{profile}" -repository "{TEX_REPOSITORY}"'
            )
            self._run_installer(
                context,
                "cmd",
                ("/d", "/s", "/c", install_line),
                timeout=10_800,
                cwd=installer_dir,
            )
            tlmgr = tex_root / "bin" / "windows" / "tlmgr.bat"
            if not tlmgr.is_file():
                raise JobFailure("installation_incomplete", "TeX 安装后未找到 tlmgr")
            package_line = (
                f'"{tlmgr}" install latexmk collection-latexrecommended '
                "collection-latexextra collection-fontsrecommended collection-bibtexextra"
            )
            self._run_installer(
                context,
                "cmd",
                ("/d", "/s", "/c", package_line),
                timeout=10_800,
                cwd=installer_dir,
            )
            if _tex_executable_at(candidate) is None:
                raise JobFailure("installation_incomplete", "TeX 安装后未找到 latexmk")
            _raise_if_cancelled(context, "TeX 安装")
            _activate_tool_directory(candidate, self.settings.tex_dir)
        if self._tex_executable() is None:
            raise JobFailure("installation_incomplete", "TeX 安装后未找到 latexmk")
        return JobExecutionResult(
            result={"tool": "tex", "ready": True},
            commit_point_reached=True,
        )

    def verify_pdf2zh(self, _: JobExecutionContext) -> JobExecutionResult:
        if not self.settings.pdf2zh_executable.is_file():
            raise JobFailure("tool_missing", "PDF2zh 尚未安装")
        return JobExecutionResult(result={"tool": "pdf2zh", "ready": True})

    def verify_tex(self, _: JobExecutionContext) -> JobExecutionResult:
        if self._tex_executable() is None:
            raise JobFailure("tool_missing", "TeX 尚未安装")
        return JobExecutionResult(result={"tool": "tex", "ready": True})

    def _run_installer(
        self,
        context: JobExecutionContext,
        executable: str,
        argv: tuple[str, ...],
        *,
        timeout: float,
        cwd: Path | None = None,
    ) -> None:
        result = self.runner.run(
            ProcessSpec(
                executable=executable,
                argv=argv,
                cwd=cwd or self.settings.tools_dir,
                allowed_cwd_root=(cwd or self.settings.tools_dir),
                timeout_seconds=timeout,
                inherit_environment=(
                    "PATH",
                    "PATHEXT",
                    "SYSTEMROOT",
                    "WINDIR",
                    "COMSPEC",
                    "APPDATA",
                    "LOCALAPPDATA",
                    "TEMP",
                    "TMP",
                    "USERPROFILE",
                ),
            ),
            cancellation=context.cancellation,
            observer=_log_observer(context),
        )
        context.record_process(result.pid, executable, result.returncode)
        _require_success(result, None, f"{executable} 安装步骤")

    def _tex_executable(self) -> Path | None:
        return _tex_executable_at(self.settings.tex_dir)

    @contextmanager
    def _stage(self, prefix: str) -> Iterator[Path]:
        self.settings.operation_staging_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix=f"{prefix}-", dir=self.settings.operation_staging_dir
        ) as temporary:
            yield Path(temporary)

    @contextmanager
    def _tool_stage(self, prefix: str) -> Iterator[Path]:
        root = self.settings.tools_dir / ".staging"
        root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=f"{prefix}-", dir=root) as temporary:
            yield Path(temporary)


def _validated_input[OperationInput: BaseModel](
    model: type[OperationInput], payload: dict[str, object]
) -> OperationInput:
    try:
        return model.model_validate(payload)
    except ValidationError as error:
        raise JobFailure("invalid_job_input", "任务参数不符合操作契约") from error


def _attachment_result(
    context: JobExecutionContext,
    attachments: list[Attachment],
    *,
    roles: list[str],
    input_attachment: Attachment | None = None,
) -> JobExecutionResult:
    records: list[JobAttachment] = []
    if input_attachment is not None:
        records.append(
            JobAttachment(
                id=uuid4().hex,
                job_id=context.claimed.job.id,
                attempt_id=context.claimed.attempt.id,
                role="input",
                attachment_id=input_attachment.id,
                media_type=input_attachment.media_type,
                metadata={"language_mode": input_attachment.language_mode.value},
            )
        )
    records.extend(
        JobAttachment(
            id=uuid4().hex,
            job_id=context.claimed.job.id,
            attempt_id=context.claimed.attempt.id,
            role=role,
            attachment_id=attachment.id,
            media_type=attachment.media_type,
            metadata={"language_mode": attachment.language_mode.value},
        )
        for attachment, role in zip(attachments, roles, strict=True)
    )
    result: dict[str, object] = {"attachment_ids": [item.id for item in attachments]}
    if input_attachment is not None:
        result["input_attachment_id"] = input_attachment.id
    return JobExecutionResult(
        result=result,
        attachments=records,
        commit_point_reached=True,
    )


def _raise_if_cancelled(context: JobExecutionContext, label: str) -> None:
    if context.cancellation.is_cancelled:
        raise JobFailure("canceled", f"{label}已取消", retryable=True)


def _require_safe_output(path: Path, root: Path) -> Path:
    try:
        resolved = path.resolve(strict=True)
        resolved_root = root.resolve(strict=True)
    except OSError as error:
        raise JobFailure("unexpected_output", "生成文件不存在或无法读取") from error
    if (
        resolved_root not in resolved.parents
        or path.is_symlink()
        or not resolved.is_file()
    ):
        raise JobFailure("unsafe_output", "生成文件越过任务输出目录")
    return resolved


def _virtual_environment_python(virtual_environment: Path) -> Path:
    scripts = "Scripts" if os.name == "nt" else "bin"
    executable = "python.exe" if os.name == "nt" else "python"
    return virtual_environment / scripts / executable


def _pdf2zh_executable_at(root: Path) -> Path:
    scripts = "Scripts" if os.name == "nt" else "bin"
    executable = "pdf2zh_next.exe" if os.name == "nt" else "pdf2zh_next"
    return root / ".venv" / scripts / executable


def _tex_executable_at(root: Path) -> Path | None:
    windows = root / "texlive" / "bin" / "windows" / "latexmk.exe"
    if windows.is_file():
        return windows
    binary_root = root / "texlive" / "bin"
    if binary_root.is_dir():
        return next(
            (path for path in sorted(binary_root.glob("*/latexmk")) if path.is_file()),
            None,
        )
    return None


def _activate_tool_directory(source: Path, target: Path) -> Path | None:
    if not source.is_dir():
        raise JobFailure("installation_incomplete", "工具暂存目录不存在")
    target.parent.mkdir(parents=True, exist_ok=True)
    previous: Path | None = None
    if target.exists() or target.is_symlink():
        previous = target.with_name(f".{target.name}.previous-{uuid4().hex}")
        os.replace(target, previous)
    try:
        os.replace(source, target)
    except OSError as error:
        if previous is not None and not target.exists():
            with suppress(OSError):
                os.replace(previous, target)
        raise JobFailure("installation_activation_failed", "无法原子启用工具") from error
    return previous


def _log_observer(context: JobExecutionContext) -> Callable[[ProcessLogEvent], None]:
    def observe(event: ProcessLogEvent) -> None:
        if event.text:
            context.emit(
                f"process.{event.stream}",
                {"message": event.text[-2000:]},
                "info" if event.stream == "stdout" else "warning",
            )

    return observe


def _require_success(result, expected_file: Path | None, label: str) -> None:
    if result.outcome is ProcessOutcome.CANCELED:
        raise JobFailure("canceled", f"{label}已取消", retryable=True)
    if result.outcome is ProcessOutcome.TIMED_OUT:
        raise JobFailure("timeout", f"{label}超时")
    if not result.succeeded or (expected_file is not None and not expected_file.is_file()):
        details = (result.stderr_tail or result.stdout_tail or result.error or "")[-2000:]
        raise JobFailure("process_failed", f"{label}失败：{details}")


def _download_https(
    url: str,
    target: Path,
    *,
    cancellation: Callable[[], bool],
    max_bytes: int = MAX_DOWNLOAD_BYTES,
) -> None:
    if cancellation():
        raise JobFailure("canceled", "下载已取消", retryable=True)
    _validate_public_https_url(url)
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "hxaxd-literature-workspace/3", "Accept": "*/*"},
    )
    opener = urllib.request.build_opener(_SafeRedirectHandler())
    created = False
    try:
        with opener.open(request, timeout=60) as response:  # noqa: S310
            _validate_public_https_url(response.geturl())
            declared = response.headers.get("Content-Length")
            if declared and declared.isdigit() and int(declared) > max_bytes:
                raise JobFailure("download_too_large", "远程文件超过大小限制")
            total = 0
            with target.open("xb") as output:
                created = True
                while chunk := response.read(1024 * 1024):
                    if cancellation():
                        raise JobFailure("canceled", "下载已取消", retryable=True)
                    total += len(chunk)
                    if total > max_bytes:
                        raise JobFailure("download_too_large", "远程文件超过大小限制")
                    output.write(chunk)
    except JobFailure:
        if created:
            target.unlink(missing_ok=True)
        raise
    except OSError as error:
        if created:
            target.unlink(missing_ok=True)
        raise JobFailure("download_failed", f"下载失败：{error}", retryable=True) from error


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        _validate_public_https_url(new_url)
        return super().redirect_request(request, fp, code, message, headers, new_url)


def _validate_public_https_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise JobFailure("unsafe_url", "只允许不含凭据的 HTTPS 下载地址")
    try:
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
    except OSError as error:
        raise JobFailure("dns_failed", f"无法解析下载地址：{error}", retryable=True) from error
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise JobFailure("unsafe_url", "下载地址不能指向本机或私有网络")


def _url_filename(url: str) -> str:
    name = Path(unquote(urlparse(url).path)).name
    return name or "paper.pdf"


def _extract_archive(
    path: Path,
    target: Path,
    *,
    cancellation: Callable[[], bool],
) -> None:
    if zipfile.is_zipfile(path):
        _extract_zip_safely(path, target, cancellation=cancellation)
        return
    if tarfile.is_tarfile(path):
        _extract_tar_safely(path, target, cancellation=cancellation)
        return
    raise JobFailure("invalid_archive", "源码附件不是受支持的压缩包")


def _extract_zip_safely(
    path: Path,
    target: Path,
    *,
    cancellation: Callable[[], bool],
) -> None:
    root = target.resolve()
    seen: set[str] = set()
    try:
        with zipfile.ZipFile(path) as archive:
            members = archive.infolist()
            if len(members) > MAX_ARCHIVE_MEMBERS:
                raise JobFailure("unsafe_archive", "压缩包文件数量异常")
            total = 0
            planned: list[tuple[zipfile.ZipInfo, Path]] = []
            for member in members:
                destination = _safe_archive_destination(root, member.filename, seen)
                mode = (member.external_attr >> 16) & 0o170000
                if mode not in {0, 0o040000, 0o100000}:
                    raise JobFailure("unsafe_archive", "压缩包包含链接或特殊文件")
                if member.file_size < 0 or member.compress_size < 0:
                    raise JobFailure("unsafe_archive", "压缩包成员大小异常")
                if not member.is_dir():
                    _check_archive_member_size(member.file_size, member.compress_size)
                    total += member.file_size
                planned.append((member, destination))
            if total > MAX_ARCHIVE_BYTES:
                raise JobFailure("unsafe_archive", "压缩包解压后过大")

            for member, destination in planned:
                _check_archive_cancellation(cancellation)
                if member.is_dir():
                    destination.mkdir(parents=True, exist_ok=True)
                    continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                written = 0
                with archive.open(member) as source, destination.open("xb") as output:
                    while chunk := source.read(1024 * 1024):
                        _check_archive_cancellation(cancellation)
                        written += len(chunk)
                        if written > member.file_size:
                            raise JobFailure("unsafe_archive", "压缩包成员大小发生变化")
                        output.write(chunk)
                if written != member.file_size:
                    raise JobFailure("unsafe_archive", "压缩包成员没有完整解压")
    except JobFailure:
        raise
    except (OSError, zipfile.BadZipFile, RuntimeError) as error:
        raise JobFailure("invalid_archive", "源码压缩包损坏或无法解压") from error


def _extract_tar_safely(
    path: Path,
    target: Path,
    *,
    cancellation: Callable[[], bool],
) -> None:
    root = target.resolve()
    seen: set[str] = set()
    try:
        with tarfile.open(path, mode="r:*") as archive:
            members = archive.getmembers()
            if len(members) > MAX_ARCHIVE_MEMBERS:
                raise JobFailure("unsafe_archive", "源码包文件数量异常")
            total = 0
            planned: list[tuple[tarfile.TarInfo, Path]] = []
            for member in members:
                destination = _safe_archive_destination(root, member.name, seen)
                if not (member.isdir() or member.isfile()):
                    raise JobFailure("unsafe_archive", "源码包包含链接或特殊文件")
                if member.isfile():
                    _check_archive_member_size(member.size, member.size)
                    total += member.size
                planned.append((member, destination))
            if total > MAX_ARCHIVE_BYTES:
                raise JobFailure("unsafe_archive", "源码包解压后过大")

            for member, destination in planned:
                _check_archive_cancellation(cancellation)
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                    continue
                source = archive.extractfile(member)
                if source is None:
                    raise JobFailure("invalid_archive", "源码包成员无法读取")
                destination.parent.mkdir(parents=True, exist_ok=True)
                written = 0
                with source, destination.open("xb") as output:
                    while chunk := source.read(1024 * 1024):
                        _check_archive_cancellation(cancellation)
                        written += len(chunk)
                        if written > member.size:
                            raise JobFailure("unsafe_archive", "源码包成员大小发生变化")
                        output.write(chunk)
                if written != member.size:
                    raise JobFailure("unsafe_archive", "源码包成员没有完整解压")
    except JobFailure:
        raise
    except (OSError, tarfile.TarError) as error:
        raise JobFailure("invalid_archive", "源码包损坏或无法解压") from error


def _safe_archive_destination(root: Path, name: str, seen: set[str]) -> Path:
    normalized = name.replace("\\", "/")
    pure = PurePosixPath(normalized)
    if (
        not pure.parts
        or pure.is_absolute()
        or ".." in pure.parts
        or any(
            not part
            or part in {".", ".."}
            or ":" in part
            or part.endswith((" ", "."))
            or any(ord(character) < 32 for character in part)
            for part in pure.parts
        )
    ):
        raise JobFailure("unsafe_archive", "源码包包含非法路径")
    key = "/".join(pure.parts).casefold()
    if key in seen:
        raise JobFailure("unsafe_archive", "源码包包含重复或冲突路径")
    seen.add(key)
    destination = (root / Path(*pure.parts)).resolve()
    if root not in destination.parents:
        raise JobFailure("unsafe_archive", "源码包包含越界路径")
    return destination


def _check_archive_member_size(size: int, compressed_size: int) -> None:
    if size < 0 or compressed_size < 0:
        raise JobFailure("unsafe_archive", "源码包成员大小异常")
    if size > MAX_ARCHIVE_MEMBER_BYTES:
        raise JobFailure("unsafe_archive", "源码包包含超大单文件")
    if size and (compressed_size <= 0 or size / compressed_size > MAX_COMPRESSION_RATIO):
        raise JobFailure("unsafe_archive", "源码包包含异常压缩文件")


def _check_archive_cancellation(cancellation: Callable[[], bool]) -> None:
    if cancellation():
        raise JobFailure("canceled", "源码包解压已取消", retryable=True)


def _select_main_tex(source_dir: Path, requested: object) -> Path:
    if isinstance(requested, str) and requested.strip():
        candidate = (source_dir / requested).resolve()
        if source_dir.resolve() not in candidate.parents or not candidate.is_file():
            raise JobFailure("main_tex_missing", "指定的 TeX 主文件不存在或路径非法")
        return candidate
    candidates: list[Path] = []
    for path in source_dir.rglob("*.tex"):
        try:
            with path.open("r", encoding="utf-8", errors="replace") as stream:
                content = stream.read(2 * 1024 * 1024)
        except OSError:
            continue
        if "\\documentclass" in content and "\\begin{document}" in content:
            candidates.append(path)
    if not candidates:
        raise JobFailure("main_tex_missing", "源码包中没有可识别的 TeX 主文件")
    candidates.sort(key=lambda item: (item.name.lower() != "main.tex", len(item.parts), item.name))
    return candidates[0]


def _tex_profile(tex_root: Path) -> str:
    root = tex_root.as_posix()
    return "\n".join(
        [
            "selected_scheme scheme-small",
            f"TEXDIR {root}",
            f"TEXMFLOCAL {root}/texmf-local",
            f"TEXMFSYSCONFIG {root}/texmf-config",
            f"TEXMFSYSVAR {root}/texmf-var",
            f"TEXMFCONFIG {root}/texmf-config",
            f"TEXMFVAR {root}/texmf-var",
            f"TEXMFHOME {root}/texmf-local",
            "instopt_adjustpath 0",
            "instopt_portable 1",
            "tlpdbopt_install_docfiles 0",
            "tlpdbopt_install_srcfiles 0",
            "",
        ]
    )
