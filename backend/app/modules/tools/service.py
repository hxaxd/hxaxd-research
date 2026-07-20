from __future__ import annotations

import re
import subprocess
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from threading import Lock

from app.core.config import Settings

from .installers import ToolInstallError, install_pdf2zh, install_tex
from .models import ManagedTool, ToolName, ToolStatus


class ToolService:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tool-install")
        self._lock = Lock()
        self._installations: dict[ToolName, Future[None]] = {}
        self._errors: dict[ToolName, str] = {}
        self._messages: dict[ToolName, str] = {}

    def initialize(self) -> None:
        self.settings.tools_dir.mkdir(parents=True, exist_ok=True)

    def shutdown(self) -> None:
        self.pool.shutdown(wait=False, cancel_futures=False)

    def list(self) -> list[ManagedTool]:
        return [self.get(name) for name in ToolName]

    def get(self, name: ToolName) -> ManagedTool:
        with self._lock:
            future = self._installations.get(name)
            installing = future is not None and not future.done()
            error = self._errors.get(name)
            current_message = self._messages.get(name)

        executable = self._find_executable(name)
        metadata = self._metadata(name)
        if installing:
            status = ToolStatus.INSTALLING
            message = current_message or "正在准备安装"
        elif error:
            status = ToolStatus.FAILED
            message = error
        elif executable:
            status = ToolStatus.INSTALLED
            message = "可以使用"
            error = None
        else:
            status = ToolStatus.MISSING
            message = "尚未安装"

        return ManagedTool(
            name=name,
            label=metadata["label"],
            description=metadata["description"],
            status=status,
            install_path=str(self._install_path(name)),
            executable_path=str(executable) if executable else None,
            version=self._read_version(name, executable) if executable else None,
            message=message,
        )

    def install(self, name: ToolName) -> ManagedTool:
        installed = self._find_executable(name)
        if installed:
            return self.get(name)
        with self._lock:
            active = self._installations.get(name)
            if active is None or active.done():
                self._errors.pop(name, None)
                self._messages[name] = "正在准备安装"
                self._installations[name] = self.pool.submit(self._run_install, name)
        return self.get(name)

    def _run_install(self, name: ToolName) -> None:
        try:
            if name is ToolName.PDF2ZH:
                install_pdf2zh(self.settings, lambda message: self._record_message(name, message))
            else:
                install_tex(self.settings, lambda message: self._record_message(name, message))
        except ToolInstallError as error:
            self._record_error(name, str(error))
            return
        if not self._find_executable(name):
            self._record_error(name, "安装程序已结束，但未找到预期的可执行文件")
        else:
            self._record_message(name, "安装完成")

    def _record_error(self, name: ToolName, message: str) -> None:
        with self._lock:
            self._errors[name] = message

    def _record_message(self, name: ToolName, message: str) -> None:
        with self._lock:
            self._messages[name] = message

    def _install_path(self, name: ToolName) -> Path:
        if name is ToolName.PDF2ZH:
            return self.settings.pdf2zh_dir
        if name is ToolName.TEX:
            return self.settings.tex_dir
        raise ValueError(f"未知工具：{name}")

    def _find_executable(self, name: ToolName) -> Path | None:
        if name is ToolName.PDF2ZH:
            candidate = self.settings.pdf2zh_executable
            return candidate if candidate.is_file() else None

        windows_candidate = self.settings.tex_dir / "texlive" / "bin" / "windows" / "latexmk.exe"
        if windows_candidate.is_file():
            return windows_candidate
        for candidate in sorted((self.settings.tex_dir / "texlive" / "bin").glob("*/latexmk")):
            if candidate.is_file():
                return candidate
        return None

    @staticmethod
    def _metadata(name: ToolName) -> dict[str, str]:
        if name is ToolName.PDF2ZH:
            return {
                "label": "PDF 论文翻译",
                "description": "保留论文版式并生成中文与双语 PDF",
            }
        return {
            "label": "TeX 编译环境",
            "description": "编译 LaTeX 论文、公式与参考文献",
        }

    @staticmethod
    def _read_version(name: ToolName, executable: Path) -> str | None:
        try:
            result = subprocess.run(
                [str(executable), "--version" if name is ToolName.PDF2ZH else "-version"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=15,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        output = (result.stdout or result.stderr).strip()
        if not output:
            return None
        if name is ToolName.PDF2ZH:
            match = re.search(r"pdf2zh-next version:\s*([^\s]+)", output)
            return match.group(1) if match else output.splitlines()[0][:80]
        match = re.search(r"Version\s+([^\s,]+)", output, re.IGNORECASE)
        return match.group(1) if match else output.splitlines()[0][:80]
