# Potree BIM Demo

Convert SVF derivatives from Autodesk Platform Services (APS) to GLB, and visualize alongside point clouds in a Potree-based viewer.

## Features

- **Direct Conversion** - Convert SVF to GLB directly from APS (no manual download required)
- **Auto SVF Generation** - Automatically triggers SVF1 translation if only SVF2 exists
- **IFC Direct Pipeline** - Upload and convert IFC files directly to GLB using IfcConvert
- **Potree Viewer** - Web viewer with BIM overlay and alignment controls
- **Unified Model Registry** - Single API to list both APS-converted and IFC models

## Quick Start

```bash
# Install dependencies
npm install

# Download Potree libraries (required for viewer)
npm run setup-potree

# Configure environment
cp .env.example .env
# Edit .env with your APS credentials

# Start server
npm run dev

# Open browser
# http://localhost:3000
```

### Manual Potree Setup (if npm script fails)

```powershell
# Windows PowerShell
mkdir -p public\libs\potree
Invoke-WebRequest -Uri "https://github.com/potree/potree/releases/download/1.8/Potree_1.8.zip" -OutFile "public\libs\Potree_1.8.zip"
Expand-Archive -Path "public\libs\Potree_1.8.zip" -DestinationPath "public\libs\potree" -Force
Remove-Item "public\libs\Potree_1.8.zip"
```

```bash
# Linux/Mac
mkdir -p public/libs/potree
curl -L -o public/libs/Potree_1.8.zip https://github.com/potree/potree/releases/download/1.8/Potree_1.8.zip
unzip public/libs/Potree_1.8.zip -d public/libs/potree
rm public/libs/Potree_1.8.zip
```

## Why Manifest-Only Download Doesn't Work

The APS manifest lists derivative URNs, but these URNs only reference **partial** SVF data. A complete SVF package includes internal assets like:

- `FragmentList.pack` - Fragment data
- `GeometryMetadata.pf` - Geometry metadata
- `Materials.json.gz` - Material definitions
- Various `.pf` pack files

These internal assets are **not listed** in the manifest but are referenced by the `.svf` file. Attempting to convert a manifest-only download results in:

```
ENOENT: no such file or directory, open '.../FragmentList.pack'
```

## Correct Approach: Direct Conversion

The `forge-convert-utils` library can read SVF directly from the APS Derivative Service, automatically downloading all required assets:

```bash
# Convert directly from APS (recommended)
curl -X POST http://localhost:3000/api/convert-to-glb \
  -H "Content-Type: application/json" \
  -d '{"urn": "YOUR_URN_HERE"}'
```

This:
1. Checks if SVF1 exists (required for conversion)
2. If only SVF2 exists, triggers an SVF1 translation job and waits
3. Downloads all required SVF assets via `forge-convert-utils`
4. Converts to GLB with optimizations
5. Saves to `data/converted/<urn>/<runId>/model.glb`

## IFC Direct Pipeline

In addition to APS models, you can upload and convert IFC files directly using IfcConvert (IfcOpenShell).

### Installing IfcConvert

**Windows:**
1. Download from https://blenderbim.org/docs-python/ifcopenshell-python/installation.html
2. Extract and add the folder containing `IfcConvert.exe` to your PATH

**Linux/Mac:**
```bash
# Using pip
pip install ifcopenshell

# Or download pre-built binaries from:
# https://github.com/IfcOpenShell/IfcOpenShell/releases
```

### IFC Endpoints

```bash
# Upload an IFC file
curl -X POST http://localhost:3000/api/ifc/upload \
  -F "file=@/path/to/model.ifc"

# Convert IFC to GLB (with caching)
curl -X POST http://localhost:3000/api/ifc/ensure-glb \
  -H "Content-Type: application/json" \
  -d '{"ifcId": "my-model-id"}'
```

### Manual IFC Placement

You can also manually place IFC files:

```
data/ifc/
├── building-a/
│   └── model.ifc
├── site-survey/
│   └── model.ifc
```

The models will appear in the viewer's BIM dropdown with `[IFC]` prefix.

### How IFC Conversion Works

1. IFC file hash is calculated (sha256, first 16 chars)
2. If GLB exists at `data/converted-ifc/<ifcId>/<hash>/model.glb`, return cached
3. Otherwise, run IfcConvert: `IfcConvert model.ifc temp_output.gltf`
4. Optimize with @gltf-transform (prune, dedup, weld)
5. Save final GLB and metadata

## Raw Point Cloud Support (LAS/LAZ/E57)

In addition to pre-converted Potree clouds, you can use raw point cloud files (LAS, LAZ, E57, PLY, XYZ, PTS) that will be automatically converted to Potree format.

### Installing PotreeConverter

**Windows:**
1. Download from https://github.com/potree/PotreeConverter/releases
2. Extract to a folder (e.g., `C:\Tools\PotreeConverter`)
3. Add to PATH or set in `.env`:
   ```env
   POTREE_CONVERTER_PATH=C:\Tools\PotreeConverter\PotreeConverter.exe
   ```

**Linux/Mac:**
```bash
git clone https://github.com/potree/PotreeConverter.git
cd PotreeConverter && mkdir build && cd build
cmake .. && make
# Add to PATH or set POTREE_CONVERTER_PATH
```

### Adding Raw Point Clouds

Place raw files in `data/pointclouds_raw/`:

```
data/pointclouds_raw/
├── site_survey.las
├── building_scan.laz
└── interior.e57
```

### How It Works

1. Raw files appear in the viewer dropdown with `⚙ [RAW]` prefix
2. When selected and loaded, the backend:
   - Calculates file hash (sha256) for caching
   - Runs PotreeConverter to generate Potree format
   - Saves output to `data/pointclouds/<cloudId>/`
3. Subsequent loads use the cached conversion

### Point Cloud Endpoints

```bash
# List all point clouds (raw + converted)
GET /api/pointclouds

# Ensure raw cloud is converted to Potree
POST /api/pointclouds/ensure
  { "id": "pc:raw:site_survey" }
  # or: { "rawFileName": "site_survey.las" }
```

## APS Authentication

This application uses 2-legged OAuth (Client Credentials flow).

### Required Scopes

| Scope | Purpose |
|-------|---------|
| `data:read` | Read objects and manifests |
| `data:write` | Create translation jobs |
| `bucket:read` | List buckets and objects |
| `viewables:read` | Download derivative assets |

## API Endpoints

### Convert to GLB (Recommended)

```bash
POST /api/convert-to-glb
{
  "urn": "base64-url-safe-urn",
  "viewName": "Vista 3D",       # optional: specific view name
  "outputName": "model.glb",    # optional: output filename
  "quality": "balanced"         # fast | balanced | small
}
```

Response:
```json
{
  "success": true,
  "urn": "dXJuOmFkc2...",
  "runId": "abc123",
  "viewableGuid": "...",
  "viewableName": "Vista 3D",
  "glbUrl": "/assets/models/.../abc123/model.glb",
  "bytes": 15728640,
  "meshCount": 1234,
  "materialCount": 56,
  "durationMs": 45000
}
```

### Other Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/api/buckets` | List all buckets |
| GET | `/api/buckets/:key/objects` | List objects in bucket |
| GET | `/api/manifest/:urn` | Get manifest + analysis |
| GET | `/api/convert-status/:urn/:runId` | Check conversion status |
| POST | `/api/ifc/upload` | Upload IFC file |
| POST | `/api/ifc/ensure-glb` | Convert IFC to GLB |
| GET | `/api/bim-models` | List all models (APS + IFC) |
| GET | `/viewer?modelId=` | Open Potree viewer |

## Conversion Phases

```
┌─────────────────────────────────────────────────────────────────┐
│  POST /api/convert-to-glb { urn }                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 1: Check SVF availability                                 │
│  - Uses forge-server-utils to analyze manifest                  │
│  - Checks for application/autodesk-svf MIME type               │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
    ┌─────────────────────┐       ┌─────────────────────┐
    │  SVF exists         │       │  Only SVF2 exists   │
    │  → Continue         │       │  → Generate SVF1    │
    └─────────────────────┘       └─────────────────────┘
                                              │
                                              ▼
                              ┌─────────────────────────────────┐
                              │  POST /modelderivative/v2/job   │
                              │  Poll until status="success"    │
                              └─────────────────────────────────┘
                                              │
              ┌───────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 2: Convert SVF to GLB                                     │
│  - SvfReader.FromDerivativeService() downloads all assets       │
│  - GltfWriter generates raw GLB                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 3: Optimize & Save                                        │
│  - Apply @gltf-transform optimizations (prune, dedup, weld)    │
│  - Save to data/converted/<urn>/<runId>/model.glb              │
└─────────────────────────────────────────────────────────────────┘
```

## Viewer

Open the viewer with your converted model:

```
http://localhost:3000/viewer?urn=YOUR_URN&run=RUN_ID
```

With point cloud:
```
http://localhost:3000/viewer?urn=YOUR_URN&run=RUN_ID&cloud=/pointclouds/mycloud/cloud.js
```

### Controls

- **Visibility**: Toggle BIM model, point cloud, grid, axes
- **Opacity**: Adjust BIM model transparency
- **Transform**: Nudge position, rotation, scale
- **Alignment**: Save/load alignment matrix

## Point Cloud Testing Checklist

Use this checklist to verify point cloud loading is working end-to-end:

### 1. Verify PotreeConverter is installed

```bash
# Should show version info
PotreeConverter --help

# Or if using custom path
%POTREE_CONVERTER_PATH% --help
```

### 2. Add a raw point cloud file

```bash
# Place a .las/.laz/.e57 file in:
data/pointclouds_raw/test_cloud.las
```

### 3. Test conversion via API

```bash
# Trigger conversion
curl -X POST http://localhost:3000/api/pointclouds/ensure \
  -H "Content-Type: application/json" \
  -d '{"rawFileName": "test_cloud.las"}'

# Expected response (success):
# {
#   "success": true,
#   "cloudId": "test_cloud_abc123",
#   "cloudJsUrl": "/pointclouds/test_cloud_abc123/cloud.js",
#   ...
# }
```

### 4. Verify cloud.js is accessible

```bash
# Test HTTP access
curl -I http://localhost:3000/pointclouds/test_cloud_abc123/cloud.js

# Expected: HTTP 200
# If 404: check data/pointclouds/ folder structure
```

### 5. Use debug endpoint

```bash
curl "http://localhost:3000/api/pointclouds/debug?cloudId=test_cloud_abc123"

# Should show:
# - cloudJsExists: true
# - cloudJsSize: > 0
# - sampleFiles: list of octree files
# - hints: helpful messages
```

### 6. Test in viewer

1. Open http://localhost:3000/viewer
2. Select the point cloud from dropdown
3. Click "Load Selected"
4. Check Debug Log panel for:
   - `Loading point cloud: /pointclouds/.../cloud.js`
   - `HEAD .../cloud.js: HTTP 200`
   - `Point cloud loaded: X points`

### Common Issues

| Symptom | Cause | Solution |
|---------|-------|----------|
| cloud.js 404 | Path mismatch | Check `data/pointclouds/<cloudId>/cloud.js` exists |
| Potree.loadPointCloud fails | JS error | Check browser console for Potree errors |
| Cloud loads but invisible | Camera/scale issue | Use "Focus Cloud" button, increase point size |
| Cloud loads but sparse | Low point budget | Increase point budget slider |
| Conversion fails | PotreeConverter missing | Install and set `POTREE_CONVERTER_PATH` |

### Debug API Response Example

```json
{
  "cloudId": "test_cloud_abc123",
  "cloudJsUrl": "/pointclouds/test_cloud_abc123/cloud.js",
  "cloudJsExists": true,
  "cloudJsSize": 4523,
  "sampleFiles": [
    "/cloud.js",
    "/hierarchy.bin",
    "/r/r.bin"
  ],
  "convertMeta": {
    "convertedAt": "2024-01-15T10:30:00Z",
    "pointCount": 1500000,
    "durationMs": 12500
  },
  "hints": ["Output looks valid"]
}
```

## Troubleshooting

### "No SVF derivatives found"

The model only has SVF2. The API will automatically generate SVF1 if needed. This may take several minutes for large models.

### "ENOENT FragmentList.pack"

You're trying to convert from a manifest-only download. Use the direct conversion API instead:

```bash
# Wrong: Manual download then convert
curl -X POST /api/download-derivative ...
curl -X POST /api/convert-to-glb { downloadRunId: "..." }

# Right: Direct conversion
curl -X POST /api/convert-to-glb { urn: "..." }
```

### "Timeout waiting for SVF derivative"

The SVF1 translation is taking too long. Options:
- Increase `SVF_POLL_TIMEOUT_MS` in `.env` (default: 10 minutes)
- Check model status in APS portal
- Try again later

### Performance

Large models may take several minutes to convert. The conversion:
1. Downloads all SVF assets from APS (~30s-2min)
2. Parses geometry and materials (~10s-1min)
3. Writes GLB (~5s-30s)
4. Optimizes (~5s-30s)

## Potree Viewer

The viewer at `/viewer` allows you to visualize point clouds and BIM models together, with controls for alignment.

### URL Parameters

```
/viewer?modelId=<modelId>&cloudId=<cloudId>
```

- `modelId` - Unified model ID:
  - For APS models: `aps:<urn>:<runId>`
  - For IFC models: `ifc:<ifcId>`
- `cloudId` - Point cloud folder name (from `data/pointclouds/`)

All parameters are optional. The viewer will populate dropdowns from available data.

### Adding Point Clouds

Place Potree-converted point clouds in `data/pointclouds/<cloudId>/`:

```
data/pointclouds/
├── mycloud/
│   ├── cloud.js           # Required: Potree entry point
│   ├── hierarchy.bin
│   ├── octree.bin
│   └── ...
└── anothercloud/
    └── cloud.js
```

The cloud will automatically appear in the dropdown after refresh.

### Adding BIM Models

Convert models using the API or CLI:

```bash
# Via API
curl -X POST http://localhost:3000/api/convert-to-glb \
  -H "Content-Type: application/json" \
  -d '{"urn": "YOUR_URN_HERE"}'
```

Converted models are saved to `data/converted/<urn>/<runId>/model.glb`.

### Viewer Controls

**Mouse:**
- Left-drag: Rotate camera
- Right-drag: Pan camera
- Scroll: Zoom
- **Click on BIM element** - Select element (emissive highlight) and show selection panel

**Keyboard:**
- `R` - Reset camera
- `F` - Focus on both cloud and BIM
- `C` - Focus on cloud
- `B` - Focus on BIM
- `D` - Run diagnostics
- `U` - Toggle unlit mode
- `H` - Hide selected element
- `I` - Isolate selected element
- `Shift+A` - Show all elements
- `ESC` - Clear selection / Unpin selection

### Robust Selection & Advanced Panel (ENTREGA 2)

The viewer includes a **robust selection system** with an advanced properties panel that allows testing the full selection workflow before integrating with real APS property databases.

**Selection System:**

1. **Click any BIM element** in the viewer to select it
2. The system finds the "Selection Root" - the most meaningful ancestor in the object hierarchy:
   - Looks for objects with significant names (not generic like "mesh_0", "Object_123")
   - Checks for `userData.selectable === true`
   - Falls back to direct child of BIM root
3. The element gets highlighted using **emissive color** (preserves original materials)
4. A **Selection Panel** appears with full details and actions

**Highlight System (improved):**
- Uses `material.emissive` when available (MeshStandardMaterial, MeshPhongMaterial)
- Preserves original material properties
- Falls back to color change only if no emissive support
- Perfect restoration on deselection

**Selection Panel Features:**

| Feature | Description |
|---------|-------------|
| **Pin Selection** | Lock current selection, ignore new clicks |
| **Copy Key** | Copy selection key to clipboard |
| **Search Properties** | Filter properties by name or value in real-time |
| **Collapsible Groups** | Click group headers to expand/collapse |
| **Copy JSON** | Export all properties as JSON |
| **Hide/Isolate/Show All** | Visibility controls for selected elements |

**Visibility Actions:**

```
[Hide]      - Hides the selected element
[Isolate]   - Shows only the selected element, hides all others
[Show All]  - Restores visibility of all elements
```

**Keyboard Shortcuts:**

| Key | Action |
|-----|--------|
| `H` | Hide selected element |
| `I` | Isolate selected element |
| `Shift+A` | Show all elements |
| `ESC` | Clear selection / Unpin |

**Mock Properties (Enhanced):**

The mock properties endpoint now returns richer, more realistic BIM data:

```bash
# Test the mock properties endpoint
curl "http://localhost:3000/api/mock-properties?key=Wall-123&name=Interior%20Wall"

# Response (ENTREGA 2 format):
{
  "element": {
    "key": "Wall-123",
    "name": "Interior Wall",
    "pseudoDbId": 456789,
    "externalId": "ext-0006f855"
  },
  "source": "mock",
  "units": "m",
  "cachedAt": "2024-01-15T10:30:00.000Z",
  "groups": [
    {
      "group": "Identity Data",
      "expanded": true,
      "props": [
        { "name": "Category", "value": "Walls" },
        { "name": "Family", "value": "Basic Wall" },
        { "name": "Type", "value": "Generic - 200mm" },
        ...
      ]
    },
    {
      "group": "Constraints",
      "expanded": true,
      "props": [
        { "name": "Base Constraint", "value": "Level 01" },
        { "name": "Top Constraint", "value": "Level 02" },
        ...
      ]
    },
    {
      "group": "Dimensions",
      "expanded": true,
      "props": [
        { "name": "Length", "value": "4.235 m" },
        { "name": "Height", "value": "3.150 m" },
        { "name": "Area", "value": "13.34 m²" },
        ...
      ]
    },
    ...
  ]
}
```

**Property Groups:**
- Identity Data (Category, Family, Type, Mark)
- Constraints (Base/Top levels and offsets)
- Dimensions (Length, Width, Height, Area, Volume)
- Materials and Finishes
- Analytical Properties (Fire Rating, Thermal)
- Phasing
- IFC Parameters
- Other (Workset, Design Option, Element ID)

**Caching:**
- Backend: In-memory cache by selection key (persists during server runtime)
- Frontend: Local cache by selection key (instant subsequent loads)
- Clear cache: `DELETE /api/mock-properties/cache`

**Key features:**
- **Deterministic**: Same element always returns the same mock properties (hash-based seed)
- **Realistic data**: Matches real Revit/BIM property structure
- **No APS dependency**: Works without property database connection
- **Selection Key**: Uses `object.name || object.uuid` (will be replaced by `dbId` later)

**UI Panel:**
- Select point cloud and BIM model from dropdowns
- Toggle visibility of cloud/BIM/grid
- Adjust opacity and point budget
- Fine-tune BIM position/rotation
- Save alignment for future sessions

### API Endpoints for Viewer

```bash
# List available point clouds
GET /api/pointclouds
# Response: { pointclouds: [{ id, name, cloudJs }] }

# List available BIM models (both APS and IFC)
GET /api/bim-models
# Response: { models: [
#   { id: "aps:<urn>:<runId>", type: "glb", source: "aps", glbUrl, ... },
#   { id: "ifc:<ifcId>", type: "ifc", source: "direct", ifcUrl, ... }
# ]}

# Ensure IFC is converted to GLB (with caching)
POST /api/ifc/ensure-glb
  { "ifcId": "<ifcId>", "quality": "balanced" }
# Response: { glbUrl, hash, cached, durationMs }

# Get/Save alignment (supports both urn and modelId)
GET /api/alignment?modelId=<modelId>
GET /api/alignment?urn=<urn>  # legacy support
POST /api/alignment
  { "modelId": "ifc:<ifcId>", "matrix": [16 numbers], "units": "m" }
  # or: { "urn": "<urn>", "matrix": [...], "units": "m" }

# Get mock properties for a selected element (ENTREGA 2)
GET /api/mock-properties?key=<selectionKey>&name=<objectName>
# Response: { element, source, units, cachedAt, groups: [{group, expanded, props}] }

# Clear mock properties cache (ENTREGA 2)
DELETE /api/mock-properties/cache
# Response: { success: true, clearedEntries: <count> }
```

## Project Structure

```
potree-bim-demo/
├── src/
│   ├── server.ts              # Express server
│   ├── aps/
│   │   ├── auth.ts            # APS OAuth
│   │   ├── bucket.ts          # Bucket operations
│   │   ├── derivative.ts      # Manifest analysis
│   │   └── translate.ts       # SVF1 job creation
│   ├── convert/
│   │   ├── forgeConvert.ts    # Direct SVF→GLB conversion (APS)
│   │   ├── ifcToGlb.ts        # IFC→GLB conversion (IfcConvert)
│   │   ├── optimize.ts        # GLB optimization
│   │   └── lock.ts            # Conversion lock
│   ├── pointcloud/
│   │   └── convertRawToPotree.ts  # LAS/LAZ→Potree conversion
│   └── utils/
├── public/
│   ├── index.html             # API UI + bucket browser
│   └── viewer/                # Potree + BIM viewer
│       ├── index.html
│       ├── app.js
│       └── style.css
├── data/
│   ├── converted/             # GLB from APS (SVF→GLB)
│   ├── converted-ifc/         # GLB from IFC (IFC→GLB)
│   ├── ifc/                   # Uploaded IFC files
│   ├── pointclouds/           # Converted Potree data
│   ├── pointclouds_raw/       # Raw point clouds (LAS/LAZ/E57)
│   ├── pointclouds_cache/     # Conversion metadata/logs
│   └── alignment/             # Alignment JSON files
└── README.md
```

## Environment Variables

```env
# Required: APS credentials
APS_CLIENT_ID=your_client_id
APS_CLIENT_SECRET=your_client_secret

# Server
PORT=3000

# Directories
CONVERTED_DIR=./data/converted
CONVERTED_IFC_DIR=./data/converted-ifc
IFC_DIR=./data/ifc
POINTCLOUD_DIR=./data/pointclouds
POINTCLOUD_RAW_DIR=./data/pointclouds_raw
POINTCLOUD_CACHE_DIR=./data/pointclouds_cache
ALIGNMENT_DIR=./data/alignment

# External tools (optional, defaults to PATH lookup)
POTREE_CONVERTER_PATH=PotreeConverter

# Translation polling (optional)
SVF_POLL_INTERVAL_MS=5000
SVF_POLL_TIMEOUT_MS=600000
```

## curl Examples

### Convert a model to GLB

```bash
# Direct conversion (recommended)
curl -X POST http://localhost:3000/api/convert-to-glb \
  -H "Content-Type: application/json" \
  -d '{"urn": "YOUR_URN_HERE", "quality": "balanced"}'
```

### Check manifest

```bash
curl http://localhost:3000/api/manifest/YOUR_URN_HERE
```

### List buckets

```bash
curl http://localhost:3000/api/buckets
```

## Dependencies

### Backend
- Node.js 20+
- Express
- forge-convert-utils (SVF parsing and conversion)
- forge-server-utils (APS API client)
- @gltf-transform/core (GLB optimization)

### Frontend
- Three.js (r128) - Included via CDN with inline GLTFLoader/OrbitControls
- Potree (1.8) - Optional, for point cloud rendering

## License

MIT
