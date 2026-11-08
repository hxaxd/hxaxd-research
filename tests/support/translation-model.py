"""Stand-in for the external model command configured by the translation tests."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--list", action="store_true")
parser.add_argument("--model", choices=["test/translator"], required=True)
parser.add_argument("--input", type=Path)
parser.add_argument("--output", type=Path)
args = parser.parse_args()

if args.list:
    print(json.dumps({"models": [{"id": args.model, "maxTokens": 2000, "contextWindow": 32000}]}))
else:
    request = json.loads(args.input.read_text(encoding="utf-8"))
    payload = json.loads(request["prompt"])
    blocks = [{"id": block["id"], "text": block["text"] if block["preserve"] else "译文：" + block["text"]}
              for block in payload["blocks"]]
    args.output.write_text(json.dumps({"text": json.dumps({"blocks": blocks})}), encoding="utf-8")
