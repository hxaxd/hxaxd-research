"""Place translated blocks over the original PDF, retaining figures and formulas."""
from pathlib import Path
import re
import subprocess
import os
from statistics import median

import pymupdf

from documents import block_rect, markdown, save


def tex_text(text):
    escapes = {"\\": r"\textbackslash{}", "&": r"\&", "%": r"\%", "$": r"\$", "#": r"\#",
               "_": r"\_", "{": r"\{", "}": r"\}", "~": r"\textasciitilde{}", "^": r"\textasciicircum{}"}
    pieces = re.split(r"(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<!\\)\$(?:\\.|[^$])*?\$)", text)
    return "".join(piece if index % 2 else "".join(escapes.get(char, char) for char in piece)
                   for index, piece in enumerate(pieces))


def overlays(config, items, output):
    directory = output / "typesetting"
    directory.mkdir(parents=True, exist_ok=True)
    tex_root = Path(config["texRoot"])
    width = max(item["rect"].width for item in items) + 8
    preamble = rf"""\documentclass{{article}}
\usepackage[paperwidth={width}bp,paperheight=2000bp,margin=4bp]{{geometry}}
\usepackage{{xeCJK,amsmath,amssymb}}
\setCJKmainfont{{NotoSerifCJKsc-Regular.otf}}
\pagestyle{{empty}}
\setlength{{\parindent}}{{0pt}}
\begin{{document}}
"""
    body = []
    for item in items:
        text = tex_text(item["text"])
        size = item["fontSize"]
        body.append(rf"\noindent\begin{{minipage}}[t]{{{item['rect'].width}bp}}\raggedright\sloppy"
                    + rf"\fontsize{{{size}bp}}{{{size * 1.35}bp}}\selectfont " + text
                    + r"\end{minipage}\clearpage")
    source = directory / "blocks.tex"
    source.write_text(preamble + "\n".join(body) + "\n\\end{document}\n", encoding="utf-8")
    executable = tex_root / ("tectonic.exe" if os.name == "nt" else "tectonic")
    environment = {**os.environ, "TECTONIC_CACHE_DIR": str(tex_root / "cache"),
                   "FONTCONFIG_FILE": str(tex_root / "fonts.conf")}
    with (directory / "compile.log").open("w", encoding="utf-8") as log:
        result = subprocess.run([str(executable), "-b", "https://data1b.fullyjustified.net/tlextras-2022.0r0.tar",
                                 "-Z", f"search-path={tex_root / 'fonts'}", "--keep-logs", str(source)],
                                cwd=directory, env=environment, stdout=log, stderr=subprocess.STDOUT)
    if result.returncode:
        raise ValueError(f"译块 TeX 排版失败，请读取 {directory / 'compile.log'} 与 blocks.log")
    rendered = pymupdf.open(directory / "blocks.pdf")
    if len(rendered) != len(items):
        rendered.close()
        raise ValueError(f"译块排版超出单页容量，请检查 {source}")
    return rendered


def render_layout(config, document, translated, output):
    original = pymupdf.open(document["source"])
    pdf = pymupdf.open(document["source"])
    for page in pdf:
        if page.rotation:
            page.remove_rotation()
    items, tables = [], []
    for dimensions in document["pages"]:
        page = pdf[dimensions["number"] - 1]
        spans = [span for block in page.get_text("dict")["blocks"] if "lines" in block
                 for line in block["lines"] for span in line["spans"]]
        for block in dimensions["blocks"]:
            text = translated[block["id"]]
            if block["preserve"] or not text.strip() or text == block["text"]:
                continue
            rect = block_rect(page, dimensions, block)
            sizes = [span["size"] for span in spans if rect.intersects(pymupdf.Rect(span["bbox"]))]
            item = {"id": block["id"], "page": dimensions["number"], "rect": rect, "text": text,
                    "fontSize": median(sizes) if sizes else 13 if block["label"] in {"doc_title", "title"} else 10}
            (tables if block["label"] == "table" else items).append(item)
            page.add_redact_annot(rect, fill=(1, 1, 1), cross_out=False)
    for page in pdf:
        page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE,
                              graphics=pymupdf.PDF_REDACT_LINE_ART_NONE)
    report = []
    if items:
        rendered = overlays(config, items, output)
        for index, item in enumerate(items):
            boxes = [pymupdf.Rect(bounds) for kind, bounds in rendered[index].get_bboxlog()
                     if kind in {"fill-text", "stroke-text", "fill-path", "stroke-path"}]
            if not boxes:
                raise ValueError(f"译块 {item['id']} 没有排版内容，请检查 typesetting/blocks.tex")
            clip = boxes[0]
            for box in boxes[1:]:
                clip |= box
            clip = (clip + (-.5, -.5, .5, .5)) & rendered[index].rect
            scale = min(1, item["rect"].width / clip.width, item["rect"].height / clip.height)
            target = pymupdf.Rect(item["rect"].x0, item["rect"].y0,
                                   item["rect"].x0 + clip.width * scale, item["rect"].y0 + clip.height * scale)
            pdf[item["page"] - 1].show_pdf_page(target, rendered, index, clip=clip)
            report.append({"id": item["id"], "page": item["page"], "scale": scale,
                           "fontSize": item["fontSize"] * scale, "smallText": item["fontSize"] * scale < 6})
        rendered.close()
    font_path = (Path(config["texRoot"]) / "fonts").as_posix()
    css = '@font-face {font-family: paper; src: url("NotoSerifCJKsc-Regular.otf");} body {font-family: paper; margin: 0;} table {border-collapse: collapse;} td,th {padding: 2px; border: .4px solid #aaa;}'
    for item in tables:
        markup = item["text"] if "<table" in item["text"] else markdown().render(item["text"])
        table_pdf = pymupdf.open()
        table_page = table_pdf.new_page(width=item["rect"].width, height=item["rect"].height)
        spare, scale = table_page.insert_htmlbox(table_page.rect, markup,
                                                css=css + f'body {{font-size: {item["fontSize"]}pt;}}',
                                                archive=pymupdf.Archive(font_path))
        if spare < 0:
            raise ValueError(f"表格 {item['id']} 无法放入原位置；请检查译文或选择 HTML 输出")
        table_pdf.subset_fonts(fallback=True)
        pdf[item["page"] - 1].show_pdf_page(item["rect"], table_pdf, 0)
        table_pdf.close()
        report.append({"id": item["id"], "page": item["page"], "scale": scale, "fontSize": item["fontSize"] * scale, "smallText": item["fontSize"] * scale < 6})
    pdf.save(output / "translated.pdf", garbage=4, deflate=True)
    paired = pymupdf.open()
    for index in range(len(pdf)):
        paired.insert_pdf(original, from_page=index, to_page=index)
        paired.insert_pdf(pdf, from_page=index, to_page=index)
    paired.set_toc([[level, title, page * 2 - 1] for level, title, page in original.get_toc()])
    paired.save(output / "bilingual.pdf", garbage=4, deflate=True)
    save(output / "layout-report.json", {"blocks": report, "smallText": [item["id"] for item in report if item["smallText"]]})
    paired.close()
    pdf.close()
    original.close()
