# Raw Point Clouds Directory

Place your raw point cloud files here for automatic conversion to Potree format.

## Supported Formats

- `.las` - ASPRS LAS format
- `.laz` - Compressed LAS format
- `.e57` - ASTM E57 format
- `.ply` - PLY format
- `.xyz` - XYZ format
- `.pts` - PTS format

## How It Works

1. Place your file here, e.g., `site_survey.las`
2. Open the viewer at http://localhost:3000/viewer
3. Select your file from the Point Cloud dropdown (marked with `⚙ [RAW]`)
4. Click "Load Selected"
5. The system will convert the file to Potree format using PotreeConverter
6. Converted files are cached for future use

## Prerequisites

You need **PotreeConverter** installed:

### Windows
1. Download from https://github.com/potree/PotreeConverter/releases
2. Extract to a folder (e.g., `C:\Tools\PotreeConverter`)
3. Either:
   - Add the folder to your system PATH, or
   - Set `POTREE_CONVERTER_PATH=C:\Tools\PotreeConverter\PotreeConverter.exe` in `.env`

### Linux/Mac
```bash
git clone https://github.com/potree/PotreeConverter.git
cd PotreeConverter && mkdir build && cd build
cmake .. && make
# Add to PATH or set POTREE_CONVERTER_PATH
```

## Cache Location

Converted point clouds are stored in:
- `data/pointclouds/<cloudId>/` - Potree format files
- `data/pointclouds_cache/<cloudId>/` - Conversion logs and metadata

The `cloudId` is derived from the filename and a hash of the file content, ensuring that if you update a file, it will be re-converted.
