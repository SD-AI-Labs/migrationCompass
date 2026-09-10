package com.ordervault.partnercatalog;

// SYNTHETIC legacy code — fictional portfolio test data, not a real system.

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.time.Instant;

/**
 * In-memory cache synced from the Oracle STOCK table on a fixed schedule.
 * Built this way in 2020 specifically to AVOID adding more read load to
 * the already-contended primary DB (see InventoryDAO's javadoc for the
 * row-locking behavior this was trying to protect against) — a reasonable
 * tactical decision at the time, but it's what created the current
 * data-consistency gap between this API and InventoryCheckService.
 *
 * Sync interval is every 2 minutes under normal load. During flash sales,
 * the sync job itself competes for DB connections against the same pool
 * InventoryCheckService uses, so sync latency degrades exactly when
 * accuracy matters most — observed up to 20 min lag in production,
 * matching the note in PartnerCatalogFeed-openapi.yaml.
 */
@Service
public class CatalogCacheService {

    private final Map<String, StockResponse> stockCache = new ConcurrentHashMap<>();
    private volatile Instant lastFullSync = Instant.EPOCH;

    public StockResponse getCachedStock(String sku) {
        return stockCache.getOrDefault(sku, emptyResult(sku));
    }

    public CatalogPage listCatalog(String category, int page) {
        // simplified for this snapshot — real implementation paginates
        // over stockCache filtered by category
        CatalogPage result = new CatalogPage();
        result.items = List.of();
        result.page = page;
        result.totalPages = 1;
        return result;
    }

    @Scheduled(fixedDelay = 120_000) // every 2 minutes, best case
    public void syncFromDatabase() {
        // Pulls from the same Oracle STOCK table InventoryCheckService uses
        // directly. Implementation omitted in this snapshot — the important
        // architectural fact is WHERE this reads from and HOW OFTEN, not
        // the exact SQL.
        lastFullSync = Instant.now();
    }

    private StockResponse emptyResult(String sku) {
        StockResponse r = new StockResponse();
        r.sku = sku;
        r.availableQuantity = 0;
        r.lastSyncedAt = lastFullSync.toString();
        return r;
    }
}
