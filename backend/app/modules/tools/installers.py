from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import urllib.request
from collections.abc import Callable, Sequence
from pathlib import Path
from zipfile import ZipFile

from app.core.config import Settings

PDF2ZH_VERSION = "2.9.0"
TEX_REPOSITORY = "https://mirror.ctan.org/systems/texlive/tlnet"
TEX_INSTALLER_URL = f"{TEX_REPOSITORY}/install-tl.zip"

ProgressReporter = Callable[[str], None]


class ToolInstallError(RuntimeError):
    pass


def install_pdf2zh(settings: Settings, report: ProgressReporter) -> None:
    executable = settings.pdf2zh_executable
    if executable.is_file() and _pdf2zh_version(executable) == PDF2ZH_VERSION:
        report("PDF2zh 已经就绪")
        return

    uv = shutil.which("uv")
    if not uv:
        raise ToolInstallError("没有找到 uv，无法创建 PDF2zh 的独立 Python 环境")

    virtual_environment = settings.pdf2zh_dir / ".venv"
    python_name = "python.exe" if os.name == "nt" else "python"
    scripts_directory = "Scripts" if os.name == "nt" else "bin"
    python = virtual_environment / scripts_directory / python_name
    settings.pdf2zh_dir.mkdir(parents=True, exist_ok=True)

    if not python.is_file():
        report("正在创建 PDF2zh 的 Python 3.12 环境")
        _run_checked([uv, "venv", "--python", "3.12", str(virtual_environment)])

    report(f"正在安装 pdf2zh-next {PDF2ZH_VERSION}")
    _run_checked(
        [
            uv,
            "pip",
            "install",
            "--python",
            str(python),
            "--upgrade",
            f"pdf2zh-next=={PDF2ZH_VERSION}",
        ]
    )
    if not executable.is_file():
        raise ToolInstallError(f"安装完成后没有找到可执行文件：{executable}")
    version = _pdf2zh_version(executable)
    if version != PDF2ZH_VERSION:
        raise ToolInstallError(f"需要 PDF2zh {PDF2ZH_VERSION}，实际检测到 {version or '未知版本'}")
    report("PDF2zh 安装完成")


def install_tex(settings: Settings, report: ProgressReporter) -> None:
    latexmk = settings.tex_dir / "texlive" / "bin" / "windows" / "latexmk.exe"
    if latexmk.is_file():
        report("TeX Live 已经就绪")
        return
    if os.name != "nt":
        raise ToolInstallError("当前 TeX 自动安装仅支持 Windows")
    if not str(settings.tex_dir).isascii():
        raise ToolInstallError(f"TeX Live 的安装路径必须只包含 ASCII 字符：{settings.tex_dir}")

    settings.tex_dir.mkdir(parents=True, exist_ok=True)
    tex_root = settings.tex_dir / "texlive"
    with tempfile.TemporaryDirectory(prefix="hxaxd-tex-") as temporary:
        stage = Path(temporary).resolve()
        archive_path = stage / "install-tl.zip"
        report("正在下载 TeX Live 网络安装器")
        _download(TEX_INSTALLER_URL, archive_path)
        report("正在解压 TeX Live 安装器")
        with ZipFile(archive_path) as archive:
            _extract_safely(archive, stage)

        installer = next(stage.rglob("install-tl-windows.bat"), None)
        if installer is None:
            raise ToolInstallError("下载内容中没有 install-tl-windows.bat")
        profile = stage / "texlive.profile"
        profile.write_text(_tex_profile(tex_root), encoding="utf-8")

        report("正在安装便携版 TeX Live")
        _run_batch(installer, ["-profile", str(profile), "-repository", TEX_REPOSITORY])
        tlmgr = tex_root / "bin" / "windows" / "tlmgr.bat"
        if not tlmgr.is_file():
            raise ToolInstallError("TeX Live 安装结束后没有找到 tlmgr")
        report("正在安装论文写作常用 TeX 包")
        _run_batch(
            tlmgr,
            [
                "install",
                "latexmk",
                "collection-latexrecommended",
                "collection-latexextra",
                "collection-fontsrecommended",
                "collection-bibtexextra",
            ],
        )
    if not latexmk.is_file():
        raise ToolInstallError(f"TeX Live 安装结束后没有找到 latexmk：{latexmk}")
    report("TeX Live 安装完成")


def _pdf2zh_version(executable: Path) -> str | None:
    try:
        output = _run_checked([str(executable), "--version"], timeout=30)
    except ToolInstallError:
        return None
    prefix = "pdf2zh-next version:"
    for line in output.splitlines():
        if line.strip().startswith(prefix):
            return line.split(prefix, 1)[1].strip()
    return None


def _download(url: str, target: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "hxaxd-learning-workspace"})
    try:
        with urllib.request.urlopen(request, timeout=60) as source, target.open("wb") as output:
            shutil.copyfileobj(source, output)
    except OSError as error:
        raise ToolInstallError(f"下载失败：{error}") from error


def _extract_safely(archive: ZipFile, target: Path) -> None:
    root = target.resolve()
    for member in archive.infolist():
        destination = (root / member.filename).resolve()
        if not destination.is_relative_to(root):
            raise ToolInstallError(f"安装包包含不安全路径：{member.filename}")
    archive.extractall(root)


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


def _run_batch(batch: Path, arguments: Sequence[str]) -> str:
    command_line = subprocess.list2cmdline([str(batch), *arguments])
    return _run_checked(["cmd.exe", "/d", "/s", "/c", command_line], timeout=None)


def _run_checked(command: Sequence[str], *, timeout: int | None = None) -> str:
    options: dict[str, object] = {
        "args": list(command),
        "capture_output": True,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "timeout": timeout,
        "check": False,
    }
    if os.name == "nt":
        options["creationflags"] = subprocess.CREATE_NO_WINDOW
    try:
        result = subprocess.run(**options)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ToolInstallError(f"无法执行 {Path(command[0]).name}：{error}") from error
    output = "\n".join(part for part in (result.stdout, result.stderr) if part).strip()
    if result.returncode != 0:
        raise ToolInstallError(output[-2000:] or f"命令退出码：{result.returncode}")
    return output
