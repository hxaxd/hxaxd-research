from __future__ import annotations

import json
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from statistics import median
from typing import Any

from app.core.config import Settings
from app.platform.processes import (
    ExecutableIdentity,
    ProcessOutcome,
    ProcessRunner,
    ProcessSpec,
)

from .capabilities import RAPIDOCR_VERSION
from .extractor import DocumentExtractionError, ExtractionCallbacks
from .models import BlockKind, ExtractedBlock, ExtractedDocument, SemanticRole

OCR_STRUCTURE_VERSION = "rapidocr-reading-blocks-v1"


@dataclass(frozen=True)
class _Line:
    text: str
    confidence: float
    x1: float
    y1: float
    x2: float
    y2: float

    @property
    def height(self) -> float:
        return self.y2 - self.y1

    @property
    def center_y(self) -> float:
        return (self.y1 + self.y2) / 2


class RapidOcrExtractor:
    name = "rapidocr"
    version = RAPIDOCR_VERSION
    structure_version = OCR_STRUCTURE_VERSION

    def __init__(self, settings: Settings, runner: ProcessRunner) -> None:
        self.settings = settings
        self.runner = runner

    @property
    def ready(self) -> bool:
        return (
            self.settings.pdf2zh_python.is_file()
            and self.settings.rapidocr_package_dir is not None
        )

    def extract(
        self, source_path: Path, *, callbacks: ExtractionCallbacks
    ) -> ExtractedDocument:
        if not self.ready:
            raise DocumentExtractionError(
                "ocr_tool_missing",
                "PDF 工具需要升级后才能识别纯扫描页",
            )
        python = self.settings.pdf2zh_python
        self.runner.registry.register(
            ExecutableIdentity("rapidocr-python", python, python.parent)
        )
        worker = Path(__file__).with_name("ocr_worker.py").resolve()
        self.settings.operation_staging_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(
            prefix="document-ocr-", dir=self.settings.operation_staging_dir
        ) as temporary:
            stage = Path(temporary)
            output = stage / "rapidocr.json"
            callbacks.emit(
                "document.ocr_started",
                {"engine": self.name, "version": self.version},
                "info",
            )
            result = self.runner.run(
                ProcessSpec(
                    executable="rapidocr-python",
                    argv=(
                        str(worker),
                        "--source",
                        str(source_path),
                        "--output",
                        str(output),
                    ),
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
                    display_name="RapidOCR scanned document extraction",
                ),
                cancellation=callbacks.cancellation,
            )
            callbacks.record_process(result.pid, "rapidocr-python", result.returncode)
            if result.outcome is ProcessOutcome.CANCELED:
                raise DocumentExtractionError(
                    "canceled", "扫描件文字识别已取消", retryable=True
                )
            if result.outcome is ProcessOutcome.TIMED_OUT:
                raise DocumentExtractionError("timeout", "扫描件文字识别超时")
            if not result.succeeded:
                raise DocumentExtractionError(
                    "ocr_failed", "扫描件文字识别失败；未登记任何结构化结果"
                )
            if not output.is_file() or output.stat().st_size > 100 * 1024 * 1024:
                raise DocumentExtractionError(
                    "invalid_ocr_output", "扫描件文字识别没有产生有效结果"
                )
            try:
                extracted = parse_rapidocr_output(
                    json.loads(output.read_text(encoding="utf-8"))
                )
            except (OSError, ValueError, TypeError, KeyError) as error:
                raise DocumentExtractionError(
                    "invalid_ocr_output", "扫描件文字识别结果未通过结构校验"
                ) from error
            if not extracted.blocks:
                raise DocumentExtractionError(
                    "ocr_empty", "扫描件文字识别完成，但没有发现可阅读文字"
                )
            callbacks.emit(
                "document.ocr_ready",
                {
                    "engine": self.name,
                    "pages": extracted.page_count,
                    "blocks": len(extracted.blocks),
                },
                "info",
            )
            return extracted


def parse_rapidocr_output(payload: dict[str, Any]) -> ExtractedDocument:
    if payload.get("engine") != "rapidocr":
        raise ValueError("unexpected OCR engine")
    pages = payload.get("pages")
    if not isinstance(pages, list) or not pages:
        raise ValueError("OCR output must contain pages")
    blocks: list[ExtractedBlock] = []
    section_path: list[str] = []
    confidences: list[float] = []
    for page in pages:
        if not isinstance(page, dict):
            raise ValueError("OCR page must be an object")
        page_number = _positive_int(page.get("page_number"), "page number")
        image_width = _positive_float(page.get("image_width"), "image width")
        image_height = _positive_float(page.get("image_height"), "image height")
        pdf_width = _positive_float(page.get("pdf_width"), "PDF width")
        pdf_height = _positive_float(page.get("pdf_height"), "PDF height")
        lines = _lines(page.get("lines"), image_width, image_height)
        if not lines:
            continue
        ordered_groups = _reading_groups(lines, image_width)
        typical_height = median(line.height for line in lines)
        for group in ordered_groups:
            text = _join_lines(group)
            if not text:
                continue
            heading = _is_heading(group, text, typical_height)
            is_first = not blocks
            kind = (
                BlockKind.TITLE
                if is_first
                else BlockKind.HEADING
                if heading
                else BlockKind.PARAGRAPH
            )
            if kind is BlockKind.HEADING:
                section_path = [text]
            confidence = sum(line.confidence for line in group) / len(group)
            confidences.append(confidence)
            pixel_box = {
                "x": min(line.x1 for line in group),
                "y": min(line.y1 for line in group),
                "x2": max(line.x2 for line in group),
                "y2": max(line.y2 for line in group),
            }
            anchor = {
                "type": "pdf_bbox",
                "page": page_number,
                "coordinate_system": "pdf-bottom-left",
                "bbox": {
                    "x": pixel_box["x"] / image_width * pdf_width,
                    "y": pdf_height - pixel_box["y2"] / image_height * pdf_height,
                    "x2": pixel_box["x2"] / image_width * pdf_width,
                    "y2": pdf_height - pixel_box["y"] / image_height * pdf_height,
                },
                "page_box": {"x": 0.0, "y": 0.0, "x2": pdf_width, "y2": pdf_height},
                "layout": {
                    "label": "ocr",
                    "confidence": round(confidence, 6),
                    "engine": "rapidocr",
                },
            }
            blocks.append(
                ExtractedBlock(
                    kind=kind,
                    semantic_role=_heuristic_role(
                        text if kind is BlockKind.HEADING else " ".join(section_path)
                    ),
                    source_text=text,
                    page_start=page_number,
                    page_end=page_number,
                    anchor=anchor,
                    section_path=[] if kind is BlockKind.TITLE else list(section_path),
                )
            )
    return ExtractedDocument(
        page_count=len(pages),
        blocks=blocks,
        diagnostics={
            "source": "rapidocr",
            "engine_version": payload.get("version"),
            "mean_confidence": (
                round(sum(confidences) / len(confidences), 6) if confidences else None
            ),
        },
    )


def _lines(value: Any, width: float, height: float) -> list[_Line]:
    if not isinstance(value, list):
        raise ValueError("OCR lines must be a list")
    result: list[_Line] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        text = item.get("text")
        confidence = item.get("confidence")
        points = item.get("points")
        if not isinstance(text, str) or not text.strip():
            continue
        if not isinstance(confidence, int | float) or not 0 <= confidence <= 1:
            raise ValueError("OCR confidence is invalid")
        if not isinstance(points, list) or len(points) != 4:
            raise ValueError("OCR box must contain four points")
        coordinates = [point for point in points if isinstance(point, list) and len(point) == 2]
        if len(coordinates) != 4 or not all(
            isinstance(axis, int | float) for point in coordinates for axis in point
        ):
            raise ValueError("OCR box coordinates are invalid")
        xs = [float(point[0]) for point in coordinates]
        ys = [float(point[1]) for point in coordinates]
        x1, x2, y1, y2 = min(xs), max(xs), min(ys), max(ys)
        if x1 < 0 or y1 < 0 or x2 > width or y2 > height or x2 <= x1 or y2 <= y1:
            raise ValueError("OCR box is outside its page")
        result.append(_Line(text.strip(), float(confidence), x1, y1, x2, y2))
    return result


def _reading_groups(lines: list[_Line], page_width: float) -> list[list[_Line]]:
    left = [line for line in lines if line.x2 <= page_width * 0.58]
    right = [line for line in lines if line.x1 >= page_width * 0.42]
    all_top = min(line.center_y for line in lines)
    all_bottom = max(line.center_y for line in lines)
    overlap = (
        min(max(line.center_y for line in left), max(line.center_y for line in right))
        - max(min(line.center_y for line in left), min(line.center_y for line in right))
        if left and right
        else 0
    )
    two_columns = (
        len(left) >= 3
        and len(right) >= 3
        and overlap > (all_bottom - all_top) * 0.3
    )
    if not two_columns:
        return _paragraph_groups(sorted(lines, key=lambda line: (line.y1, line.x1)))
    spanning = [line for line in lines if line not in left and line not in right]
    groups: list[list[_Line]] = []
    previous_y = 0.0
    for separator in sorted(spanning, key=lambda line: (line.y1, line.x1)):
        groups.extend(_column_region(left, right, previous_y, separator.center_y))
        groups.append([separator])
        previous_y = separator.center_y
    groups.extend(_column_region(left, right, previous_y, float("inf")))
    return groups


def _column_region(
    left: list[_Line], right: list[_Line], start_y: float, end_y: float
) -> list[list[_Line]]:
    left_region = [line for line in left if start_y <= line.center_y < end_y]
    right_region = [line for line in right if start_y <= line.center_y < end_y]
    return [
        *_paragraph_groups(sorted(left_region, key=lambda line: (line.y1, line.x1))),
        *_paragraph_groups(sorted(right_region, key=lambda line: (line.y1, line.x1))),
    ]


def _paragraph_groups(lines: list[_Line]) -> list[list[_Line]]:
    if not lines:
        return []
    typical_height = median(line.height for line in lines)
    groups: list[list[_Line]] = [[lines[0]]]
    for line in lines[1:]:
        previous = groups[-1][-1]
        vertical_gap = line.y1 - previous.y2
        horizontal_shift = abs(line.x1 - previous.x1)
        sentence_break = (
            previous.text.rstrip().endswith((".", "?", "!", "。", "？", "！"))
            and vertical_gap > typical_height * 0.22
        )
        heading = _is_heading([line], line.text, typical_height)
        previous_heading = _is_heading([previous], previous.text, typical_height)
        if (
            heading
            or previous_heading
            or sentence_break
            or vertical_gap > typical_height * 0.9
            or horizontal_shift > typical_height * 3.5
        ):
            groups.append([line])
        else:
            groups[-1].append(line)
    return groups


def _is_heading(group: list[_Line], text: str, typical_height: float) -> bool:
    return (
        len(group) == 1
        and len(text) <= 140
        and (
            group[0].height >= typical_height * 1.3
            or bool(
                re.match(
                    r"^(?:\d+(?:\.\d+)*\s+)?(?:abstract|introduction|methods?|results?|discussion|limitations?|conclusions?|references|摘要|引言|方法|结果|讨论|局限|结论|参考文献)\b",
                    text,
                    flags=re.IGNORECASE,
                )
            )
        )
    )


def _join_lines(lines: list[_Line]) -> str:
    value = ""
    for line in lines:
        if value.endswith("-") and line.text[:1].islower():
            value = value[:-1] + line.text
        elif value:
            value += " " + line.text
        else:
            value = line.text
    return value.strip()


def _heuristic_role(value: str) -> SemanticRole | None:
    heading = value.casefold()
    if any(token in heading for token in ("method", "methodology", "materials", "方法")):
        return SemanticRole.METHOD
    if any(token in heading for token in ("result", "finding", "experiment", "结果")):
        return SemanticRole.RESULT
    if any(token in heading for token in ("limitation", "threat", "caveat", "局限")):
        return SemanticRole.LIMITATION
    if any(token in heading for token in ("conclusion", "discussion", "implication", "结论")):
        return SemanticRole.CONCLUSION
    if any(token in heading for token in ("question", "hypoth", "objective", "问题")):
        return SemanticRole.QUESTION
    if any(token in heading for token in ("background", "introduction", "related work", "引言")):
        return SemanticRole.BACKGROUND
    return None


def _positive_int(value: Any, label: str) -> int:
    if not isinstance(value, int) or value < 1:
        raise ValueError(f"{label} is invalid")
    return value


def _positive_float(value: Any, label: str) -> float:
    if not isinstance(value, int | float) or value <= 0:
        raise ValueError(f"{label} is invalid")
    return float(value)
