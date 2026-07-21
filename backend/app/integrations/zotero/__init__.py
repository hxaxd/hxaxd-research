"""Zotero interoperability without coupling Zotero's schema to the core domain."""

from .domain import V3ZoteroDomainGateway
from .engine import ZoteroSyncEngine
from .http import ZoteroLocalClient, ZoteroWebClient
from .mapping import (
    catalog_item_to_draft,
    draft_to_catalog_item,
    draft_to_zotero_data,
    zotero_item_to_draft,
)
from .models import BibliographicDraft, TransferPreview, TransferReceipt
from .planner import ZoteroDiffPlanner
from .repository import SqliteZoteroTransferRepository
from .service import ZoteroTransferService

__all__ = [
    "BibliographicDraft",
    "SqliteZoteroTransferRepository",
    "TransferPreview",
    "TransferReceipt",
    "V3ZoteroDomainGateway",
    "ZoteroDiffPlanner",
    "ZoteroLocalClient",
    "ZoteroSyncEngine",
    "ZoteroTransferService",
    "ZoteroWebClient",
    "catalog_item_to_draft",
    "draft_to_catalog_item",
    "draft_to_zotero_data",
    "zotero_item_to_draft",
]
