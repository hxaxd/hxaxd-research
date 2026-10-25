"""PaddleOCR document normalization and reading outputs."""
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import shutil

from markdown_it import MarkdownIt
from mdit_py_plugins.dollarmath import dollarmath_plugin
import pymupdf

PRESERVED = {"image", "figure", "chart", "seal", "formula", "display_formula", "formula_number", "number"}
HEADINGS = {"doc_title", "paragraph_title", "title", "section_title"}


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def save(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def resolve_resources(document, directory):
    document["source"] = str((Path(directory) / document["source"]).resolve())
    for block in blocks(document):
        if "image" in block:
            block["image"] = str((Path(directory) / block["image"]).resolve())
    return document


def load_document(path):
    return resolve_resources(load(path), Path(path).resolve().parent)


def normalize(source, raw_directory, output, title):
    pdf = pymupdf.open(source)
    raw_pages = [load(file) for file in Path(raw_directory).glob("*_res.json")]
    raw_pages.sort(key=lambda page: page["page_index"] if page["page_index"] is not None else 0)
    if len(raw_pages) != len(pdf):
        raise ValueError(f"OCR 返回 {len(raw_pages)} 页，原文有 {len(pdf)} 页；请检查原始识别结果")
    assets = Path(output) / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    pages = []
    for index, raw in enumerate(raw_pages):
        page = {"number": index + 1, "width": raw["width"], "height": raw["height"], "blocks": []}
        # The parsed array includes figures and captions omitted from block_order.
        for order, item in enumerate(raw["parsing_res_list"]):
            label = item["block_label"]
            block = {"id": f"p{index + 1:04}-b{item['block_id']:04}", "page": index + 1,
                     "order": order, "label": label, "bbox": item["block_bbox"],
                     "text": item["block_content"], "preserve": label in PRESERVED}
            if label in {"image", "figure", "chart", "seal"}:
                rect = block_rect(pdf[index], page, block)
                image = assets / f"{block['id']}.png"
                pdf[index].get_pixmap(matrix=pymupdf.Matrix(2, 2), clip=rect).save(image)
                block["image"] = f"assets/{image.name}"
            page["blocks"].append(block)
        pages.append(page)
    pdf.close()
    original = Path(output) / "source.pdf"
    if Path(source).resolve() != original.resolve():
        shutil.copyfile(source, original)
    result = {"source": "source.pdf", "title": title or Path(source).stem, "pages": pages}
    save(Path(output) / "document.json", result)
    return resolve_resources(result, Path(output).resolve())


def blocks(document):
    return [block for page in document["pages"] for block in page["blocks"]]


def block_rect(page, dimensions, block):
    x0, y0, x1, y1 = block["bbox"]
    return pymupdf.Rect(x0 / dimensions["width"] * page.rect.width,
                        y0 / dimensions["height"] * page.rect.height,
                        x1 / dimensions["width"] * page.rect.width,
                        y1 / dimensions["height"] * page.rect.height)


def translations(document, response):
    """Validate the external translation result once, before consuming its text."""
    items = response["blocks"]
    source = {block["id"]: block for block in blocks(document)}
    expected = list(source)
    received = [item["id"] for item in items]
    if len(set(received)) != len(received) or set(received) != set(expected):
        raise ValueError(f"译块 ID 不完整：缺少 {sorted(set(expected) - set(received))}；多出 {sorted(set(received) - set(expected))}；请修复译文文件")
    if any(not isinstance(item["text"], str) or (source[item["id"]]["text"].strip() and not item["text"].strip()) for item in items):
        raise ValueError("译块文本必须是非空字符串；请补齐译文")
    result = {item["id"]: item["text"] for item in items}
    for block in blocks(document):
        if block["preserve"] and result[block["id"]] != block["text"]:
            raise ValueError(f"保留块 {block['id']} 被修改，请恢复原文")
    return result


def markdown():
    parser = MarkdownIt("default", {"html": True}).use(dollarmath_plugin)
    parser.add_render_rule("math_inline", lambda renderer, tokens, index, options, env:
                           '<span class="math-inline">\\(' + html.escape(tokens[index].content) + '\\)</span>')
    parser.add_render_rule("math_block", lambda renderer, tokens, index, options, env:
                           '<div class="math-display">\\[' + html.escape(tokens[index].content) + '\\]</div>')
    return parser


class TableText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows, self.row, self.cell = [], None, None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self.row = []
        elif tag in {"td", "th"}:
            self.cell = []
        elif tag == "br" and self.cell is not None:
            self.cell.append(" ")

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)

    def handle_endtag(self, tag):
        if tag in {"td", "th"} and self.cell is not None:
            self.row.append("".join(self.cell).strip().replace("|", "\\|"))
            self.cell = None
        elif tag == "tr" and self.row is not None:
            self.rows.append(self.row)
            self.row = None


def table_markdown(text):
    table = TableText()
    table.feed(text)
    if not table.rows:
        return text
    width = max(map(len, table.rows))
    rows = [row + [""] * (width - len(row)) for row in table.rows]
    rows.insert(1, ["---"] * width)
    return "\n".join("| " + " | ".join(row) + " |" for row in rows)


def install_math(config, output):
    source = Path(config["katex"])
    target = Path(output) / "assets/katex"
    target.mkdir(parents=True, exist_ok=True)
    for name in ["katex.min.css", "katex.min.js"]:
        shutil.copyfile(source / name, target / name)
    shutil.copyfile(source / "contrib/auto-render.min.js", target / "auto-render.min.js")
    shutil.copytree(source / "fonts", target / "fonts", dirs_exist_ok=True)


def write_html(config, target, title, content, toc, language, source=""):
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    install_math(config, target.parent)
    template = (Path(config["templateDir"]) / "app/translation/skills/paper-translation/assets/paper.html").read_text(encoding="utf-8")
    values = {"TITLE": html.escape(title), "LANG": html.escape(language),
              "CONTENT": content, "TOC": toc, "SOURCE": source}
    target.write_text(re.sub(r"\{\{(TITLE|LANG|CONTENT|TOC|SOURCE)\}\}",
                            lambda match: values[match[1]], template), encoding="utf-8")


def render_document(config, document, translated, output, target):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    parser = markdown()
    parts, source_parts, contents, toc = [], [], [], []
    for block in blocks(document):
        if block["label"] in {"header", "footer", "number", "header_image", "footer_image"}:
            continue
        text = translated[block["id"]]
        original = block["text"]
        if "image" in block:
            name = f"assets/{block['id']}.png"
            destination = output / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            if Path(block["image"]).resolve() != destination.resolve():
                shutil.copyfile(block["image"], destination)
            text = original = f"![]({name})"
        elif block["label"] in {"formula", "display_formula"}:
            text = original = original if original.lstrip().startswith("$$") else f"$$\n{original}\n$$"
        elif block["label"] in HEADINGS:
            text, original = f"## {text.lstrip('# ').strip()}", f"## {original.lstrip('# ').strip()}"
            toc.append(f'<a href="#{block["id"]}">{html.escape(translated[block["id"]].lstrip("# "))}</a>')
        parts.append(f"<!-- {block['id']} page:{block['page']} -->\n{text}")
        source_parts.append(original)
        contents.append(f'<section id="{block["id"]}" data-page="{block["page"]}">{parser.render(text)}'
                        + (f'<div class="original">{parser.render(original)}</div>' if text != original else "") + '</section>')
    (output / "translated.md").write_text("\n\n".join(table_markdown(part) if "<table" in part else part for part in parts), encoding="utf-8")
    (output / "source.md").write_text("\n\n".join(source_parts), encoding="utf-8")
    write_html(config, output / "translated.html", document["title"], "\n".join(contents), "\n".join(toc), target)


def render_markdown(config, source, target, title, language):
    parser = markdown()
    tokens = parser.parse(Path(source).read_text(encoding="utf-8-sig"))
    toc = []
    for index, token in enumerate(tokens):
        if token.type == "heading_open":
            anchor = f"section-{len(toc) + 1}"
            token.attrSet("id", anchor)
            toc.append(f'<a href="#{anchor}">{html.escape(tokens[index + 1].content)}</a>')
    content = parser.renderer.render(tokens, parser.options, {})
    write_html(config, target, title or Path(source).stem, content, "\n".join(toc), language)
