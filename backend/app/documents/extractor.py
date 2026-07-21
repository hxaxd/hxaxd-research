from __future__ import annotations

import json
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from app.core.config import Settings
from app.platform.processes import (
    CancellationToken,
    ExecutableIdentity,
    ProcessLogEvent,
    ProcessOutcome,
    ProcessRunner,
    ProcessSpec,
)

from .models import (
    BlockKind,
    ExtractedBlock,
    ExtractedDocument,
    OcrMode,
    SemanticRole,
)

BABELDOC_VERSION = "0.6.2"
RAPIDOCR_VERSION = "3.9.2"
STRUCTURE_VERSION = "semantic-blocks-v2"


class DocumentExtractionError(RuntimeError):
    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True)
class ExtractionCallbacks:
    cancellation: CancellationToken
    emit: Callable[[str, dict[str, Any], str], None]
    record_process: Callable[[int | None, str, int | None], None]


class OcrExtractor(Protocol):
    @property
    def ready(self) -> bool: ...

    def extract(
        self, source_path: Path, *, callbacks: ExtractionCallbacks
    ) -> ExtractedDocument: ...


class BabelDocExtractor:
    name = "babeldoc"
    version = f"{BABELDOC_VERSION}+rapidocr.{RAPIDOCR_VERSION}"
    structure_version = STRUCTURE_VERSION

    def __init__(
        self, settings: Settings, runner: ProcessRunner, ocr_extractor: OcrExtractor
    ) -> None:
        self.settings = settings
        self.runner = runner
        self.ocr_extractor = ocr_extractor

    @property
    def ready(self) -> bool:
        return self.settings.babeldoc_executable.is_file()

    @property
    def true_ocr_ready(self) -> bool:
        return self.ocr_extractor.ready

    def extract(
        self,
        source_path: Path,
        *,
        ocr_mode: OcrMode,
        callbacks: ExtractionCallbacks,
    ) -> ExtractedDocument:
        if ocr_mode is OcrMode.FORCE:
            return self.ocr_extractor.extract(source_path, callbacks=callbacks)
        try:
            return self._extract_layout(
                source_path,
                detect_scanned=ocr_mode is OcrMode.AUTO,
                callbacks=callbacks,
            )
        except DocumentExtractionError as error:
            fallback_codes = {
                "ocr_required",
                "invalid_extractor_output",
                "extractor_failed",
                "tool_missing",
            }
            if ocr_mode is not OcrMode.AUTO or error.code not in fallback_codes:
                raise
            callbacks.emit(
                "document.ocr_fallback",
                {"reason": str(error), "engine": "rapidocr"},
                "warning",
            )
            return self.ocr_extractor.extract(source_path, callbacks=callbacks)

    def _extract_layout(
        self,
        source_path: Path,
        *,
        detect_scanned: bool,
        callbacks: ExtractionCallbacks,
    ) -> ExtractedDocument:
        executable = self.settings.babeldoc_executable
        if not executable.is_file():
            raise DocumentExtractionError(
                "tool_missing", "BabelDOC 尚未安装；请先安装 PDF 论文翻译工具"
            )
        self.runner.registry.register(
            ExecutableIdentity("babeldoc", executable, executable.parent)
        )
        self.settings.operation_staging_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix="document-extract-", dir=self.settings.operation_staging_dir
        ) as temporary:
            stage = Path(temporary)
            working = stage / "working"
            output = stage / "output"
            working.mkdir()
            output.mkdir()
            argv = [
                "--files",
                str(source_path),
                "--debug",
                "--working-dir",
                str(working),
                "--output",
                str(output),
                "--skip-translation",
                "--no-mono",
                "--no-dual",
                "--pool-max-workers",
                "1",
                "--openai",
                "--openai-api-key",
                "local-structure-extraction-no-network-call",
            ]
            if detect_scanned:
                argv.append("--auto-enable-ocr-workaround")
            else:
                argv.append("--skip-scanned-detection")
            callbacks.emit(
                "document.extraction_started",
                {
                    "extractor": self.name,
                    "extractor_version": self.version,
                    "scan_detection": detect_scanned,
                },
                "info",
            )
            result = self.runner.run(
                ProcessSpec(
                    executable="babeldoc",
                    argv=tuple(argv),
                    cwd=stage,
                    allowed_cwd_root=self.settings.operation_staging_dir,
                    timeout_seconds=7_200,
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
                    display_name="BabelDOC structure extraction",
                ),
                cancellation=callbacks.cancellation,
                observer=_log_observer(callbacks),
            )
            callbacks.record_process(result.pid, "babeldoc", result.returncode)
            if result.outcome is ProcessOutcome.CANCELED:
                raise DocumentExtractionError(
                    "canceled", "文档结构提取已取消", retryable=True
                )
            if result.outcome is ProcessOutcome.TIMED_OUT:
                raise DocumentExtractionError("timeout", "文档结构提取超时")
            if not result.succeeded:
                details = (result.stderr_tail or result.stdout_tail or result.error or "")[-2000:]
                code = "ocr_required" if "ScannedPDFError" in details else "extractor_failed"
                raise DocumentExtractionError(code, f"BabelDOC 结构提取失败：{details}")

            intermediate = working / source_path.stem / "styles_and_formulas.json"
            if not intermediate.is_file():
                raise DocumentExtractionError(
                    "invalid_extractor_output", "BabelDOC 未产生约定的文档中间表示"
                )
            try:
                payload = json.loads(intermediate.read_text(encoding="utf-8"))
                extracted = parse_babeldoc_il(payload)
            except (OSError, ValueError, TypeError, KeyError) as error:
                raise DocumentExtractionError(
                    "invalid_extractor_output", "BabelDOC 文档中间表示无法通过结构校验"
                ) from error
            if not extracted.blocks:
                raise DocumentExtractionError(
                    "ocr_required",
                    "PDF 没有可恢复的文本块；扫描图片页需要真正的 OCR 引擎",
                )
            callbacks.emit(
                "document.structure_ready",
                {
                    "pages": extracted.page_count,
                    "blocks": len(extracted.blocks),
                    "extractor": self.name,
                },
                "info",
            )
            return extracted


def parse_babeldoc_il(payload: dict[str, Any]) -> ExtractedDocument:
    pages = payload.get("page")
    total_pages = payload.get("total_pages")
    if not isinstance(pages, list) or not pages:
        raise ValueError("document IL must contain pages")
    if not isinstance(total_pages, int) or total_pages < 1 or total_pages != len(pages):
        raise ValueError("document IL page count is inconsistent")

    blocks: list[ExtractedBlock] = []
    section_path: list[str] = []
    ignored_debug_blocks = 0
    for page_index, page in enumerate(pages):
        if not isinstance(page, dict):
            raise ValueError("document IL page must be an object")
        raw_page_number = page.get("page_number", page_index)
        if not isinstance(raw_page_number, int):
            raise ValueError("document IL page number must be an integer")
        page_number = raw_page_number + 1
        page_box = _box(page.get("mediabox")) or _box(page.get("cropbox"))
        layouts = _layouts(page.get("page_layout"))
        paragraphs = page.get("pdf_paragraph", [])
        if not isinstance(paragraphs, list):
            raise ValueError("document IL paragraphs must be a list")
        visible: list[dict[str, Any]] = []
        for paragraph in paragraphs:
            if not isinstance(paragraph, dict):
                continue
            if _contains_debug_marker(paragraph.get("pdf_paragraph_composition", [])):
                ignored_debug_blocks += 1
                continue
            text = paragraph.get("unicode")
            if not isinstance(text, str) or not text.strip():
                continue
            visible.append(paragraph)
        visible.sort(key=_render_order)

        for paragraph in visible:
            text = _normalize_text(str(paragraph["unicode"]))
            paragraph_box = _box(paragraph.get("box"))
            raw_label = paragraph.get("layout_label")
            label = raw_label.strip().lower() if isinstance(raw_label, str) else ""
            layout_id = paragraph.get("layout_id")
            layout = layouts.get(layout_id) if isinstance(layout_id, int) else None
            if not label and layout:
                label = str(layout.get("class_name") or "").strip().lower()
            containing_layout = _containing_layout(paragraph_box, layouts.values())
            kind = _block_kind(
                label,
                paragraph,
                is_first=not blocks,
                containing_layout=containing_layout,
                section_path=section_path,
            )
            if kind is BlockKind.HEADING:
                section_path = [text]
            role = _heuristic_role(text if kind is BlockKind.HEADING else " ".join(section_path))
            anchor: dict[str, Any] = {
                "type": "pdf_bbox",
                "page": page_number,
                "coordinate_system": "pdf-bottom-left",
                "bbox": paragraph_box or {},
                "layout": {
                    "id": layout_id,
                    "label": label or None,
                    "confidence": layout.get("conf") if layout else None,
                },
            }
            if page_box:
                anchor["page_box"] = page_box
            blocks.append(
                ExtractedBlock(
                    kind=kind,
                    semantic_role=role,
                    source_text=text,
                    page_start=page_number,
                    page_end=page_number,
                    anchor=anchor,
                    section_path=[] if kind is BlockKind.TITLE else list(section_path),
                )
            )
    return ExtractedDocument(
        page_count=total_pages,
        blocks=blocks,
        diagnostics={
            "ignored_debug_blocks": ignored_debug_blocks,
            "source": "babeldoc_document_il",
        },
    )


def _layouts(value: Any) -> dict[int, dict[str, Any]]:
    if not isinstance(value, list):
        return {}
    result: dict[int, dict[str, Any]] = {}
    for layout in value:
        if isinstance(layout, dict) and isinstance(layout.get("id"), int):
            result[int(layout["id"])] = layout
    return result


def _box(value: Any) -> dict[str, float] | None:
    if isinstance(value, dict) and isinstance(value.get("box"), dict):
        value = value["box"]
    if not isinstance(value, dict):
        return None
    coordinates = (value.get("x"), value.get("y"), value.get("x2"), value.get("y2"))
    if not all(isinstance(item, int | float) for item in coordinates):
        return None
    x, y, x2, y2 = (float(item) for item in coordinates)
    if x2 < x or y2 < y:
        return None
    return {"x": x, "y": y, "x2": x2, "y2": y2}


def _render_order(paragraph: dict[str, Any]) -> tuple[int, float, float]:
    order = paragraph.get("render_order")
    box = _box(paragraph.get("box")) or {"x": 0.0, "y2": 0.0}
    return (
        int(order) if isinstance(order, int) else 2**31 - 1,
        -float(box["y2"]),
        float(box["x"]),
    )


def _contains_debug_marker(value: Any) -> bool:
    if isinstance(value, dict):
        if value.get("debug_info") is True:
            return True
        return any(_contains_debug_marker(item) for item in value.values())
    if isinstance(value, list):
        return any(_contains_debug_marker(item) for item in value)
    return False


def _containing_layout(
    paragraph_box: dict[str, float] | None, layouts: Any
) -> dict[str, Any] | None:
    if paragraph_box is None:
        return None
    center_x = (paragraph_box["x"] + paragraph_box["x2"]) / 2
    center_y = (paragraph_box["y"] + paragraph_box["y2"]) / 2
    matches = []
    for layout in layouts:
        layout_box = _box(layout.get("box")) if isinstance(layout, dict) else None
        if (
            layout_box
            and layout_box["x"] <= center_x <= layout_box["x2"]
            and layout_box["y"] <= center_y <= layout_box["y2"]
        ):
            area = (layout_box["x2"] - layout_box["x"]) * (
                layout_box["y2"] - layout_box["y"]
            )
            matches.append((area, layout))
    return min(matches, key=lambda item: item[0])[1] if matches else None


def _block_kind(
    label: str,
    paragraph: dict[str, Any],
    *,
    is_first: bool,
    containing_layout: dict[str, Any] | None,
    section_path: list[str],
) -> BlockKind:
    effective_label = label.replace("_", " ").replace("-", " ")
    container_label = (
        str(containing_layout.get("class_name") or "").lower()
        if containing_layout
        else ""
    )
    if "title" in effective_label:
        return BlockKind.TITLE if is_first else BlockKind.HEADING
    if "heading" in effective_label:
        return BlockKind.HEADING
    if "reference" in effective_label or any(
        "reference" in heading.lower() or "bibliograph" in heading.lower()
        for heading in section_path
    ):
        return BlockKind.REFERENCE
    if "footnote" in effective_label:
        return BlockKind.FOOTNOTE
    if "figure" in effective_label or "figure" in container_label:
        return BlockKind.FIGURE
    if "table" in effective_label or "table" in container_label:
        return BlockKind.TABLE
    if "list" in effective_label:
        return BlockKind.LIST
    compositions = paragraph.get("pdf_paragraph_composition", [])
    if isinstance(compositions, list) and compositions and all(
        isinstance(item, dict) and item.get("pdf_formula") is not None
        for item in compositions
    ):
        return BlockKind.FORMULA
    if effective_label in {"plain text", "text", "fallback line", ""}:
        return BlockKind.PARAGRAPH
    return BlockKind.OTHER


def _heuristic_role(value: str) -> SemanticRole | None:
    heading = value.casefold()
    if any(token in heading for token in ("method", "methodology", "materials")):
        return SemanticRole.METHOD
    if any(token in heading for token in ("result", "finding", "experiment")):
        return SemanticRole.RESULT
    if any(token in heading for token in ("limitation", "threat", "caveat")):
        return SemanticRole.LIMITATION
    if any(token in heading for token in ("conclusion", "discussion", "implication")):
        return SemanticRole.CONCLUSION
    if any(token in heading for token in ("question", "hypoth", "objective")):
        return SemanticRole.QUESTION
    if any(token in heading for token in ("background", "introduction", "related work")):
        return SemanticRole.BACKGROUND
    return None


def _normalize_text(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n").strip()


def _log_observer(callbacks: ExtractionCallbacks):
    def observe(event: ProcessLogEvent) -> None:
        if not event.text:
            return
        callbacks.emit(
            f"extractor.{event.stream}",
            {"message": event.text[-2000:]},
            "info" if event.stream == "stdout" else "warning",
        )

    return observe
