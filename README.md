# Earth Digital Twin — Space to Street

Fully interactive 3D Earth viewer that zooms seamlessly from outer space down to individual streets and buildings. Renders a realistic planet, atmosphere, day/night terminator, and global 3D buildings sourced from OpenStreetMap.

Built with **CesiumJS** (Apache 2.0). All required assets are free and public — no API keys required to run.

---

## Run it

The viewer is a static page, but most browsers block `fetch()` over `file://`, so it must be served via HTTP. Pick whichever is easiest:

**Python (already installed):**

```bash
cd D:\Projects\Digital_Twin_Earth
python serve.py
```

Then open <http://localhost:8765> in any modern browser (Chrome / Edge / Firefox / Safari).

**One-liner alternatives:**

```bash
# Python 3 stdlib
python -m http.server 8765

# Node.js
npx serve -l 8765 .
```

---

## Features

- **Seamless zoom** — drag, scroll-wheel, or fly-to a preset; transition smoothly from a 30,000 km orbital view all the way to street-level.
- **Realistic Earth** — Esri World Imagery base layer, atmospheric scattering on the limb, sun-driven day/night lighting, stars and Milky Way skybox.
- **Global 3D buildings** — every building tagged in OpenStreetMap is extruded to its real height (or estimated from `building:levels` / type heuristics) when you zoom under 5 km. Streamed per-tile so the browser only loads what you can see.
- **Search** — type any place name; the viewer queries the free Nominatim geocoder and flies to it at an appropriate altitude.
- **Presets** — one-click jump to Earth from space, Colorado Springs, Manhattan, London, Tokyo, Paris, Dubai, San Francisco.
- **Time control** — slide the sun to any hour of the day, or snap to real-world time.
- **Layer toggles** — buildings, atmosphere, lighting, stars, distance fog.
- **HUD** — live lat / lon / altitude / FPS / loaded building count.

---

## Controls

| Action | Mouse | Touch |
|---|---|---|
| Pan | Left-drag | One-finger drag |
| Rotate / tilt | Right-drag (or Ctrl+left-drag) | Two-finger drag |
| Zoom | Scroll wheel | Pinch |

Use the **search bar** (top) to jump to any place by name. Use the **preset buttons** for famous landmarks. Use the **layer panel** (left) to toggle imagery sources and effects.

---

## Free assets used

| Asset | Source | License | Key required? |
|---|---|---|---|
| Globe engine | [CesiumJS](https://cesium.com/cesiumjs/) | Apache 2.0 | No |
| Default imagery | [Esri World Imagery](https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9) | Esri terms (attribution) | No |
| Alt imagery | [OpenStreetMap tiles](https://www.openstreetmap.org/copyright) | ODbL | No |
| 3D buildings | [OSM Overpass API](https://overpass-api.de/) | ODbL | No |
| Geocoder | [Nominatim](https://nominatim.org/) | ODbL | No |

Please respect OSM's [usage policies](https://operations.osmfoundation.org/policies/) — this app is fine for personal / development use; high-volume deployments should self-host Overpass and Nominatim.

---

## Optional upgrades (Cesium Ion)

CesiumJS is fully functional without an account, but Cesium offers a generous free tier ([sign up](https://cesium.com/ion/signup)) that unlocks:

- **Cesium World Terrain** — global high-resolution elevation. Mountains pop, valleys carve.
- **Bing Maps Aerial with Labels** — sharper, more recent imagery in many regions.
- **Cesium OSM Buildings** — pre-baked global 3D building tileset (faster than streaming Overpass live).

To use: paste your Ion access token into the "Cesium Ion" panel in the controls. The token is saved in `localStorage` and re-applied next visit. Click **Clear** to revert to the free-asset stack.

---

## Architecture

### Files

```
Digital_Twin_Earth/
├── index.html      # UI scaffold + Cesium CDN
├── styles.css      # Glassmorphism dark UI
├── app.js          # All logic: viewer, building loader, search, UI bindings
├── serve.py        # Trivial localhost server
└── README.md
```

### Building loader

The `OsmBuildingLoader` class is the centerpiece. It maintains a per-tile cache of OSM building polygons:

1. **Camera move** triggers `scheduleUpdate()` (debounced ~80 ms).
2. **Altitude check** — if camera is above 5 km, all buildings are hidden (out of LOD range).
3. **Visible-tile computation** — projects the screen frustum corners onto the globe ellipsoid, snaps to a 0.01° tile grid, capped at 0.06° square to prevent explosion at higher altitudes.
4. **Queue + fetch** — missing tiles are added to a queue; up to 2 concurrent Overpass requests pull buildings inside that tile's bbox.
5. **Geometry build** — each building's polygon is closed, height parsed from `height` / `building:height` / `building:levels` / type heuristic, then converted to a `PolygonGeometry` with `extrudedHeight`. All buildings in a tile are batched into a single `Primitive` with `PerInstanceColorAppearance` for efficient draw-call usage.
6. **Color** — deterministic per-building variation seeded from coordinates. Skyscrapers get a cool blue tint, mid-rises neutral, industrial warm tan, religious sandstone, residential warm gray.
7. **Cache** — up to 96 tiles kept in memory; oldest are evicted when full.

This streams roughly 100–2000 buildings per visible tile from Overpass within 1–3 seconds of zooming in, with no auth and no pre-baked tilesets.

### Performance notes

- `requestRenderMode = true` — Cesium only redraws when the scene changes, dropping idle GPU usage from ~80% to <1%.
- Buildings batched per-tile (one draw call per ~hundred buildings) instead of one entity each.
- `releaseGeometryInstances: true` frees CPU-side polygon data after upload to the GPU.
- `resolutionScale` capped at 1.5× device pixel ratio to keep 4K monitors smooth.
- FXAA enabled for inexpensive edge smoothing instead of MSAA.

### Adding more presets

Edit `CONFIG.PRESETS` in `app.js`. Add a button in `index.html` `.presets` div with a matching `data-preset` attribute.

---

## Known limitations

- **Without Ion:** no terrain elevation (Earth is a perfect ellipsoid). Mountains look flat. The atmosphere and imagery are still beautiful, but Half Dome won't dome.
- **OSM building coverage** is uneven. Western Europe, Japan, and major US cities are very dense. Rural areas and parts of the Global South are sparse.
- **Building heights** are estimated when the OSM tag is missing — most residential houses default to 6 m, most apartments to 18 m. Skylines look right; individual structures may be off by a level.
- **Overpass rate limits.** If you fly around very fast over dense cities, you may hit a temporary 429. The loader rotates through four mirror endpoints and retries; usually invisible.
- **No interior** — buildings are extruded shells, no models or textures inside.

---

## License

This project: MIT. Asset licenses retained as listed above.
