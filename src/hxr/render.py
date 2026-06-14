from __future__ import annotations

import html
import os
import tempfile
from pathlib import Path

import markdown
from lxml import etree, html as lxml_html

from .config import Config
from .errors import HxrError
from .formats import detect_format
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


RENDER_CACHE_VERSION = "render-v2"

CSS = """
@page { size: A4; margin: 20mm 18mm; }
body { font-family: "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
       color: #202124; font-size: 11pt; line-height: 1.75; }
h1, h2, h3, h4 { color: #111827; page-break-after: avoid; }
p { text-align: justify; }
pre, code { font-family: Consolas, monospace; white-space: pre-wrap; }
img { max-width: 100%; page-break-inside: avoid; }
table { width: 100%; border-collapse: collapse; page-break-inside: avoid; }
th, td { border: 1px solid #9ca3af; padding: 5px; }
a { color: #1d4ed8; text-decoration: none; }
"""


def _html_document(source: Path, document_format: str) -> str:
    content = source.read_text(encoding="utf-8")
    if document_format == "markdown":
        body = markdown.markdown(
            content,
            extensions=["tables", "fenced_code", "sane_lists"],
        )
        title = html.escape(source.stem)
        base = html.escape(source.parent.resolve().as_uri() + "/")
        return (
            "<!doctype html><html><head><meta charset='utf-8'>"
            f"<base href='{base}'><title>{title}</title><style>{CSS}</style></head>"
            f"<body>{body}</body></html>"
        )

    try:
        document = lxml_html.document_fromstring(content)
    except (ValueError, TypeError) as exc:
        raise HxrError(f"Invalid HTML input: {exc}") from exc
    head = document.find("head")
    if head is None:
        head = etree.Element("head")
        document.insert(0, head)
    base_element = etree.Element("base")
    base_element.set("href", source.parent.resolve().as_uri() + "/")
    style_element = etree.Element("style")
    style_element.text = CSS
    head.insert(0, base_element)
    head.append(style_element)
    return lxml_html.tostring(
        document,
        encoding="unicode",
        method="html",
        doctype="<!DOCTYPE html>",
    )


def render_document(
    source: Path,
    output: Path,
    config: Config,
    requested_format: str = "auto",
) -> tuple[Path, bool]:
    if not source.is_file():
        raise HxrError(f"Input document not found: {source}")
    document_format = detect_format(source, requested_format, render=True)
    if output.suffix.lower() != ".pdf":
        raise HxrError(f"Rendered output must use a .pdf extension: {output}")
    output = require_workspace_path(output, config.workspace, "Rendered PDF")
    output.parent.mkdir(parents=True, exist_ok=True)
    state = load_state(output.parent)
    input_digest = file_hash(source)
    config_digest = (
        f"{config.digest('render')}:{document_format}:{RENDER_CACHE_VERSION}"
    )
    key = operation_key("render", document_format, output)
    if cache_hit(state, key, input_digest, config_digest, output):
        return output, True

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output.name}.", suffix=".tmp.pdf", dir=output.parent
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:
            raise HxrError("Playwright is unavailable. Run: uv sync") from exc

        with sync_playwright() as playwright:
            browser_name = str(config.render.get("browser", "chromium"))
            browser_type = getattr(playwright, browser_name)
            browser = browser_type.launch()
            try:
                page = browser.new_page()
                page.set_content(
                    _html_document(source, document_format), wait_until="load"
                )
                page.emulate_media(media="screen")
                page.pdf(
                    path=str(temporary),
                    format="A4",
                    print_background=True,
                    margin={
                        "top": "20mm",
                        "right": "18mm",
                        "bottom": "20mm",
                        "left": "18mm",
                    },
                )
            finally:
                browser.close()
        os.replace(temporary, output)
        complete_stage(state, key, input_digest, config_digest, output)
        save_state(output.parent, state)
        return output, False
    except Exception as exc:
        error = (
            exc
            if isinstance(exc, HxrError)
            else HxrError(
                "Chromium rendering failed. Run: uv run playwright install chromium"
            )
        )
        fail_stage(state, key, input_digest, config_digest, error)
        save_state(output.parent, state)
        if error is exc:
            raise
        raise error from exc
    finally:
        temporary.unlink(missing_ok=True)
