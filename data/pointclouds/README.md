# Point Clouds Directory

Place your Potree-converted point clouds here.

## Directory Structure

```
pointclouds/
├── demo/                    # Example point cloud
│   ├── cloud.js            # Potree metadata file
│   └── data/               # Octree data files
│       ├── r/
│       └── ...
├── project-a/
│   ├── cloud.js
│   └── data/
└── ...
```

## How to Convert Point Clouds

Use [PotreeConverter](https://github.com/potree/PotreeConverter) to convert LAS/LAZ files:

```bash
# Download PotreeConverter from releases
# https://github.com/potree/PotreeConverter/releases

# Convert a LAS file
PotreeConverter.exe input.las -o output_folder

# Convert with specific settings
PotreeConverter.exe input.las -o output_folder --generate-page index
```

## Supported Input Formats

- LAS (1.0 - 1.4)
- LAZ (compressed LAS)
- XYZ (ASCII point cloud)
- PLY
- PTS

## Adding a Point Cloud

1. Convert your point cloud using PotreeConverter
2. Copy the output folder to `data/pointclouds/<name>/`
3. Ensure the folder contains `cloud.js` (or `metadata.json` for newer versions)
4. Access via URL parameter:
   ```
   /viewer?urn=...&run=...&cloud=/pointclouds/<name>/cloud.js
   ```

## Example URL

```
http://localhost:3000/viewer?urn=dXJuOmFkc2...&run=abc123&cloud=/pointclouds/demo/cloud.js
```

## No Point Cloud?

The viewer will still work without a point cloud. You'll see:
- Grid helper
- BIM model (GLB)
- Alignment controls

This is useful for testing BIM model loading and conversion.

## Tips

- For large point clouds, consider using `--generate-page index` for preview
- Adjust point budget in the viewer UI for performance vs quality
- Point clouds are in meters by default; ensure your BIM model matches
