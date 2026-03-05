import fs from 'fs';
import path from 'path';
import https from 'https';
import { execSync } from 'child_process';

const POTREE_VERSION = '1.8';
const POTREE_URL = `https://github.com/potree/potree/releases/download/${POTREE_VERSION}/Potree_${POTREE_VERSION}.zip`;
const LIB_DIR = path.join(__dirname, '../public/libs/potree');
const ZIP_PATH = path.join(__dirname, '../public/libs/Potree_1.8.zip');
const EXPECTED_DIR = path.join(LIB_DIR, `Potree_${POTREE_VERSION}`);

async function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`Downloading: ${url}`);
    console.log(`To: ${dest}`);
    
    const file = fs.createWriteStream(dest);
    
    const request = (urlToFetch: string) => {
      https.get(urlToFetch, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            console.log(`Following redirect to: ${redirectUrl}`);
            request(redirectUrl);
            return;
          }
        }
        
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        const totalSize = parseInt(response.headers['content-length'] || '0', 10);
        let downloadedSize = 0;

        response.on('data', (chunk) => {
          downloadedSize += chunk.length;
          if (totalSize > 0) {
            const percent = ((downloadedSize / totalSize) * 100).toFixed(1);
            process.stdout.write(`\rProgress: ${percent}% (${(downloadedSize / 1024 / 1024).toFixed(1)} MB)`);
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          console.log('\nDownload complete!');
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    };
    
    request(url);
  });
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  console.log(`Extracting to: ${destDir}`);
  
  const isWindows = process.platform === 'win32';
  
  if (isWindows) {
    execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`, {
      stdio: 'inherit'
    });
  } else {
    execSync(`unzip -o "${zipPath}" -d "${destDir}"`, {
      stdio: 'inherit'
    });
  }
  
  console.log('Extraction complete!');
}

async function main() {
  console.log('=== Potree Setup ===\n');
  
  if (fs.existsSync(EXPECTED_DIR)) {
    console.log(`✓ Potree ${POTREE_VERSION} already installed at:`);
    console.log(`  ${EXPECTED_DIR}`);
    console.log('\nTo reinstall, delete the folder and run this script again.');
    return;
  }
  
  fs.mkdirSync(LIB_DIR, { recursive: true });
  
  try {
    await downloadFile(POTREE_URL, ZIP_PATH);
    
    await extractZip(ZIP_PATH, LIB_DIR);
    
    if (fs.existsSync(ZIP_PATH)) {
      fs.unlinkSync(ZIP_PATH);
      console.log('Cleaned up zip file.');
    }
    
    if (fs.existsSync(EXPECTED_DIR)) {
      console.log(`\n✓ Potree ${POTREE_VERSION} installed successfully!`);
      console.log(`  Location: ${EXPECTED_DIR}`);
    } else {
      throw new Error('Installation directory not found after extraction');
    }
    
  } catch (error) {
    console.error('\n✗ Setup failed:', error);
    console.error('\nManual installation:');
    console.error(`1. Download: ${POTREE_URL}`);
    console.error(`2. Extract to: ${LIB_DIR}`);
    process.exit(1);
  }
}

main();
