from __future__ import annotations

from .models import UserPreferences, UserPreferencesUpdate
from .repository import PreferencesRepository


class PreferencesService:
    def __init__(self, repository: PreferencesRepository) -> None:
        self.repository = repository

    def get(self) -> UserPreferences:
        return self.repository.get()

    def update(self, payload: UserPreferencesUpdate) -> UserPreferences:
        return self.repository.update(payload)
