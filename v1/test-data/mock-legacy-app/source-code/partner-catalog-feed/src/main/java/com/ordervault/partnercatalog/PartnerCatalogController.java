package com.ordervault.partnercatalog;

// SYNTHETIC legacy code — fictional portfolio test data, not a real system.
//
// Added in 2020, alongside the legacy SOAP services, WITHOUT touching them.
// This is the newer-style REST/Spring code referenced in
// architecture-overview.md and PartnerCatalogFeed-openapi.yaml. It reads
// from a separate cache layer synced from the same underlying Oracle STOCK
// table that InventoryCheckService reads/writes directly and synchronously
// — which is the source of the data-consistency gap between this API and
// InventoryCheckService's legacy SOAP path.

import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/v1/catalog")
public class PartnerCatalogController {

    private final CatalogCacheService catalogCacheService;

    public PartnerCatalogController(CatalogCacheService catalogCacheService) {
        this.catalogCacheService = catalogCacheService;
    }

    @GetMapping("/{sku}/stock")
    public StockResponse getStock(@PathVariable String sku) {
        // Reads from the CACHE, not live DB — see CatalogCacheService for
        // the sync interval and why lag increases sharply during flash sales.
        return catalogCacheService.getCachedStock(sku);
    }

    @GetMapping
    public CatalogPage listCatalog(
            @RequestParam(required = false) String category,
            @RequestParam(defaultValue = "1") int page) {
        return catalogCacheService.listCatalog(category, page);
    }
}

class StockResponse {
    public String sku;
    public int availableQuantity;
    public String lastSyncedAt; // ISO-8601 timestamp
}

class CatalogItem {
    public String sku;
    public String name;
    public String category;
    public int availableQuantity;
}

class CatalogPage {
    public List<CatalogItem> items;
    public int page;
    public int totalPages;
}
