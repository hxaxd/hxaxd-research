from __future__ import annotations

import pytest

from app.catalog.commands import CatalogCommands
from app.catalog.domain import CatalogConflictError
from app.catalog.models import (
    BibliographicItemDraft as CatalogItemDraft,
)
from app.catalog.models import (
    CreatorInput,
    IdentifierInput,
    LinkInput,
    TagInput,
)
from app.integrations.zotero.mapping import (
    catalog_item_to_draft,
    draft_to_catalog_item,
    draft_to_zotero_data,
    zotero_item_to_draft,
)
from app.integrations.zotero.models import CreatorKind
from app.platform.db import V3Database


def test_zotero_mapping_preserves_people_organizations_identifiers_and_raw_fields():
    item = {
        "key": "ABCD2345",
        "version": 42,
        "meta": {"creatorSummary": "Lovelace et al."},
        "data": {
            "key": "ABCD2345",
            "version": 42,
            "itemType": "journalArticle",
            "title": "A Deterministic Paper",
            "shortTitle": "Deterministic Paper",
            "creators": [
                {
                    "creatorType": "author",
                    "firstName": "Ada",
                    "lastName": "Lovelace",
                    "customCreatorField": "kept",
                },
                {
                    "creatorType": "author",
                    "name": "Example Research Group",
                },
            ],
            "abstractNote": "An abstract.",
            "date": "2024-03-02",
            "publicationTitle": "Journal of Tests",
            "DOI": "https://doi.org/10.1000/EXAMPLE",
            "ISBN": "978-1-4028-9462-6",
            "url": "https://arxiv.org/abs/2401.01234v2",
            "extra": "Citation Key: lovelace2024\narXiv: 2401.01234v2",
            "tags": [{"tag": "agent", "type": 1, "color": "purple"}],
            "collections": ["COLL0001"],
            "relations": {"dc:relation": "https://example.test/related"},
            "customFutureField": {"nested": [1, 2, 3]},
        },
    }

    draft = zotero_item_to_draft(item)

    assert draft.external_key == "ABCD2345"
    assert draft.external_version == 42
    assert draft.creators[0].kind == CreatorKind.PERSON
    assert draft.creators[0].given == "Ada"
    assert draft.creators[0].raw["customCreatorField"] == "kept"
    assert draft.creators[1].kind == CreatorKind.ORGANIZATION
    assert draft.creators[1].literal == "Example Research Group"
    assert draft.issued and draft.issued.model_dump() == {
        "literal": "2024-03-02",
        "year": 2024,
        "month": 3,
        "day": 2,
    }
    assert {(item.scheme, item.normalized_value) for item in draft.identifiers} == {
        ("doi", "10.1000/example"),
        ("isbn", "9781402894626"),
        ("arxiv", "2401.01234"),
        ("url", "https://arxiv.org/abs/2401.01234v2"),
    }
    assert draft.tags[0].raw["color"] == "purple"
    assert draft.collections == ["COLL0001"]
    assert draft.unknown_fields == {"customFutureField": {"nested": [1, 2, 3]}}
    assert draft.raw == item

    exported = draft_to_zotero_data(draft)
    assert exported["customFutureField"] == {"nested": [1, 2, 3]}
    assert exported["creators"][0]["customCreatorField"] == "kept"
    assert exported["creators"][1] == {
        "creatorType": "author",
        "name": "Example Research Group",
    }
    assert exported["tags"][0]["color"] == "purple"
    assert exported["key"] == "ABCD2345"
    assert exported["version"] == 42


def test_create_export_removes_server_owned_fields_but_keeps_unknown_data():
    draft = zotero_item_to_draft(
        {
            "key": "SERVERKEY",
            "version": 7,
            "data": {
                "key": "SERVERKEY",
                "version": 7,
                "dateAdded": "2024-01-01T00:00:00Z",
                "dateModified": "2024-01-02T00:00:00Z",
                "itemType": "report",
                "title": "Report",
                "institution": "Lab",
                "future": True,
            },
        }
    )

    exported = draft_to_zotero_data(draft, for_create=True)

    assert not {"key", "version", "dateAdded", "dateModified"} & exported.keys()
    assert exported["institution"] == "Lab"
    assert exported["future"] is True


def test_v3_catalog_mapping_round_trips_deterministic_metadata(tmp_path):
    database = V3Database(tmp_path / "research.sqlite3")
    database.initialize()
    work = CatalogCommands(database).create_work(
        CatalogItemDraft(
            item_type="journal_article",
            title="Catalog paper",
            abstract="Abstract",
            issued_year=2026,
            issued_month=7,
            container_title="Journal",
            creators=[
                CreatorInput(
                    creator_type="person",
                    given_name="Ada",
                    family_name="Lovelace",
                    raw_name="Ada Lovelace",
                )
            ],
            identifiers=[
                IdentifierInput(scheme="doi", value="10.1000/catalog", is_primary=True)
            ],
            links=[LinkInput(relation_type="paper", url="https://example.test/paper")],
            tags=[TagInput(name="agent", kind="automatic")],
        )
    )
    item = work.items[0]

    neutral = catalog_item_to_draft(item)
    restored = draft_to_catalog_item(neutral)

    assert neutral.item_type == "journalArticle"
    assert neutral.issued and neutral.issued.literal == "2026-07"
    assert neutral.identifiers[0].normalized_value == "10.1000/catalog"
    assert restored.title == "Catalog paper"
    assert restored.item_type == "journal_article"
    assert restored.creators[0].raw_name == "Ada Lovelace"
    assert restored.links[0].url == "https://example.test/paper"
    assert neutral.tags[0].model_dump(exclude={"raw"}) == {
        "name": "agent",
        "type": 1,
    }
    assert restored.tags[0].model_dump() == {"name": "agent", "kind": "automatic"}


def test_catalog_append_keeps_old_version_and_rejects_cross_work_identity(tmp_path):
    database = V3Database(tmp_path / "research.sqlite3")
    database.initialize()
    commands = CatalogCommands(database)
    first = commands.create_work(
        CatalogItemDraft(
            title="Version one",
            identifiers=[IdentifierInput(scheme="doi", value="10.1000/versioned")],
        )
    )
    versioned = commands.append_item_version(
        first.id,
        CatalogItemDraft(
            title="Version two",
            identifiers=[IdentifierInput(scheme="doi", value="10.1000/versioned")],
        ),
    )
    other = commands.create_work(CatalogItemDraft(title="Other work"))

    assert [item.title for item in versioned.items] == ["Version two", "Version one"]
    assert versioned.items[0].is_preferred_for_work is True
    assert versioned.items[1].is_preferred_for_work is False
    with pytest.raises(CatalogConflictError):
        commands.append_item_version(
            other.id,
            CatalogItemDraft(
                title="Invalid merge",
                identifiers=[IdentifierInput(scheme="doi", value="10.1000/versioned")],
            ),
        )
