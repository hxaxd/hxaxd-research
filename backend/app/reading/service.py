from __future__ import annotations

from datetime import datetime

from .models import (
    Annotation,
    AnnotationCreate,
    AnnotationUpdate,
    ReadingBookmarkCreate,
    ReadingState,
    ReadingStateUpdate,
)
from .repository import ReadingRepository


class ReadingService:
    def __init__(self, repository: ReadingRepository) -> None:
        self.repository = repository

    def annotations(self, project_id: str, item_id: str) -> list[Annotation]:
        return self.repository.list_annotations(project_id, item_id)

    def create_annotation(
        self, project_id: str, item_id: str, payload: AnnotationCreate
    ) -> Annotation:
        return self.repository.create_annotation(project_id, item_id, payload)

    def update_annotation(
        self, annotation_id: str, payload: AnnotationUpdate
    ) -> Annotation:
        return self.repository.update_annotation(annotation_id, payload)

    def delete_annotation(self, annotation_id: str, expected_updated_at: datetime) -> None:
        self.repository.delete_annotation(annotation_id, expected_updated_at)

    def state(self, project_id: str, item_id: str) -> ReadingState:
        return self.repository.get_reading_state(project_id, item_id)

    def update_state(
        self, project_id: str, item_id: str, payload: ReadingStateUpdate
    ) -> ReadingState:
        return self.repository.update_reading_state(project_id, item_id, payload)

    def add_bookmark(
        self, project_id: str, item_id: str, payload: ReadingBookmarkCreate
    ) -> ReadingState:
        return self.repository.add_bookmark(project_id, item_id, payload)

    def delete_bookmark(
        self, project_id: str, item_id: str, bookmark_id: str
    ) -> ReadingState:
        return self.repository.delete_bookmark(project_id, item_id, bookmark_id)
