from __future__ import annotations

from pathlib import Path

from .errors import HxrError


FORMATS = ("markdown", "html", "tex")
RENDER_FORMATS = ("markdown", "html")

EXTENSIONS = {
    ".md": "markdown",
    ".markdown": "markdown",
    ".html": "html",
    ".htm": "html",
    ".tex": "tex",
}


def detect_format(path: Path, requested: str, *, render: bool = False) -> str:
    allowed = RENDER_FORMATS if render else FORMATS
    if requested != "auto":
        if requested not in allowed:
            raise HxrError(
                f"Unsupported format for this command: {requested}. "
                f"Choose from: {', '.join(allowed)}"
            )
        document_format = requested
    else:
        document_format = EXTENSIONS.get(path.suffix.lower(), "")
        if document_format not in allowed:
            raise HxrError(
                f"Cannot infer the input format from {path.name}. "
                "Pass --format explicitly."
            )
    return document_format


def validate_matching_output(source: Path, output: Path, document_format: str) -> None:
    inferred = EXTENSIONS.get(output.suffix.lower())
    if inferred != document_format:
        expected = {
            "markdown": ".md",
            "html": ".html",
            "tex": ".tex",
        }[document_format]
        raise HxrError(
            f"Translation output must keep the {document_format} format "
            f"(use a {expected} extension): {output}"
        )
