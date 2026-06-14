from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

from .config import Config
from .errors import HxrError
from .state import (
    cache_hit,
    complete_stage,
    fail_stage,
    file_hash,
    load_state,
    operation_key,
    save_state,
)
from .workspace import require_workspace_path


PARSE_CACHE_VERSION = "parse-v4"


def _parse_with_paddle(pdf: Path, images: Path, config: Config) -> str:
    try:
        from paddleocr import PPStructureV3
    except ImportError as exc:
        raise HxrError("PP-StructureV3 is unavailable. Run: uv sync") from exc

    pipeline = PPStructureV3(
        device=config.parse.get("device", "gpu"),
        text_detection_model_name=config.parse.get(
            "text_detection_model", "PP-OCRv6_medium_det"
        ),
        text_recognition_model_name=config.parse.get(
            "text_recognition_model", "PP-OCRv6_medium_rec"
        ),
    )
    markdown_pages = []
    for page_number, result in enumerate(
        pipeline.predict(input=str(pdf)), start=1
    ):
        info = dict(result.markdown)
        markdown_text = str(info["markdown_texts"])
        for relative_path, image in info.get("markdown_images", {}).items():
            clean_relative = Path(str(relative_path).replace("\\", "/"))
            if clean_relative.is_absolute() or ".." in clean_relative.parts:
                clean_relative = Path(clean_relative.name)
            target = images / clean_relative
            target.parent.mkdir(parents=True, exist_ok=True)
            image.save(target)
            markdown_text = markdown_text.replace(
                str(relative_path),
                f"图片/{clean_relative.as_posix()}",
            )
        info["markdown_texts"] = (
            f'<a id="page-{page_number}"></a>\n\n{markdown_text}'
        )
        markdown_pages.append(info)
    markdown = pipeline.concatenate_markdown_pages(markdown_pages)["markdown_texts"]
    if not str(markdown).strip():
        raise HxrError("PP-StructureV3 returned no Markdown content.")
    return str(markdown)


def _commit_parse_outputs(staging: Path, paper_dir: Path) -> None:
    targets = ("原文.pdf", "原文.md", "图片")
    backup = Path(
        tempfile.mkdtemp(prefix=".hxr-parse-backup-", dir=paper_dir.parent)
    )
    moved_old: list[str] = []
    moved_new: list[str] = []
    try:
        for name in targets:
            target = paper_dir / name
            if target.exists():
                os.replace(target, backup / name)
                moved_old.append(name)
        for name in targets:
            os.replace(staging / name, paper_dir / name)
            moved_new.append(name)
    except Exception:
        for name in reversed(moved_new):
            target = paper_dir / name
            if target.is_dir():
                shutil.rmtree(target)
            elif target.exists():
                target.unlink()
        for name in moved_old:
            os.replace(backup / name, paper_dir / name)
        raise
    finally:
        shutil.rmtree(backup, ignore_errors=True)


def parse_pdf(pdf: Path, paper_dir: Path, config: Config) -> tuple[Path, bool]:
    pdf = pdf.resolve()
    if not pdf.is_file():
        raise HxrError(f"PDF not found: {pdf}")
    if pdf.suffix.lower() != ".pdf":
        raise HxrError(f"Expected a PDF file: {pdf}")

    paper_dir = require_workspace_path(
        paper_dir, config.workspace, "Paper directory"
    )
    paper_dir.mkdir(parents=True, exist_ok=True)
    source = paper_dir / "原文.md"
    original = paper_dir / "原文.pdf"
    state = load_state(paper_dir)
    input_digest = file_hash(pdf)
    config_digest = f"{config.digest('parse')}:{PARSE_CACHE_VERSION}"
    key = operation_key("parse", "pdf", source)
    if (
        cache_hit(state, key, input_digest, config_digest, source)
        and original.exists()
        and (paper_dir / "图片").is_dir()
    ):
        return source, True

    staging = Path(
        tempfile.mkdtemp(prefix=".hxr-parse-", dir=paper_dir.parent)
    )
    try:
        images = staging / "图片"
        images.mkdir()
        markdown = _parse_with_paddle(pdf, images, config)
        (staging / "原文.md").write_text(markdown, encoding="utf-8")
        shutil.copy2(pdf, staging / "原文.pdf")
        _commit_parse_outputs(staging, paper_dir)
        complete_stage(state, key, input_digest, config_digest, source)
        state["operations"][key]["outputs"] = [
            str(original.resolve()),
            str(source.resolve()),
            str((paper_dir / "图片").resolve()),
        ]
        save_state(paper_dir, state)
        return source, False
    except Exception as exc:
        fail_stage(state, key, input_digest, config_digest, exc)
        save_state(paper_dir, state)
        raise
    finally:
        shutil.rmtree(staging, ignore_errors=True)
