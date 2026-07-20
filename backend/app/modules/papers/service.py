from __future__ import annotations

import json
import re
from urllib.parse import urlparse

from app.core.errors import ResourceConflictError
from app.modules.projects.repository import SqliteProjectRepository
from app.utils.identity import new_id
from app.utils.time import utc_now

from .models import (
    Paper,
    PaperBatchCreate,
    PaperBatchItemResult,
    PaperFactsCreate,
    PaperPatch,
    ProjectPaper,
    ProjectPaperPatch,
    ProjectPaperView,
)
from .repository import SqlitePaperRepository


class PaperService:
    def __init__(self, repository: SqlitePaperRepository, projects: SqliteProjectRepository):
        self.repository = repository
        self.projects = projects

    @staticmethod
    def schema() -> dict:
        return PaperBatchCreate.model_json_schema()

    def get(self, paper_id: str) -> Paper:
        return self.repository.get(paper_id)

    def list_by_project(self, project_id: str) -> list[ProjectPaperView]:
        self.projects.get(project_id)
        return self.repository.list_by_project(project_id)

    def list_memberships(self, paper_id: str) -> list[ProjectPaper]:
        self.repository.get(paper_id)
        return self.repository.list_memberships(paper_id)

    def create_many(self, project_id: str, payload: PaperBatchCreate) -> list[PaperBatchItemResult]:
        self.projects.get(project_id)
        now = utc_now().isoformat()
        prepared = [
            self._prepare(item.paper, item.project.model_dump(mode="json"), now)
            for item in payload.papers
        ]
        return self.repository.save_batch(project_id, prepared)

    def patch(self, paper_id: str, payload: PaperPatch) -> Paper:
        self.repository.get(paper_id)
        changes = payload.model_dump(exclude_unset=True, mode="json")
        if "identifiers" in changes:
            identifiers = []
            seen: set[tuple[str, str]] = set()
            for index, item in enumerate(payload.identifiers or []):
                scheme, normalized = self._normalize_identifier(item.scheme, item.value)
                if (scheme, normalized) in seen:
                    continue
                seen.add((scheme, normalized))
                identifiers.append(
                    {
                        "id": new_id(),
                        "scheme": scheme,
                        "value": item.value,
                        "normalized_value": normalized,
                        "is_primary": int(index == 0),
                        "source": "agent",
                    }
                )
            changes["identifiers"] = identifiers
        if "authors" in changes:
            changes["authors_json"] = json.dumps(changes.pop("authors"), ensure_ascii=False)
        if "links" in changes:
            changes["links_json"] = json.dumps(changes.pop("links"), ensure_ascii=False)
        return self.repository.update_paper(paper_id, changes, utc_now().isoformat())

    def patch_membership(
        self, project_id: str, paper_id: str, payload: ProjectPaperPatch
    ) -> ProjectPaper:
        current = self.repository.get_membership(project_id, paper_id)
        changes = payload.model_dump(exclude_unset=True, mode="json")
        candidate_status = changes.get("status", current.status.value)
        candidate_relevance = changes.get("relevance", current.relevance)
        if candidate_status == "included" and not (candidate_relevance or "").strip():
            raise ResourceConflictError("included paper requires relevance")
        for source, target in (
            ("roles", "roles_json"),
            ("contributions", "contributions_json"),
            ("reading_focus", "reading_focus_json"),
        ):
            if source in changes:
                changes[target] = json.dumps(changes.pop(source), ensure_ascii=False)
        return self.repository.update_membership(
            project_id, paper_id, changes, utc_now().isoformat()
        )

    @staticmethod
    def _normalize_identifier(scheme: str, value: str) -> tuple[str, str]:
        normalized_scheme = scheme.strip().lower()
        normalized = value.strip()
        if normalized_scheme == "doi":
            normalized = re.sub(
                r"^(?:https?://(?:dx\.)?doi\.org/|doi:)", "", normalized, flags=re.I
            )
            normalized = normalized.lower().rstrip(".,;)")
        elif normalized_scheme == "arxiv":
            normalized = re.sub(
                r"^(?:https?://arxiv\.org/(?:abs|pdf)/|arxiv:)", "", normalized, flags=re.I
            )
            normalized = re.sub(r"(?:v\d+)?(?:\.pdf)?$", "", normalized, flags=re.I).lower()
        elif normalized_scheme == "url":
            parsed = urlparse(normalized)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                raise ResourceConflictError("url identifier must be an absolute HTTP URL")
            normalized = normalized.rstrip("/").lower()
        else:
            normalized = normalized.lower()
        if not normalized:
            raise ResourceConflictError("identifier cannot be empty after normalization")
        return normalized_scheme, normalized

    def _prepare(self, paper: PaperFactsCreate, project: dict, now: str) -> dict:
        identifiers = []
        seen: set[tuple[str, str]] = set()
        for index, item in enumerate(paper.identifiers):
            scheme, normalized = self._normalize_identifier(item.scheme, item.value)
            key = (scheme, normalized)
            if key in seen:
                continue
            seen.add(key)
            identifiers.append(
                {
                    "id": new_id(),
                    "scheme": scheme,
                    "value": item.value,
                    "normalized_value": normalized,
                    "is_primary": int(index == 0),
                    "source": "agent",
                }
            )
        primary = identifiers[0]
        facts = paper.model_dump(mode="json", exclude={"identifiers", "links", "authors"})
        facts.update(
            {
                "id": new_id(),
                "identity_key": f"{primary['scheme']}:{primary['normalized_value']}",
                "authors_json": json.dumps(paper.authors, ensure_ascii=False),
                "links_json": json.dumps(
                    [link.model_dump(mode="json") for link in paper.links], ensure_ascii=False
                ),
                "authors_complete": int(paper.authors_complete),
                "created_at": now,
                "updated_at": now,
            }
        )
        project.update(
            {
                "id": new_id(),
                "roles_json": json.dumps(project.pop("roles"), ensure_ascii=False),
                "contributions_json": json.dumps(project.pop("contributions"), ensure_ascii=False),
                "reading_focus_json": json.dumps(project.pop("reading_focus"), ensure_ascii=False),
                "created_at": now,
                "updated_at": now,
            }
        )
        return {"paper": facts, "identifiers": identifiers, "project": project}
