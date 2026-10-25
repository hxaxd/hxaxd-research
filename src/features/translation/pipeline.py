"""Native command workflow for OCR, whole-document translation and rendering."""
import argparse
import json
import math
import os
from pathlib import Path
import subprocess
import sys

from documents import blocks, load, load_document, normalize, render_document, render_markdown, save, translations

def run(command):
    subprocess.run([str(part) for part in command], check=True)


def ocr(config, source, output, title):
    output = Path(output).resolve()
    raw = output / "ocr"
    raw.mkdir(parents=True, exist_ok=True)
    source = Path(source).resolve(strict=True)
    installed = load(Path(config["ocrRoot"]) / "installation.json")
    def input_path(file):
        if os.name != "nt":
            return str(file)
        return f"/mnt/{file.drive[0].lower()}/{file.as_posix()[3:]}"
    run(installed["command"] + ["--input", input_path(source), "--save_path", input_path(raw)])
    return normalize(source, raw, output, title)


def prepare(config, document, target, instructions="", glossary="", selected=None, context=None):
    selected = blocks(document) if selected is None else selected
    system = (Path(config["templateDir"]) / "features/translation/prompts/blocks.md").read_text(encoding="utf-8").replace("{{target}}", target)
    payload = {"title": document["title"], "target": target, "instructions": instructions,
               "glossary": glossary, "blocks": [{key: block[key] for key in ["id", "label", "text", "preserve"]} for block in selected]}
    if context:
        payload["context"] = [{"id": block["id"], "text": block["text"]} for block in context]
    return {"system": system, "prompt": json.dumps(payload, ensure_ascii=False)}


def estimate(request):
    # Estimate across providers without treating every English byte as a token.
    text = request["system"] + request["prompt"]
    ascii_count = sum(char.isascii() for char in text)
    return math.ceil(ascii_count / 3 + (len(text) - ascii_count) * 1.5)


def plan_batches(config, document, target, instructions, glossary, model):
    source = blocks(document)
    batches, current = [], []
    for block in source:
        proposed = current + [block]
        request = prepare(config, document, target, instructions, glossary, proposed)
        text = "".join(item["text"] for item in proposed)
        ascii_count = sum(char.isascii() for char in text)
        output_budget = math.ceil(ascii_count / 2 + (len(text) - ascii_count) * 2) + len(proposed) * 32 + 512
        if current and (output_budget > model["maxTokens"] or estimate(request) + output_budget + 2048 > model["contextWindow"]):
            batches.append(current)
            current = [block]
        else:
            current = proposed
    if current:
        batches.append(current)
    return batches


def translate(config, document, target, model_id, output, instructions, glossary):
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    catalog_file = output / "models.json"
    catalog = subprocess.run(config["modelsCommand"] + ["--list", "--model", model_id], check=True, capture_output=True, text=True, encoding="utf-8")
    catalog_file.write_text(catalog.stdout, encoding="utf-8")
    models = json.loads(catalog.stdout)
    model = next((item for item in models["models"] if item["id"] == model_id), None)
    if model is None:
        raise ValueError(f"所选模型不可用：{model_id}；供应商状态见 {catalog_file}")
    batches = plan_batches(config, document, target, instructions, glossary, model)
    all_blocks = blocks(document)
    result = []
    save(output / "partial-translations.json", {"blocks": result})
    for index, batch in enumerate(batches):
        first = all_blocks.index(batch[0])
        last = first + len(batch)
        context = all_blocks[max(0, first - 2):first] + all_blocks[last:last + 2] if len(batches) > 1 else []
        request = prepare(config, document, target, instructions, glossary, batch, context)
        if result:
            payload = json.loads(request["prompt"])
            payload["previousTranslations"] = result[-2:]
            request["prompt"] = json.dumps(payload, ensure_ascii=False)
        request["maxTokens"] = min(model["maxTokens"], model["contextWindow"] - estimate(request) - 1024)
        if request["maxTokens"] <= 0:
            raise ValueError(f"块 {batch[0]['id']} 与上下文超过模型容量；请改选更大上下文的模型")
        request_file = output / f"request-{index + 1:03}.json"
        response_file = output / f"response-{index + 1:03}.json"
        save(request_file, request)
        print(json.dumps({"batch": index + 1, "batches": len(batches), "blocks": len(batch)}), flush=True)
        run(config["modelsCommand"] + ["--model", model_id, "--input", str(request_file), "--output", str(response_file)])
        raw = load(response_file)["text"].strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        try:
            response = json.loads(raw)
            translations({"pages": [{"blocks": batch}]}, response)
        except (ValueError, KeyError, TypeError) as error:
            raise ValueError(f"批次 {index + 1} 的模型输出需要修复：{response_file}；{error}。已完成译块保存在 partial-translations.json") from error
        result.extend(response["blocks"])
        save(output / "partial-translations.json", {"blocks": result})
    complete = {"blocks": result}
    save(output / "translations.json", complete)
    return {item["id"]: item["text"] for item in result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", help="Explicit pipeline configuration; defaults to the application's configuration")
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ["ocr", "pdf"]:
        command = commands.add_parser(name)
        command.add_argument("--input", required=True)
        command.add_argument("--output", required=True)
        command.add_argument("--title", default="")
    for name in ["prepare", "translate", "render"]:
        command = commands.add_parser(name)
        command.add_argument("--document", required=True)
        command.add_argument("--output", required=True)
    for name in ["prepare", "translate", "render", "pdf"]:
        command = commands.choices[name]
        command.add_argument("--target", required=True)
    for name in ["prepare", "translate", "pdf"]:
        command = commands.choices[name]
        command.add_argument("--instructions", help="UTF-8 text file")
        command.add_argument("--glossary", help="UTF-8 terminology file")
    for name in ["translate", "pdf"]:
        commands.choices[name].add_argument("--model", required=True)
    commands.choices["render"].add_argument("--translations", required=True)
    for name in ["render", "pdf"]:
        commands.choices[name].add_argument("--layout", action="store_true")
    command = commands.add_parser("render-markdown")
    command.add_argument("--input", required=True)
    command.add_argument("--output", required=True)
    command.add_argument("--title", default="")
    command.add_argument("--target", required=True)
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[3]
    resolved = subprocess.run(["node", str(project / "src/server/config.mjs")],
                              check=True, capture_output=True, text=True, encoding="utf-8")
    settings = json.loads(resolved.stdout)
    config = {"ocrRoot": settings["ocrDir"], "texRoot": settings["texDir"],
              "templateDir": settings["templateDir"], "katex": str(project / "node_modules/katex/dist"),
              "modelsCommand": settings["translation"]["modelsCommand"]}
    if args.config:
        config.update(load(args.config))
    if args.command == "render-markdown":
        render_markdown(config, args.input, args.output, args.title, args.target)
        return
    if args.command in {"ocr", "pdf"}:
        document = ocr(config, args.input, args.output, args.title)
        if args.command == "ocr":
            return
    else:
        document = load_document(args.document)
    if args.command in {"prepare", "translate", "pdf"}:
        instructions = Path(args.instructions).read_text(encoding="utf-8-sig") if args.instructions else ""
        glossary = Path(args.glossary).read_text(encoding="utf-8-sig") if args.glossary else ""
        if args.command == "prepare":
            save(args.output, prepare(config, document, args.target, instructions, glossary))
            return
        translated = translate(config, document, args.target, args.model, args.output, instructions, glossary)
        if args.command == "translate":
            return
    else:
        translated = translations(document, load(args.translations))
    render_document(config, document, translated, args.output, args.target)
    if args.layout:
        from layout import render_layout
        render_layout(config, document, translated, Path(args.output).resolve())
    print(json.dumps({"output": str(Path(args.output).resolve())}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
