from __future__ import annotations

import hashlib
import json

from .models import PromptContext, PromptSnapshot
from .templates import PROMPT_VERSION, render_user_prompt


class PromptAssembler:
    """Build a deterministic user message from a trusted context projection."""

    def __init__(self, *, version: str = PROMPT_VERSION, max_characters: int = 200_000) -> None:
        self.version = version
        self.max_characters = max_characters

    def assemble(self, context: PromptContext) -> PromptSnapshot:
        payload = context.model_dump(mode="json", exclude_none=True)
        canonical = json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        prompt = render_user_prompt(
            objective=context.objective,
            payload=payload,
            version=self.version,
            context_hash=digest,
        )
        if len(prompt) > self.max_characters:
            raise ValueError(
                f"assembled prompt exceeds the {self.max_characters}-character context budget"
            )
        return PromptSnapshot(
            version=self.version,
            context_hash=digest,
            prompt=prompt,
            context=payload,
        )
