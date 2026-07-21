from __future__ import annotations

import io
import re
import tarfile
import zipfile
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path, PurePosixPath
from typing import Any

from .models import BlockKind, ExtractedBlock, ExtractedDocument, SemanticRole

TEX_STRUCTURE_VERSION = "1.0"
_MAX_TEX_FILES = 256
_MAX_TEX_BYTES = 12 * 1024 * 1024
_INCLUDE = re.compile(r"\\(?:input|include)\s*\{([^{}]+)\}")
_COMMENT = re.compile(r"(?<!\\)%[^\n]*")
_COMMAND = re.compile(
    r"\\(?P<name>title|section|subsection|subsubsection|paragraph|begin)\*?"
)
_FORMATTING = re.compile(
    r"\\(?:textbf|textit|emph|textrm|textsf|texttt|underline|mbox)\s*\{([^{}]*)\}"
)
_CITATION = re.compile(r"\\(?:cite|citep|citet)\s*\{([^{}]+)\}")
_REFERENCE = re.compile(r"\\(?:ref|eqref|autoref)\s*\{([^{}]+)\}")
_LABEL = re.compile(r"\\label\s*\{([^{}]+)\}")
_CAPTION = re.compile(r"\\caption(?:\[[^\]]*\])?\s*\{")
_BIBITEM = re.compile(r"\\bibitem(?:\[[^\]]*\])?\s*\{([^{}]+)\}")
_TOKEN = re.compile(r"[\w\u00c0-\uffff]+", re.UNICODE)


class TexStructureError(RuntimeError):
    pass


@dataclass(frozen=True)
class _SourceBlock:
    kind: BlockKind
    text: str
    section_path: list[str]
    semantic_role: SemanticRole | None
    source_anchor: dict[str, Any]


class TexStructureExtractor:
    name = "tex-structure"
    version = TEX_STRUCTURE_VERSION

    def enrich(
        self, source_path: Path, layout: ExtractedDocument
    ) -> ExtractedDocument:
        sources = _read_tex_sources(source_path)
        main = _select_main(sources)
        expanded = _expand_includes(main, sources, ())
        return parse_tex_document(expanded, layout, source_name=main)


def parse_tex_document(
    source: str,
    layout: ExtractedDocument,
    *,
    source_name: str = "main.tex",
) -> ExtractedDocument:
    source_blocks = _parse_tex(source, source_name)
    if not source_blocks:
        raise TexStructureError("TeX 源码没有可读取的正文结构")
    blocks, matched = _attach_pdf_anchors(source_blocks, layout.blocks)
    return ExtractedDocument(
        language=layout.language,
        page_count=layout.page_count,
        blocks=blocks,
        diagnostics={
            **layout.diagnostics,
            "structure_source": "tex",
            "tex_main": source_name,
            "tex_blocks": len(source_blocks),
            "tex_pdf_anchor_matches": matched,
            "pdf_layout_source": layout.diagnostics.get("source", "pdf"),
        },
    )


def _read_tex_sources(path: Path) -> dict[str, str]:
    if not path.is_file():
        raise TexStructureError("TeX 源附件不存在")
    sources: dict[str, bytes] = {}
    if zipfile.is_zipfile(path):
        try:
            with zipfile.ZipFile(path) as archive:
                for info in archive.infolist():
                    if info.is_dir() or not info.filename.casefold().endswith(".tex"):
                        continue
                    name = _safe_name(info.filename)
                    _reserve_source(sources, name, info.file_size)
                    sources[name] = archive.read(info)
        except (OSError, ValueError, zipfile.BadZipFile) as error:
            raise TexStructureError("TeX ZIP 源附件无法安全读取") from error
    elif tarfile.is_tarfile(path):
        try:
            with tarfile.open(path, mode="r:*") as archive:
                for member in archive.getmembers():
                    if not member.isfile() or not member.name.casefold().endswith(".tex"):
                        continue
                    name = _safe_name(member.name)
                    _reserve_source(sources, name, member.size)
                    stream = archive.extractfile(member)
                    if stream is None:
                        raise TexStructureError("TeX TAR 源附件包含不可读取的成员")
                    sources[name] = stream.read(_MAX_TEX_BYTES + 1)
        except (OSError, ValueError, tarfile.TarError) as error:
            raise TexStructureError("TeX TAR 源附件无法安全读取") from error
    else:
        size = path.stat().st_size
        if size > _MAX_TEX_BYTES:
            raise TexStructureError("TeX 源文件超过结构提取安全上限")
        sources[_safe_name(path.name)] = path.read_bytes()
    if not sources:
        raise TexStructureError("源附件中没有 TeX 文件")
    if sum(len(value) for value in sources.values()) > _MAX_TEX_BYTES:
        raise TexStructureError("TeX 源文件总量超过结构提取安全上限")
    return {name: _decode(value) for name, value in sources.items()}


def _reserve_source(sources: dict[str, bytes], name: str, size: int) -> None:
    if len(sources) >= _MAX_TEX_FILES:
        raise TexStructureError("TeX 源附件包含过多文件")
    if size < 0 or size > _MAX_TEX_BYTES:
        raise TexStructureError("TeX 源文件超过结构提取安全上限")
    if name in sources:
        raise TexStructureError("TeX 源附件包含重复路径")


def _safe_name(value: str) -> str:
    normalized = value.replace("\\", "/")
    path = PurePosixPath(normalized)
    if path.is_absolute() or not path.parts or any(part in {"", ".", ".."} for part in path.parts):
        raise TexStructureError("TeX 源附件包含不安全路径")
    return path.as_posix()


def _decode(value: bytes) -> str:
    if len(value) > _MAX_TEX_BYTES:
        raise TexStructureError("TeX 源文件超过结构提取安全上限")
    try:
        return value.decode("utf-8-sig")
    except UnicodeDecodeError:
        return value.decode("latin-1")


def _select_main(sources: dict[str, str]) -> str:
    def score(item: tuple[str, str]) -> tuple[int, int, int, str]:
        name, text = item
        value = (
            (8 if "\\documentclass" in text else 0)
            + (5 if "\\begin{document}" in text else 0)
            + (3 if PurePosixPath(name).name.casefold() in {"main.tex", "paper.tex"} else 0)
        )
        return (-value, len(PurePosixPath(name).parts), len(name), name.casefold())

    selected, payload = min(sources.items(), key=score)
    if "\\documentclass" not in payload and len(sources) > 1:
        raise TexStructureError("无法确定 TeX 主文件")
    return selected


def _expand_includes(
    name: str,
    sources: dict[str, str],
    stack: tuple[str, ...],
) -> str:
    if name in stack:
        raise TexStructureError("TeX 源文件包含循环引用")
    text = _COMMENT.sub("", sources[name])
    parent = PurePosixPath(name).parent

    def replace(match: re.Match[str]) -> str:
        literal = match.group(1).strip().replace("\\", "/")
        candidate = parent / literal
        if not candidate.suffix:
            candidate = candidate.with_suffix(".tex")
        candidate_name = _safe_name(candidate.as_posix())
        if candidate_name not in sources:
            return ""
        return _expand_includes(candidate_name, sources, (*stack, name))

    return _INCLUDE.sub(replace, text)


def _parse_tex(source: str, main: str) -> list[_SourceBlock]:
    title = _command_argument(source, "title")
    begin_document = source.find("\\begin{document}")
    end_document = source.rfind("\\end{document}")
    body = source[
        begin_document + len("\\begin{document}") if begin_document >= 0 else 0 :
        end_document if end_document >= 0 else len(source)
    ]
    blocks: list[_SourceBlock] = []
    if title:
        blocks.append(_block(BlockKind.TITLE, title, [], main, "title"))
    section_path: list[str] = []
    cursor = 0
    while cursor < len(body):
        match = _COMMAND.search(body, cursor)
        if match is None:
            _append_plain(blocks, body[cursor:], section_path, main)
            break
        _append_plain(blocks, body[cursor:match.start()], section_path, main)
        name = match.group("name")
        if name == "begin":
            environment, argument_end = _braced(body, match.end())
            if environment is None:
                cursor = match.end()
                continue
            end_marker = f"\\end{{{environment}}}"
            environment_end = body.find(end_marker, argument_end)
            if environment_end < 0:
                cursor = argument_end
                continue
            content = body[argument_end:environment_end]
            _append_environment(blocks, environment, content, section_path, main)
            cursor = environment_end + len(end_marker)
            continue
        argument, argument_end = _braced(body, match.end())
        if argument is None:
            cursor = match.end()
            continue
        cleaned = _plain_text(argument)
        if cleaned:
            level = {"section": 1, "subsection": 2, "subsubsection": 3, "paragraph": 4}.get(name)
            if level is not None:
                section_path = [*section_path[: level - 1], cleaned]
                blocks.append(_block(BlockKind.HEADING, cleaned, section_path, main, name))
        cursor = argument_end
    return blocks


def _append_plain(
    blocks: list[_SourceBlock], value: str, section_path: list[str], main: str
) -> None:
    value = re.sub(r"\\(?:maketitle|tableofcontents|newpage|clearpage)\b", "", value)
    for paragraph in re.split(r"\n\s*\n", value):
        text = _plain_text(paragraph)
        if text and len(text) > 1:
            blocks.append(_block(BlockKind.PARAGRAPH, text, section_path, main, "paragraph"))


def _append_environment(
    blocks: list[_SourceBlock],
    environment: str,
    content: str,
    section_path: list[str],
    main: str,
) -> None:
    normalized = environment.rstrip("*").casefold()
    if normalized in {"equation", "align", "gather", "multline", "math", "displaymath"}:
        formula = content.strip()
        if formula:
            blocks.append(_block(BlockKind.FORMULA, formula, section_path, main, environment))
        return
    if normalized in {"figure", "table"}:
        caption = _caption(content)
        label = _LABEL.search(content)
        kind = BlockKind.FIGURE if normalized == "figure" else BlockKind.TABLE
        text = caption or (
            f"{normalized.title()} {label.group(1)}" if label else normalized.title()
        )
        blocks.append(
            _block(
                kind,
                text,
                section_path,
                main,
                environment,
                relation=label.group(1) if label else None,
            )
        )
        return
    if normalized in {"itemize", "enumerate", "description"}:
        for item in re.split(r"\\item(?:\[[^\]]*\])?", content)[1:]:
            text = _plain_text(item)
            if text:
                blocks.append(_block(BlockKind.LIST, text, section_path, main, environment))
        return
    if normalized == "abstract":
        abstract_path = ["Abstract"]
        for paragraph in re.split(r"\n\s*\n", content):
            text = _plain_text(paragraph)
            if text:
                blocks.append(
                    _block(
                        BlockKind.PARAGRAPH,
                        text,
                        abstract_path,
                        main,
                        environment,
                        semantic_role=SemanticRole.BACKGROUND,
                    )
                )
        return
    if normalized == "thebibliography":
        matches = list(_BIBITEM.finditer(content))
        for index, match in enumerate(matches):
            end = matches[index + 1].start() if index + 1 < len(matches) else len(content)
            text = _plain_text(content[match.end():end])
            if text:
                blocks.append(
                    _block(
                        BlockKind.REFERENCE,
                        f"[{match.group(1)}] {text}",
                        ["References"],
                        main,
                        environment,
                    )
                )
        return
    _append_plain(blocks, content, section_path, main)


def _block(
    kind: BlockKind,
    text: str,
    section_path: list[str],
    main: str,
    source_type: str,
    *,
    relation: str | None = None,
    semantic_role: SemanticRole | None = None,
) -> _SourceBlock:
    return _SourceBlock(
        kind=kind,
        text=text,
        section_path=list(section_path),
        semantic_role=semantic_role or _semantic_role(" ".join(section_path)),
        source_anchor={
            "type": "tex_source",
            "file": main,
            "construct": source_type,
            **({"relation": relation} if relation else {}),
        },
    )


def _attach_pdf_anchors(
    source_blocks: list[_SourceBlock], pdf_blocks: list[ExtractedBlock]
) -> tuple[list[ExtractedBlock], int]:
    result: list[ExtractedBlock] = []
    used: set[int] = set()
    matched = 0
    for source in source_blocks:
        best_index = None
        best_score = 0.0
        for index, pdf in enumerate(pdf_blocks):
            if index in used or not pdf.source_text or not _compatible(source.kind, pdf.kind):
                continue
            score = _similarity(source.text, pdf.source_text)
            if source.kind is pdf.kind:
                score += 0.08
            if score > best_score:
                best_index, best_score = index, score
        threshold = 0.34 if source.kind in {BlockKind.TITLE, BlockKind.HEADING} else 0.46
        pdf = pdf_blocks[best_index] if best_index is not None and best_score >= threshold else None
        if pdf is not None and best_index is not None:
            used.add(best_index)
            matched += 1
        anchor = dict(source.source_anchor)
        if pdf is not None:
            anchor = {**pdf.anchor, "structure_source": source.source_anchor}
        result.append(
            ExtractedBlock(
                kind=source.kind,
                semantic_role=source.semantic_role or (pdf.semantic_role if pdf else None),
                source_text=source.text,
                page_start=pdf.page_start if pdf else None,
                page_end=pdf.page_end if pdf else None,
                anchor=anchor,
                section_path=source.section_path,
            )
        )
    return result, matched


def _compatible(source: BlockKind, pdf: BlockKind) -> bool:
    if source in {BlockKind.TITLE, BlockKind.HEADING}:
        return pdf in {BlockKind.TITLE, BlockKind.HEADING}
    if source in {BlockKind.FORMULA, BlockKind.FIGURE, BlockKind.TABLE}:
        return source is pdf
    return pdf not in {BlockKind.TITLE, BlockKind.HEADING, BlockKind.FORMULA}


def _similarity(left: str, right: str) -> float:
    left_normalized = _match_text(left)
    right_normalized = _match_text(right)
    if not left_normalized or not right_normalized:
        return 0.0
    if left_normalized in right_normalized or right_normalized in left_normalized:
        length_ratio = min(len(left_normalized), len(right_normalized)) / max(
            len(left_normalized), len(right_normalized)
        )
        return 0.72 + 0.28 * length_ratio
    left_tokens = set(_TOKEN.findall(left_normalized))
    right_tokens = set(_TOKEN.findall(right_normalized))
    overlap = len(left_tokens & right_tokens) / max(1, len(left_tokens | right_tokens))
    sequence = SequenceMatcher(None, left_normalized, right_normalized, autojunk=False).ratio()
    return max(overlap, sequence)


def _match_text(value: str) -> str:
    value = _plain_text(value).casefold()
    return " ".join(_TOKEN.findall(value))


def _plain_text(value: str) -> str:
    value = _COMMENT.sub("", value)
    value = _CITATION.sub(lambda match: f"[cite:{match.group(1)}]", value)
    value = _REFERENCE.sub(lambda match: f"[ref:{match.group(1)}]", value)
    value = _LABEL.sub("", value)
    for _ in range(8):
        updated = _FORMATTING.sub(r"\1", value)
        if updated == value:
            break
        value = updated
    value = re.sub(r"\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?", "", value)
    value = value.replace("~", " ").replace("\\\\", "\n")
    value = value.replace("{", "").replace("}", "")
    return re.sub(r"\s+", " ", value).strip()


def _command_argument(source: str, name: str) -> str | None:
    match = re.search(rf"\\{re.escape(name)}\*?", source)
    if match is None:
        return None
    value, _ = _braced(source, match.end())
    return _plain_text(value) if value is not None else None


def _caption(content: str) -> str | None:
    match = _CAPTION.search(content)
    if match is None:
        return None
    value, _ = _braced(content, match.end() - 1)
    return _plain_text(value) if value is not None else None


def _braced(source: str, offset: int) -> tuple[str | None, int]:
    while offset < len(source) and source[offset].isspace():
        offset += 1
    if offset >= len(source) or source[offset] != "{":
        return None, offset
    depth = 0
    start = offset + 1
    for index in range(offset, len(source)):
        if source[index] == "{" and (index == 0 or source[index - 1] != "\\"):
            depth += 1
        elif source[index] == "}" and (index == 0 or source[index - 1] != "\\"):
            depth -= 1
            if depth == 0:
                return source[start:index], index + 1
    return None, offset


def _semantic_role(value: str) -> SemanticRole | None:
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
    if any(
        token in heading
        for token in ("background", "introduction", "related work", "abstract")
    ):
        return SemanticRole.BACKGROUND
    return None


def read_tex_bytes(value: bytes, filename: str = "main.tex") -> dict[str, str]:
    """Test-facing helper that uses the same bounded source decoder."""

    path = PurePosixPath(_safe_name(filename))
    if path.suffix.casefold() != ".tex":
        raise TexStructureError("测试源必须是 TeX 文件")
    return {path.as_posix(): _decode(io.BytesIO(value).read(_MAX_TEX_BYTES + 1))}
