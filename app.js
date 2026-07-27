/* Earth Digital Twin — CesiumJS-based, free-asset, space-to-street viewer.
 *
 * Architecture:
 *   - CesiumJS handles globe rendering, atmosphere, sun lighting, frustum culling
 *   - Imagery: Esri World Imagery (default, no key) | OSM | Bing (Ion)
 *   - Terrain: ellipsoid (default) | Cesium World Terrain (if Ion token)
 *   - Buildings: OsmBuildingLoader streams OSM Overpass building data per-tile,
 *                extrudes polygons, batches into single Primitive per tile, evicts
 *                stale tiles. Only active when camera altitude < 5 km.
 *   - Search: Nominatim (free, no key)
 */

(() => {
'use strict';

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
    // Building loader
    BUILDING_TILE_DEG: 0.01,            // ~1.1 km tiles at equator
    BUILDING_ACTIVE_ALT: 5000,          // meters above ground; load when below this
    BUILDING_MAX_TILES: 128,            // cache cap (incl. prefetch ring)
    BUILDING_MAX_CONCURRENT: 3,         // parallel Overpass requests (Overpass slot limit is 2; 3 works in short bursts)
    BUILDING_MAX_AREA_DEG: 0.06,        // cap visible building search to this size
    BUILDING_PREFETCH_RING: true,       // load 1 tile ring around visible area for pan responsiveness
    BUILDING_PREFETCH_MAX_TOTAL: 25,    // skip ring if visible+ring would exceed this
    OVERPASS_ENDPOINTS: [
        'https://overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter',
        'https://lz4.overpass-api.de/api/interpreter',
        'https://z.overpass-api.de/api/interpreter'
    ],
    NOMINATIM: 'https://nominatim.openstreetmap.org/search',

    PRESETS: {
        space:     { lon: -30.0,    lat:  20.0,    height: 30000000, heading: 0, pitch: -90, name: 'Earth from space' },
        cosprings: { lon: -104.7509, lat: 38.9194, height: 8000,     heading: 30, pitch: -35, name: 'Colorado Springs' },
        nyc:       { lon: -73.9857, lat: 40.7484,  height: 1500,     heading: 30, pitch: -25, name: 'Midtown Manhattan' },
        london:    { lon: -0.1276,  lat: 51.5074,  height: 1500,     heading: 60, pitch: -25, name: 'London' },
        tokyo:     { lon: 139.7000, lat: 35.6586,  height: 1500,     heading: 0,  pitch: -25, name: 'Tokyo Tower' },
        paris:     { lon: 2.2945,   lat: 48.8584,  height: 1200,     heading: 45, pitch: -25, name: 'Eiffel Tower' },
        dubai:     { lon: 55.2744,  lat: 25.1972,  height: 1500,     heading: 90, pitch: -25, name: 'Burj Khalifa' },
        sf:        { lon: -122.4783, lat: 37.8199, height: 1200,     heading: 90, pitch: -25, name: 'Golden Gate Bridge' }
    }
};

const STORAGE_KEY_TOKEN = 'cesiumIonToken';

// ============================================================================
// OSM Building Loader — tile-based, batched, cached
// ============================================================================

class OsmBuildingLoader {
    constructor(viewer) {
        this.viewer = viewer;
        this.tilesByKey = new Map();     // key -> { primitive, count, lastSeen, empty }
        this.pendingTiles = new Set();
        this.activeTiles = new Set();
        this.queue = [];                  // visible tiles (high priority)
        this.preloadQueue = [];           // ring tiles (low priority)
        this.endpointIdx = 0;
        this.totalBuildings = 0;
        this.enabled = true;
        this._updatePending = false;
        this._consecutiveFailures = 0;
        this._failureNoticeShown = false;
        this._backoffUntil = 0;

        // Update on camera move (debounced)
        viewer.camera.moveEnd.addEventListener(() => this.scheduleUpdate());
        // Initial pass
        this.scheduleUpdate();
    }

    scheduleUpdate() {
        if (this._updatePending) return;
        this._updatePending = true;
        setTimeout(() => { this._updatePending = false; this.update(); }, 80);
    }

    update() {
        if (!this.enabled) { this.hideAll(); return; }
        const carto = Cesium.Cartographic.fromCartesian(this.viewer.camera.positionWC);
        if (!carto) return;
        const alt = carto.height;
        if (alt > CONFIG.BUILDING_ACTIVE_ALT) {
            this.hideAll();
            return;
        }

        const visible = this.computeVisibleTiles();
        const preload = this.computePrefetchRing(visible);

        // Show/hide existing tiles based on whether they're currently visible
        for (const [key, entry] of this.tilesByKey) {
            const inVisible = visible.has(key);
            if (entry.primitive) entry.primitive.show = inVisible;
            if (inVisible || preload.has(key)) entry.lastSeen = Date.now();
        }

        // Queue visible tiles first (high priority)
        for (const key of visible) {
            if (!this.tilesByKey.has(key) && !this.pendingTiles.has(key)) {
                this.queueLoad(key, true);
            }
        }
        // Then queue ring tiles for pre-fetch (low priority)
        for (const key of preload) {
            if (!this.tilesByKey.has(key) && !this.pendingTiles.has(key)) {
                this.queueLoad(key, false);
            }
        }

        this.processQueue();
        this.evictIfNeeded();
    }

    computePrefetchRing(visible) {
        const preload = new Set();
        if (!CONFIG.BUILDING_PREFETCH_RING || visible.size === 0) return preload;
        // Skip if already too many to load
        if (visible.size + 8 > CONFIG.BUILDING_PREFETCH_MAX_TOTAL) return preload;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const k of visible) {
            const [tx, ty] = k.split('_').map(Number);
            minX = Math.min(minX, tx); maxX = Math.max(maxX, tx);
            minY = Math.min(minY, ty); maxY = Math.max(maxY, ty);
        }
        for (let tx = minX - 1; tx <= maxX + 1; tx++) {
            for (let ty = minY - 1; ty <= maxY + 1; ty++) {
                const k = `${tx}_${ty}`;
                if (!visible.has(k)) preload.add(k);
            }
        }
        return preload;
    }

    computeVisibleTiles() {
        const result = new Set();
        const canvas = this.viewer.scene.canvas;
        const w = canvas.clientWidth, h = canvas.clientHeight;
        const samplePoints = [
            [w * 0.5, h * 0.5],
            [w * 0.1, h * 0.1], [w * 0.9, h * 0.1],
            [w * 0.1, h * 0.9], [w * 0.9, h * 0.9],
            [w * 0.5, h * 0.1], [w * 0.5, h * 0.9],
            [w * 0.1, h * 0.5], [w * 0.9, h * 0.5]
        ];
        let minLon = Infinity, maxLon = -Infinity;
        let minLat = Infinity, maxLat = -Infinity;
        for (const [x, y] of samplePoints) {
            const cart = this.viewer.camera.pickEllipsoid(new Cesium.Cartesian2(x, y));
            if (!cart) continue;
            const c = Cesium.Cartographic.fromCartesian(cart);
            const lon = Cesium.Math.toDegrees(c.longitude);
            const lat = Cesium.Math.toDegrees(c.latitude);
            minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
            minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
        }
        if (!isFinite(minLon)) return result;

        // Cap area to prevent explosion at high altitude
        const cap = CONFIG.BUILDING_MAX_AREA_DEG;
        if ((maxLon - minLon) > cap) {
            const c = (minLon + maxLon) / 2;
            minLon = c - cap / 2; maxLon = c + cap / 2;
        }
        if ((maxLat - minLat) > cap) {
            const c = (minLat + maxLat) / 2;
            minLat = c - cap / 2; maxLat = c + cap / 2;
        }

        const ts = CONFIG.BUILDING_TILE_DEG;
        const tx0 = Math.floor(minLon / ts), tx1 = Math.floor(maxLon / ts);
        const ty0 = Math.floor(minLat / ts), ty1 = Math.floor(maxLat / ts);
        for (let tx = tx0; tx <= tx1; tx++) {
            for (let ty = ty0; ty <= ty1; ty++) {
                result.add(`${tx}_${ty}`);
            }
        }
        return result;
    }

    queueLoad(key, isVisible) {
        if (this.queue.includes(key) || this.preloadQueue.includes(key)) return;
        if (isVisible) this.queue.push(key);
        else this.preloadQueue.push(key);
        this.pendingTiles.add(key);
    }

    nextQueuedKey() {
        // Prefer visible queue, fall back to preload
        if (this.queue.length > 0) return this.queue.shift();
        if (this.preloadQueue.length > 0) return this.preloadQueue.shift();
        return null;
    }

    processQueue() {
        if (Date.now() < this._backoffUntil) return;  // Overpass-wide cool-off
        while (this.activeTiles.size < CONFIG.BUILDING_MAX_CONCURRENT) {
            const key = this.nextQueuedKey();
            if (!key) break;
            if (this.tilesByKey.has(key)) {
                this.pendingTiles.delete(key);
                continue;
            }
            this.activeTiles.add(key);
            this.loadTile(key)
                .catch(e => console.warn('[buildings] tile load failed:', key, e))
                .finally(() => {
                    this.activeTiles.delete(key);
                    this.pendingTiles.delete(key);
                    this.processQueue();
                });
        }
    }

    async loadTile(key) {
        const [tx, ty] = key.split('_').map(Number);
        const ts = CONFIG.BUILDING_TILE_DEG;
        const south = ty * ts, west = tx * ts;
        const north = south + ts, east = west + ts;
        const query = `[out:json][timeout:25];(way["building"](${south.toFixed(6)},${west.toFixed(6)},${north.toFixed(6)},${east.toFixed(6)});relation["building"]["type"="multipolygon"](${south.toFixed(6)},${west.toFixed(6)},${north.toFixed(6)},${east.toFixed(6)}););out geom;`;

        let data = null;
        const N = CONFIG.OVERPASS_ENDPOINTS.length;
        for (let attempt = 0; attempt < N; attempt++) {
            const ep = CONFIG.OVERPASS_ENDPOINTS[(this.endpointIdx + attempt) % N];
            try {
                const res = await fetch(ep, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: 'data=' + encodeURIComponent(query)
                });
                if (!res.ok) {
                    if (res.status === 429 || res.status === 504) continue;
                    throw new Error(`HTTP ${res.status}`);
                }
                data = await res.json();
                this.endpointIdx = (this.endpointIdx + attempt) % N;
                break;
            } catch (e) {
                // try next endpoint
            }
        }

        if (!data || !data.elements) {
            this._consecutiveFailures++;
            if (this._consecutiveFailures >= 5 && !this._failureNoticeShown) {
                this._failureNoticeShown = true;
                this._backoffUntil = Date.now() + 30000;  // 30s cool-off
                if (typeof toast === 'function') {
                    toast('OSM building service unreachable (VPN can cause this). Will keep retrying.', 5000);
                }
            }
            // Don't cache on failure — let it retry on next camera move
            return;
        }
        this._consecutiveFailures = 0;
        this._failureNoticeShown = false;

        const buildings = this.extractBuildings(data);
        const primitive = buildings.length > 0 ? this.buildPrimitive(buildings) : null;
        if (primitive) {
            this.viewer.scene.primitives.add(primitive);
            // hide if not actually still in view by the time we finish
            const inView = this.computeVisibleTiles().has(key);
            primitive.show = inView;
        }
        this.tilesByKey.set(key, {
            primitive,
            count: buildings.length,
            lastSeen: Date.now(),
            empty: buildings.length === 0
        });
        this.totalBuildings += buildings.length;
    }

    extractBuildings(data) {
        const buildings = [];
        for (const el of data.elements) {
            if (el.type === 'way' && el.geometry && el.geometry.length >= 3) {
                const coords = el.geometry.map(g => [g.lon, g.lat]);
                this.closeRing(coords);
                if (coords.length < 4) continue;
                buildings.push({
                    coords,
                    height: this.parseHeight(el.tags),
                    minHeight: this.parseMinHeight(el.tags),
                    tags: el.tags || {}
                });
            } else if (el.type === 'relation' && el.members) {
                for (const m of el.members) {
                    if (m.role === 'outer' && m.geometry && m.geometry.length >= 3) {
                        const coords = m.geometry.map(g => [g.lon, g.lat]);
                        this.closeRing(coords);
                        if (coords.length < 4) continue;
                        buildings.push({
                            coords,
                            height: this.parseHeight(el.tags),
                            minHeight: this.parseMinHeight(el.tags),
                            tags: el.tags || {}
                        });
                    }
                }
            }
        }
        return buildings;
    }

    closeRing(coords) {
        const a = coords[0], b = coords[coords.length - 1];
        if (a[0] !== b[0] || a[1] !== b[1]) coords.push([a[0], a[1]]);
    }

    parseHeight(tags) {
        if (!tags) return 6;
        for (const k of ['height', 'building:height']) {
            if (tags[k]) {
                const m = String(tags[k]).match(/[\d.]+/);
                if (m) {
                    const v = parseFloat(m[0]);
                    if (!isNaN(v) && v > 0 && v < 1000) return v;
                }
            }
        }
        for (const k of ['building:levels', 'levels']) {
            if (tags[k]) {
                const v = parseFloat(tags[k]);
                if (!isNaN(v) && v > 0 && v < 200) return v * 3.2;
            }
        }
        const bt = tags['building'];
        const heuristic = {
            skyscraper: 100, tower: 50, cathedral: 45, church: 22, mosque: 22, temple: 18,
            apartments: 18, hotel: 22, office: 16, commercial: 12, retail: 8, supermarket: 8,
            industrial: 10, warehouse: 10, hangar: 14, school: 12, university: 18, hospital: 22,
            stadium: 30, parking: 12, garage: 4, shed: 3, hut: 3,
            house: 6, detached: 6, residential: 7, semidetached_house: 7, terrace: 7, bungalow: 5
        };
        if (bt && heuristic[bt]) return heuristic[bt];
        return 7;
    }

    parseMinHeight(tags) {
        if (!tags) return 0;
        for (const k of ['min_height', 'building:min_height']) {
            if (tags[k]) {
                const m = String(tags[k]).match(/[\d.]+/);
                if (m) {
                    const v = parseFloat(m[0]);
                    if (!isNaN(v) && v >= 0) return v;
                }
            }
        }
        return 0;
    }

    buildPrimitive(buildings) {
        const instances = [];
        for (const b of buildings) {
            try {
                const flat = [];
                for (let i = 0; i < b.coords.length - 1; i++) {
                    flat.push(b.coords[i][0], b.coords[i][1]);
                }
                if (flat.length < 6) continue;
                const polygon = new Cesium.PolygonGeometry({
                    polygonHierarchy: new Cesium.PolygonHierarchy(
                        Cesium.Cartesian3.fromDegreesArray(flat)
                    ),
                    extrudedHeight: b.height,
                    height: b.minHeight || 0,
                    closeBottom: false,
                    closeTop: true,
                    vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT
                });
                const color = this.colorFor(b);
                instances.push(new Cesium.GeometryInstance({
                    geometry: polygon,
                    attributes: {
                        color: Cesium.ColorGeometryInstanceAttribute.fromColor(color)
                    }
                }));
            } catch (e) { /* malformed polygon, skip */ }
        }
        if (!instances.length) return null;
        return new Cesium.Primitive({
            geometryInstances: instances,
            appearance: new Cesium.PerInstanceColorAppearance({
                flat: false,
                translucent: true,
                faceForward: true,
                closed: false
            }),
            asynchronous: true,
            interleave: true,
            shadows: Cesium.ShadowMode.DISABLED,
            releaseGeometryInstances: true
        });
    }

    colorFor(b) {
        // Height-driven ramp: short buildings start as transparent cyan and shift
        // toward blue the taller they are. Cyan (0, 1, 1) -> blue (0, 0, 1) is simply
        // the green channel falling off, so we fade green out as height climbs.
        const TALL_REFERENCE_M = 150;   // height (m) treated as "fully blue"; taller clamps here
        const tallness = Math.max(0, Math.min(b.height / TALL_REFERENCE_M, 1)); // 0 = ground, 1 = tall

        const red   = 0.05;                    // kept low so the tint stays a clean cyan/blue
        const green = 0.90 - 0.80 * tallness;  // 0.90 (cyan) at ground -> 0.10 (blue) when tall
        const blue  = 1.0;                     // always full blue
        const alpha = 0.50;                    // translucent — "transparent cyan"

        return new Cesium.Color(red, green, blue, alpha);
    }

    hideAll() {
        for (const entry of this.tilesByKey.values()) {
            if (entry.primitive) entry.primitive.show = false;
        }
    }

    setEnabled(v) {
        this.enabled = v;
        if (!v) this.hideAll();
        else this.scheduleUpdate();
    }

    evictIfNeeded() {
        if (this.tilesByKey.size <= CONFIG.BUILDING_MAX_TILES) return;
        const entries = [...this.tilesByKey.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
        const removeCount = entries.length - CONFIG.BUILDING_MAX_TILES;
        for (let i = 0; i < removeCount; i++) {
            const [key, entry] = entries[i];
            if (entry.primitive) {
                this.viewer.scene.primitives.remove(entry.primitive);
                this.totalBuildings -= entry.count;
            }
            this.tilesByKey.delete(key);
        }
    }

    getStats() {
        let active = 0;
        for (const e of this.tilesByKey.values()) {
            if (e.primitive && e.primitive.show) active++;
        }
        return { tiles: active, buildings: this.totalBuildings, cached: this.tilesByKey.size };
    }
}

// ============================================================================
// Imagery providers (free-tier-friendly)
// ============================================================================

async function makeImageryProvider(kind) {
    if (kind === 'esri') {
        return await Cesium.ArcGisMapServerImageryProvider.fromUrl(
            'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
            { enablePickFeatures: false }
        );
    }
    if (kind === 'osm') {
        return new Cesium.OpenStreetMapImageryProvider({
            url: 'https://tile.openstreetmap.org/'
        });
    }
    if (kind === 'bing') {
        if (!Cesium.Ion.defaultAccessToken) {
            throw new Error('Bing imagery requires a Cesium Ion token. Add one in the Ion panel.');
        }
        return await Cesium.IonImageryProvider.fromAssetId(2);
    }
    throw new Error(`Unknown imagery: ${kind}`);
}

async function setImagery(viewer, kind) {
    try {
        const provider = await makeImageryProvider(kind);
        viewer.imageryLayers.removeAll();
        viewer.imageryLayers.addImageryProvider(provider);
    } catch (e) {
        toast(e.message);
        // revert radio to esri
        document.querySelector('input[name=imagery][value=esri]').checked = true;
        const provider = await makeImageryProvider('esri');
        viewer.imageryLayers.removeAll();
        viewer.imageryLayers.addImageryProvider(provider);
    }
}

// ============================================================================
// Search via Nominatim
// ============================================================================

async function search(query) {
    const url = `${CONFIG.NOMINATIM}?q=${encodeURIComponent(query)}&format=json&limit=1`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`Search failed: ${res.status}`);
    const arr = await res.json();
    if (!arr.length) throw new Error('No results found.');
    const r = arr[0];
    return {
        lon: parseFloat(r.lon),
        lat: parseFloat(r.lat),
        name: r.display_name,
        bbox: r.boundingbox ? r.boundingbox.map(parseFloat) : null
    };
}

function altitudeForBoundingBox(bbox) {
    if (!bbox || bbox.length !== 4) return 2000;
    const dLat = Math.abs(bbox[1] - bbox[0]);
    const dLon = Math.abs(bbox[3] - bbox[2]);
    const span = Math.max(dLat, dLon * Math.cos(bbox[0] * Math.PI / 180));
    const meters = span * 111000;
    return Math.max(800, Math.min(meters * 2.5, 8000000));
}

// ============================================================================
// UI helpers
// ============================================================================

let toastTimer;
function toast(msg, ms = 3500) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('visible'), ms);
}

function flyTo(viewer, lon, lat, height, headingDeg = 0, pitchDeg = -45, durationSec = 2.5) {
    viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
        orientation: {
            heading: Cesium.Math.toRadians(headingDeg),
            pitch: Cesium.Math.toRadians(pitchDeg),
            roll: 0
        },
        duration: durationSec
    });
}

function fmtAlt(m) {
    if (m == null || isNaN(m)) return '–';
    if (m < 1000) return `${m.toFixed(0)} m`;
    if (m < 100000) return `${(m / 1000).toFixed(1)} km`;
    return `${(m / 1000).toFixed(0)} km`;
}

function fmtLatLon(deg, isLat) {
    if (deg == null || isNaN(deg)) return '–';
    const hem = isLat ? (deg >= 0 ? 'N' : 'S') : (deg >= 0 ? 'E' : 'W');
    return `${Math.abs(deg).toFixed(5)}° ${hem}`;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    // Token precedence: a token the user saved this session (localStorage) wins; otherwise
    // fall back to the gitignored local default (window.CESIUM_ION_TOKEN from ion_token.local.js).
    const stored = localStorage.getItem(STORAGE_KEY_TOKEN) || window.CESIUM_ION_TOKEN || '';
    if (stored) {
        Cesium.Ion.defaultAccessToken = stored;
        document.getElementById('ionToken').value = stored;
    }

    const viewer = new Cesium.Viewer('cesiumContainer', {
        baseLayer: false,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        timeline: false,
        animation: false,
        navigationHelpButton: false,
        infoBox: false,
        selectionIndicator: false,
        fullscreenButton: false,
        creditContainer: undefined,
        contextOptions: {
            webgl: { alpha: false, antialias: true, preserveDrawingBuffer: false }
        }
    });

    // Default imagery: Esri World Imagery (no key)
    await setImagery(viewer, 'esri');

    // Render quality / atmosphere defaults — guarded so newer/older Cesium versions don't break
    const scene = viewer.scene;
    const globe = scene.globe;
    const safeSet = (obj, key, val) => { try { if (obj && key in obj) obj[key] = val; } catch (e) {} };
    safeSet(globe, 'enableLighting', true);
    safeSet(globe, 'dynamicAtmosphereLighting', true);
    safeSet(globe, 'atmosphereLightIntensity', 8.0);
    safeSet(globe, 'atmosphereBrightnessShift', 0.05);
    safeSet(globe, 'atmosphereSaturationShift', 0.10);
    safeSet(globe, 'showGroundAtmosphere', true);
    safeSet(globe, 'depthTestAgainstTerrain', true);
    if (scene.skyAtmosphere) {
        scene.skyAtmosphere.show = true;
        safeSet(scene.skyAtmosphere, 'brightnessShift', 0.10);
        safeSet(scene.skyAtmosphere, 'saturationShift', 0.05);
        safeSet(scene.skyAtmosphere, 'atmosphereLightIntensity', 8.0);
    }
    if (scene.fog) {
        scene.fog.enabled = false;
        safeSet(scene.fog, 'density', 0.00015);
    }
    try { scene.postProcessStages.fxaa.enabled = true; } catch (e) {}
    if ('requestRenderMode' in scene) {
        scene.requestRenderMode = true;
        scene.maximumRenderTimeChange = Infinity;
    }
    // Adapt to device pixel ratio for crispness without crushing FPS
    safeSet(scene, 'useBrowserRecommendedResolution', true);
    viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 1.5);

    // Initial position: looking at Earth from space
    const p = CONFIG.PRESETS.space;
    viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height),
        orientation: {
            heading: Cesium.Math.toRadians(p.heading),
            pitch: Cesium.Math.toRadians(p.pitch),
            roll: 0
        }
    });

    // Building loader (Overpass-based fallback)
    const buildings = new OsmBuildingLoader(viewer);
    let ionBuildingsTileset = null;

    // Load Cesium OSM Buildings 3D Tileset (pre-baked global, fast). Disables Overpass loader on success.
    async function loadIonBuildings() {
        if (!Cesium.Ion.defaultAccessToken) return false;
        if (ionBuildingsTileset) return true;
        try {
            const tileset = await Cesium.createOsmBuildingsAsync();
            // Subtle translucency to match the Overpass-style aesthetic
            try {
                // Match the Overpass loader's look: translucent cyan at ground level,
                // shifting toward blue the taller the building (banded on estimated height).
                tileset.style = new Cesium.Cesium3DTileStyle({
                    color: {
                        conditions: [
                            ["${feature['cesium#estimatedHeight']} >= 150", "color('#0a1aff', 0.5)"],
                            ["${feature['cesium#estimatedHeight']} >= 90",  "color('#0a4dff', 0.5)"],
                            ["${feature['cesium#estimatedHeight']} >= 60",  "color('#0a80ff', 0.5)"],
                            ["${feature['cesium#estimatedHeight']} >= 30",  "color('#0ab3ff', 0.5)"],
                            ["true",                                        "color('#0ae6ff', 0.5)"]
                        ]
                    }
                });
            } catch (styleErr) { /* style optional */ }
            scene.primitives.add(tileset);
            ionBuildingsTileset = tileset;
            buildings.setEnabled(false);  // disable Overpass loader; tileset is comprehensive
            toast('Cesium OSM Buildings (global tileset) loaded — instant building streaming worldwide.', 5500);
            return true;
        } catch (e) {
            console.warn('OSM Buildings tileset load failed:', e);
            return false;
        }
    }

    function unloadIonBuildings() {
        if (ionBuildingsTileset) {
            scene.primitives.remove(ionBuildingsTileset);
            ionBuildingsTileset = null;
        }
        buildings.setEnabled(document.getElementById('toggleBuildings').checked);
    }

    // Try to attach Cesium World Terrain + OSM Buildings if a token is present at startup
    if (Cesium.Ion.defaultAccessToken) {
        try {
            const terrain = await Cesium.CesiumTerrainProvider.fromIonAssetId(1);
            viewer.terrainProvider = terrain;
            toast('Cesium World Terrain enabled.');
        } catch (e) {
            console.warn('Terrain load failed:', e);
        }
        loadIonBuildings();  // async, don't block startup
    }

    // -----------------------------------------------------------------------
    // UI bindings
    // -----------------------------------------------------------------------

    // Imagery radios
    document.querySelectorAll('input[name=imagery]').forEach(r => {
        r.addEventListener('change', () => { if (r.checked) setImagery(viewer, r.value); });
    });

    // Layer toggles
    document.getElementById('toggleBuildings').addEventListener('change', e => {
        if (ionBuildingsTileset) {
            ionBuildingsTileset.show = e.target.checked;
        } else {
            buildings.setEnabled(e.target.checked);
        }
    });
    document.getElementById('toggleAtmos').addEventListener('change', e => {
        scene.skyAtmosphere.show = e.target.checked;
        globe.showGroundAtmosphere = e.target.checked;
    });
    document.getElementById('toggleLighting').addEventListener('change', e => {
        globe.enableLighting = e.target.checked;
    });
    document.getElementById('toggleStars').addEventListener('change', e => {
        scene.skyBox.show = e.target.checked;
        scene.sun.show = e.target.checked;
        scene.moon.show = e.target.checked;
    });
    document.getElementById('toggleFog').addEventListener('change', e => {
        scene.fog.enabled = e.target.checked;
    });

    // Sun / time
    const sunSlider = document.getElementById('sunSlider');
    sunSlider.addEventListener('input', () => {
        const secs = parseInt(sunSlider.value, 10);
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        const t = Cesium.JulianDate.fromDate(new Date(today.getTime() + secs * 1000));
        viewer.clock.shouldAnimate = false;
        viewer.clock.currentTime = t;
        scene.requestRender();
    });
    document.getElementById('nowBtn').addEventListener('click', () => {
        viewer.clock.currentTime = Cesium.JulianDate.fromDate(new Date());
        viewer.clock.shouldAnimate = false;
        scene.requestRender();
        toast('Sun set to current real-world time.');
    });

    // Ion token
    document.getElementById('ionApply').addEventListener('click', async () => {
        const tok = document.getElementById('ionToken').value.trim();
        if (!tok) { toast('Paste a token first.'); return; }
        Cesium.Ion.defaultAccessToken = tok;
        localStorage.setItem(STORAGE_KEY_TOKEN, tok);
        try {
            const terrain = await Cesium.CesiumTerrainProvider.fromIonAssetId(1);
            viewer.terrainProvider = terrain;
            toast('Ion token applied — terrain enabled.');
        } catch (e) {
            toast('Ion token rejected: ' + e.message);
            return;
        }
        await loadIonBuildings();
    });
    document.getElementById('ionClear').addEventListener('click', () => {
        Cesium.Ion.defaultAccessToken = '';
        localStorage.removeItem(STORAGE_KEY_TOKEN);
        unloadIonBuildings();
        document.getElementById('ionToken').value = '';
        viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
        toast('Ion token cleared.');
    });

    // Presets
    document.querySelectorAll('.presets button').forEach(btn => {
        btn.addEventListener('click', () => {
            const p = CONFIG.PRESETS[btn.dataset.preset];
            if (!p) return;
            flyTo(viewer, p.lon, p.lat, p.height, p.heading, p.pitch, 2.5);
            toast(`Flying to ${p.name}…`);
        });
    });

    // Search
    const doSearch = async () => {
        const q = document.getElementById('searchInput').value.trim();
        if (!q) return;
        toast('Searching…', 2000);
        try {
            const r = await search(q);
            const alt = altitudeForBoundingBox(r.bbox);
            flyTo(viewer, r.lon, r.lat, alt, 0, alt < 5000 ? -35 : -75, 2.8);
            toast(`Found: ${r.name.split(',').slice(0, 3).join(',')}`);
        } catch (e) {
            toast('Search error: ' + e.message);
        }
    };
    document.getElementById('searchBtn').addEventListener('click', doSearch);
    document.getElementById('searchInput').addEventListener('keydown', e => {
        if (e.key === 'Enter') doSearch();
    });

    // -----------------------------------------------------------------------
    // HUD updater
    // -----------------------------------------------------------------------
    const hudLat = document.getElementById('hudLat');
    const hudLon = document.getElementById('hudLon');
    const hudAlt = document.getElementById('hudAlt');
    const hudFps = document.getElementById('hudFps');
    const hudTiles = document.getElementById('hudTiles');
    const hudBldgs = document.getElementById('hudBldgs');

    let frameCount = 0, fpsAccum = 0, lastFpsTime = performance.now();
    function tick() {
        frameCount++;
        const now = performance.now();
        if (now - lastFpsTime > 500) {
            fpsAccum = (frameCount * 1000) / (now - lastFpsTime);
            frameCount = 0;
            lastFpsTime = now;

            const carto = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC);
            if (carto) {
                hudLat.textContent = fmtLatLon(Cesium.Math.toDegrees(carto.latitude), true);
                hudLon.textContent = fmtLatLon(Cesium.Math.toDegrees(carto.longitude), false);
                hudAlt.textContent = fmtAlt(carto.height);
            }
            hudFps.textContent = fpsAccum.toFixed(0);
            if (ionBuildingsTileset) {
                hudTiles.textContent = 'Ion';
                hudBldgs.textContent = 'global';
            } else {
                const stats = buildings.getStats();
                hudTiles.textContent = `${stats.tiles}/${stats.cached}`;
                hudBldgs.textContent = stats.buildings;
            }
        }
        requestAnimationFrame(tick);
    }
    tick();

    // -----------------------------------------------------------------------
    // Done loading
    // -----------------------------------------------------------------------
    setTimeout(() => {
        document.getElementById('loading').classList.add('hidden');
    }, 1200);

    // Expose for debugging
    window.viewer = viewer;
    window.buildings = buildings;
}

main().catch(err => {
    console.error(err);
    const el = document.getElementById('loadingText');
    if (el) el.textContent = 'Failed to load: ' + err.message;
});

})();
