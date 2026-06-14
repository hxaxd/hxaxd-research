from __future__ import annotations

import re
from pathlib import Path

from lxml import html as lxml_html

from .config import Config
from .errors import HxrError
from .formats import detect_format, validate_matching_output
from .state import (
    cache_hit,
    complete_stage,
    fail_stage,
    file_hash,
    load_state,
    operation_key,
    save_state,
    text_hash,
)
from .workspace import atomic_write_text, require_workspace_path


REFLOW_VERSION = "reflow-v1"


def _clean_lines(value: str) -> str:
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    lines = [line.rstrip() for line in value.split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip() + "\n"


def reflow_markdown(value: str) -> str:
    value = _clean_lines(value)
    value = re.sub(r"^(#{1,6})([^\s#])", r"\1 \2", value, flags=re.MULTILINE)
    value = re.sub(
        r"(?<!\n)\n(!\[[^\]]*\]\([^)]+\))", r"\n\n\1", value
    )
    value = re.sub(
        r"(!\[[^\]]*\]\([^)]+\))\n(?!\n)", r"\1\n\n", value
    )
    return _clean_lines(value)


def reflow_html(value: str) -> str:
    try:
        document = lxml_html.document_fromstring(value)
    except (ValueError, TypeError) as exc:
        raise HxrError(f"Invalid HTML input: {exc}") from exc
    rendered = lxml_html.tostring(
        document,
        encoding="unicode",
        method="html",
        pretty_print=True,
        doctype="<!DOCTYPE html>",
    )
    return _clean_lines(rendered)


def reflow_tex(value: str) -> str:
    return _clean_lines(value)


def reflow_document(
    source: Path,
    output: Path,
    config: Config,
    requested_format: str = "auto",
) -> tuple[Path, bool]:
    if not source.is_file():
        raise HxrError(f"Input document not found: {source}")
    document_format = detect_format(source, requested_format)
    validate_matching_output(source, output, document_format)
    output = require_workspace_path(output, config.workspace, "Reflow output")
    state = load_state(output.parent)
    input_digest = file_hash(source)
    config_digest = text_hash(f"{REFLOW_VERSION}:{document_format}")
    key = operation_key("reflow", document_format, output)
    if cache_hit(state, key, input_digest, config_digest, output):
        return output, True

    transforms = {
        "markdown": reflow_markdown,
        "html": reflow_html,
        "tex": reflow_tex,
    }
    try:
        result = transforms[document_format](source.read_text(encoding="utf-8"))
        atomic_write_text(output, result)
        complete_stage(state, key, input_digest, config_digest, output)
        save_state(output.parent, state)
        return output, False
    except Exception as exc:
        fail_stage(state, key, input_digest, config_digest, exc)
        save_state(output.parent, state)
        raise
