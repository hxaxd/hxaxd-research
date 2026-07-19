from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate paper JSONL through the backend and create paper records."
    )
    parser.add_argument("jsonl", type=Path)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    return parser.parse_args()


def read_jsonl(path: Path) -> list[dict]:
    papers = []
    with path.open("r", encoding="utf-8") as source:
        for line_number, raw_line in enumerate(source, start=1):
            line = raw_line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"line {line_number}: invalid JSON: {error}") from error
            if not isinstance(value, dict):
                raise ValueError(f"line {line_number}: expected a JSON object")
            papers.append(value)
    if not papers:
        raise ValueError("JSONL contains no paper records")
    return papers


def main() -> int:
    args = parse_args()
    try:
        papers = read_jsonl(args.jsonl)
        body = json.dumps({"papers": papers}, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            f"{args.base_url.rstrip('/')}/api/projects/{args.project_id}/papers/batch",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request) as response:
            result = json.load(response)
        print(json.dumps({"created": len(result["created"])}, ensure_ascii=False))
        return 0
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        print(detail, file=sys.stderr)
        return 1
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
