from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import httpx
from lxml import etree, html as lxml_html
from pylatexenc.latexwalker import (
    LatexCharsNode,
    LatexEnvironmentNode,
    LatexGroupNode,
    LatexMacroNode,
    LatexMathNode,
    LatexWalker,
)

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
)
from .workspace import atomic_write_text, require_workspace_path


TRANSLATE_CACHE_VERSION = "translate-v3"
TRANSLATABLE = re.compile(r"[A-Za-z\u3400-\u9fff]")

MARKDOWN_PROTECTED = re.compile(
    r"(```.*?```|~~~.*?~~~|\$\$.*?\$\$|(?<!\$)\$(?!\$).*?(?<!\$)\$(?!\$)|"
    r"!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\)|"
    r"<a\s+id=[\"']page-\d+[\"']></a>|"
    r"`[^`\n]+`|\[(?:\d+(?:\s*[-,]\s*\d+)*)\])",
    re.DOTALL,
)
MARKDOWN_STRUCTURE = re.compile(
    r"(```|~~~|^#{1,6}\s|^\s*(?:[-*+]|\d+\.)\s+|"
    r"^\s*\|.*\|\s*$|!\[[^\]]*\]\([^)]+\)|"
    r"\[[^\]]+\]\([^)]+\)|\$\$|(?<!\$)\$(?!\$)|"
    r"<a\s+id=[\"']page-\d+[\"']></a>)",
    re.MULTILINE,
)

HTML_SKIPPED_TAGS = {"script", "style", "code", "pre", "math", "svg"}
TEX_SKIPPED_MACROS = {
    "cite",
    "citep",
    "citet",
    "ref",
    "eqref",
    "label",
    "url",
    "href",
    "includegraphics",
    "input",
    "include",
    "bibliography",
    "bibliographystyle",
}
TEX_SKIPPED_ENVIRONMENTS = {
    "equation",
    "equation*",
    "align",
    "align*",
    "gather",
    "gather*",
    "verbatim",
    "lstlisting",
    "minted",
    "tikzpicture",
}


@dataclass(frozen=True, slots=True)
class Fragment:
    identifier: str
    text: str


def _request_fragments(
    fragments: list[Fragment],
    target: str,
    document_format: str,
    config: Config,
) -> dict[str, str]:
    key_env = str(config.translate.get("api_key_env", "OPENAI_API_KEY"))
    api_key = os.getenv(key_env)
    if not api_key:
        raise HxrError(f"Translation API key is missing from environment: {key_env}")

    payload_items = [
        {"id": fragment.identifier, "text": fragment.text}
        for fragment in fragments
    ]
    payload = {
        "model": config.translate["model"],
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [
            {
                "role": "system",
                "content": (
                    f"Translate academic {document_format} text into {target}. "
                    "Return one JSON object with an `items` array. Preserve every "
                    "item id exactly, keep placeholders unchanged, do not add or "
                    "remove items, and return only JSON."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {"items": payload_items}, ensure_ascii=False
                ),
            },
        ],
    }
    base_url = str(config.translate["base_url"]).rstrip("/")
    try:
        with httpx.Client(timeout=120) as client:
            response = client.post(
                f"{base_url}/chat/completions",
                headers={"Authorization": f"Bearer {api_key}"},
                json=payload,
            )
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"]
            returned = json.loads(content)["items"]
    except (
        httpx.HTTPError,
        json.JSONDecodeError,
        KeyError,
        IndexError,
        TypeError,
    ) as exc:
        raise HxrError(f"Translation API request failed: {exc}") from exc

    result: dict[str, str] = {}
    for item in returned:
        identifier = str(item["id"])
        if identifier in result:
            raise HxrError(f"Translation returned duplicate fragment: {identifier}")
        result[identifier] = str(item["text"])
    expected = {fragment.identifier for fragment in fragments}
    if set(result) != expected:
        raise HxrError("Translation changed the fragment id set.")
    return result


def _batches(fragments: list[Fragment], limit: int) -> list[list[Fragment]]:
    batches: list[list[Fragment]] = []
    current: list[Fragment] = []
    size = 0
    for fragment in fragments:
        if current and size + len(fragment.text) > limit:
            batches.append(current)
            current = []
            size = 0
        current.append(fragment)
        size += len(fragment.text)
    if current:
        batches.append(current)
    return batches


def _translate_fragments(
    fragments: list[Fragment],
    target: str,
    document_format: str,
    config: Config,
    progress: Path,
    requester: Callable[
        [list[Fragment], str, str, Config], dict[str, str]
    ] = _request_fragments,
) -> dict[str, str]:
    translations: dict[str, str] = {}
    progress.mkdir(parents=True, exist_ok=True)
    for batch_number, batch in enumerate(
        _batches(fragments, int(config.translate.get("block_chars", 6000)))
    ):
        batch_path = progress / f"{batch_number:05d}.json"
        if batch_path.exists():
            saved = json.loads(batch_path.read_text(encoding="utf-8"))
            translated = {str(key): str(value) for key, value in saved.items()}
        else:
            translated = requester(batch, target, document_format, config)
            expected = {fragment.identifier for fragment in batch}
            if set(translated) != expected:
                raise HxrError("Translation changed the fragment id set.")
            atomic_write_text(
                batch_path,
                json.dumps(translated, ensure_ascii=False, indent=2) + "\n",
            )
        translations.update(translated)
    return translations


def _protect_markdown(value: str) -> tuple[str, dict[str, str]]:
    placeholders: dict[str, str] = {}

    def replace(match: re.Match[str]) -> str:
        token = f"[[HXR_PROTECTED_{len(placeholders):05d}]]"
        placeholders[token] = match.group(0)
        return token

    return MARKDOWN_PROTECTED.sub(replace, value), placeholders


def _restore_placeholders(value: str, placeholders: dict[str, str]) -> str:
    for token, original in placeholders.items():
        if token not in value:
            raise HxrError(f"Translation removed protected placeholder: {token}")
        value = value.replace(token, original)
    if "[[HXR_PROTECTED_" in value:
        raise HxrError("Translation returned an unknown protected placeholder.")
    return value


def _markdown_signature(value: str) -> tuple[str, ...]:
    return tuple(MARKDOWN_STRUCTURE.findall(value))


def _translate_markdown(
    source: str,
    target: str,
    config: Config,
    progress: Path,
) -> str:
    protected, placeholders = _protect_markdown(source)
    fragments: list[Fragment] = []
    parts = re.split(r"(\n\s*\n)", protected)
    for index, part in enumerate(parts):
        if TRANSLATABLE.search(part) and not part.isspace():
            fragments.append(Fragment(f"md-{index:06d}", part))
    translated = _translate_fragments(
        fragments, target, "markdown", config, progress
    )
    for fragment in fragments:
        parts[int(fragment.identifier.split("-")[1])] = translated[
            fragment.identifier
        ]
    result = _restore_placeholders("".join(parts), placeholders)
    if _markdown_signature(result) != _markdown_signature(source):
        raise HxrError("Translation changed protected Markdown structure.")
    return result


def _html_signature(root: etree._Element) -> tuple[tuple[str, tuple], ...]:
    return tuple(
        (
            str(element.tag).lower(),
            tuple(sorted((str(key), str(value)) for key, value in element.attrib.items())),
        )
        for element in root.iter()
        if isinstance(element.tag, str)
    )


def _translate_html(
    source: str,
    target: str,
    config: Config,
    progress: Path,
) -> str:
    try:
        root = lxml_html.document_fromstring(source)
    except (ValueError, TypeError) as exc:
        raise HxrError(f"Invalid HTML input: {exc}") from exc
    signature = _html_signature(root)
    setters: dict[str, tuple[etree._Element, str]] = {}
    fragments: list[Fragment] = []
    index = 0
    for element in root.iter():
        if not isinstance(element.tag, str):
            continue
        skipped = str(element.tag).lower() in HTML_SKIPPED_TAGS or any(
            isinstance(ancestor.tag, str)
            and str(ancestor.tag).lower() in HTML_SKIPPED_TAGS
            for ancestor in element.iterancestors()
        )
        if not skipped and element.text and TRANSLATABLE.search(element.text):
            identifier = f"html-{index:06d}"
            fragments.append(Fragment(identifier, element.text))
            setters[identifier] = (element, "text")
            index += 1
        tail_skipped = any(
            isinstance(ancestor.tag, str)
            and str(ancestor.tag).lower() in HTML_SKIPPED_TAGS
            for ancestor in element.iterancestors()
        )
        if (
            not tail_skipped
            and element.tail
            and TRANSLATABLE.search(element.tail)
        ):
            identifier = f"html-{index:06d}"
            fragments.append(Fragment(identifier, element.tail))
            setters[identifier] = (element, "tail")
            index += 1
    translated = _translate_fragments(fragments, target, "html", config, progress)
    for identifier, value in translated.items():
        element, attribute = setters[identifier]
        setattr(element, attribute, value)
    if _html_signature(root) != signature:
        raise HxrError("Translation changed protected HTML structure.")
    return lxml_html.tostring(
        root,
        encoding="unicode",
        method="html",
        doctype="<!DOCTYPE html>",
    )


def _tex_signature(value: str) -> tuple[tuple[str, str], ...]:
    nodes, _, _ = LatexWalker(value).get_latex_nodes()
    signature: list[tuple[str, str]] = []

    def visit(node_list: list) -> None:
        for node in node_list:
            if isinstance(node, LatexMacroNode):
                signature.append(("macro", node.macroname))
            elif isinstance(node, LatexEnvironmentNode):
                signature.append(("environment", node.environmentname))
            elif isinstance(node, LatexMathNode):
                signature.append(("math", node.delimiters[0]))
            child_nodes = getattr(node, "nodelist", None)
            if child_nodes:
                visit(child_nodes)
            nodeargd = getattr(node, "nodeargd", None)
            if nodeargd:
                for argument in nodeargd.argnlist:
                    if isinstance(argument, LatexGroupNode):
                        visit(argument.nodelist)

    visit(nodes)
    return tuple(signature)


def _tex_fragments(source: str) -> tuple[list[Fragment], dict[str, tuple[int, int]]]:
    nodes, _, _ = LatexWalker(source).get_latex_nodes()
    fragments: list[Fragment] = []
    positions: dict[str, tuple[int, int]] = {}

    def visit(node_list: list, protected: bool = False) -> None:
        for node in node_list:
            node_protected = protected
            if isinstance(node, LatexMathNode):
                node_protected = True
            elif isinstance(node, LatexEnvironmentNode):
                node_protected = (
                    protected or node.environmentname in TEX_SKIPPED_ENVIRONMENTS
                )
            elif isinstance(node, LatexMacroNode):
                node_protected = protected or node.macroname in TEX_SKIPPED_MACROS

            if (
                isinstance(node, LatexCharsNode)
                and not node_protected
                and TRANSLATABLE.search(node.chars)
            ):
                identifier = f"tex-{len(fragments):06d}"
                fragments.append(Fragment(identifier, node.chars))
                positions[identifier] = (node.pos, node.len)
                continue

            child_nodes = getattr(node, "nodelist", None)
            if child_nodes:
                visit(child_nodes, node_protected)
            nodeargd = getattr(node, "nodeargd", None)
            if nodeargd:
                for argument in nodeargd.argnlist:
                    if isinstance(argument, LatexGroupNode):
                        visit(argument.nodelist, node_protected)

    visit(nodes)
    return fragments, positions


def _translate_tex(
    source: str,
    target: str,
    config: Config,
    progress: Path,
) -> str:
    signature = _tex_signature(source)
    fragments, positions = _tex_fragments(source)
    translated = _translate_fragments(fragments, target, "tex", config, progress)
    result = source
    replacements = [
        (positions[identifier][0], positions[identifier][1], value)
        for identifier, value in translated.items()
    ]
    for position, length, value in sorted(replacements, reverse=True):
        result = result[:position] + value + result[position + length :]
    try:
        translated_signature = _tex_signature(result)
    except Exception as exc:
        raise HxrError(f"Translation produced invalid TeX: {exc}") from exc
    if translated_signature != signature:
        raise HxrError("Translation changed protected TeX structure.")
    return result


def translate_document(
    source: Path,
    output: Path,
    config: Config,
    target: str = "zh-CN",
    requested_format: str = "auto",
) -> tuple[Path, bool]:
    if not source.is_file():
        raise HxrError(f"Input document not found: {source}")
    document_format = detect_format(source, requested_format)
    validate_matching_output(source, output, document_format)
    output = require_workspace_path(output, config.workspace, "Translation output")
    output.parent.mkdir(parents=True, exist_ok=True)
    state = load_state(output.parent)
    input_digest = file_hash(source)
    config_digest = (
        f"{config.digest('translate')}:{target}:{document_format}:"
        f"{TRANSLATE_CACHE_VERSION}"
    )
    key = operation_key("translate", document_format, output)
    if cache_hit(state, key, input_digest, config_digest, output):
        return output, True

    progress = (
        output.parent
        / ".hxr-translation"
        / f"{document_format}-{input_digest[:16]}-{config_digest[:16]}"
    )
    translators = {
        "markdown": _translate_markdown,
        "html": _translate_html,
        "tex": _translate_tex,
    }
    try:
        result = translators[document_format](
            source.read_text(encoding="utf-8"), target, config, progress
        )
        atomic_write_text(output, result)
        complete_stage(state, key, input_digest, config_digest, output)
        state["operations"][key]["fragments_dir"] = str(progress.resolve())
        save_state(output.parent, state)
        return output, False
    except Exception as exc:
        fail_stage(state, key, input_digest, config_digest, exc)
        save_state(output.parent, state)
        raise
