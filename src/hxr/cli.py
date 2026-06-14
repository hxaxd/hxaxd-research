from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .config import load_config
from .doctor import doctor_exit_code, run_doctor
from .errors import HxrError
from .parse import parse_pdf
from .reflow import reflow_document
from .render import render_document
from .translate import translate_document


def _format_argument(parser: argparse.ArgumentParser, *, render: bool = False) -> None:
    choices = ["auto", "markdown", "html"]
    if not render:
        choices.append("tex")
    parser.add_argument("--format", choices=choices, default="auto")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="hxr")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("doctor", help="Check the local processing environment")

    parse = sub.add_parser("parse", help="Parse a PDF into Chinese-named assets")
    parse.add_argument("pdf", type=Path)
    parse.add_argument("--out", type=Path, required=True)

    translate = sub.add_parser(
        "translate", help="Translate Markdown, HTML, or TeX"
    )
    translate.add_argument("source", type=Path)
    translate.add_argument("--out", type=Path, required=True)
    translate.add_argument("--target", default="zh-CN")
    _format_argument(translate)

    reflow = sub.add_parser(
        "reflow", help="Normalize document structure without rewriting content"
    )
    reflow.add_argument("source", type=Path)
    reflow.add_argument("--out", type=Path, required=True)
    _format_argument(reflow)

    render = sub.add_parser("render", help="Render Markdown or HTML to PDF")
    render.add_argument("source", type=Path)
    render.add_argument("--out", type=Path, required=True)
    _format_argument(render, render=True)
    return parser


def run(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    config = load_config()
    if args.command == "doctor":
        checks = run_doctor(config)
        for check in checks:
            print(f"[{check.status}] {check.name}: {check.detail}")
        return doctor_exit_code(checks)
    if args.command == "parse":
        path, cached = parse_pdf(args.pdf, args.out, config)
    elif args.command == "translate":
        path, cached = translate_document(
            args.source, args.out, config, args.target, args.format
        )
    elif args.command == "reflow":
        path, cached = reflow_document(
            args.source, args.out, config, args.format
        )
    else:
        path, cached = render_document(
            args.source, args.out, config, args.format
        )
    print(f"{'cached' if cached else 'wrote'}: {path}")
    return 0


def main() -> None:
    try:
        raise SystemExit(run())
    except (HxrError, OSError, ValueError) as exc:
        print(f"hxr: error: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc


if __name__ == "__main__":
    main()
