/**
 * Setup script for bundling QMD (semantic codebase search) with Build
 *
 * This script downloads Bun runtime and installs QMD into the app's resources.
 * Run during build: npx ts-node scripts/setup-qmd.ts
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import * as https from 'https';
import * as os from 'os';
import { execSync, spawn } from 'child_process';

const QMD_DIR = path.join(__dirname, '..', 'resources', 'qmd');
const BUN_VERSION = '1.1.38'; // Stable version

interface PlatformConfig {
  bunUrl: string;
  bunBinary: string;
  platform: string;
  arch: string;
}

const PLATFORMS: Record<string, PlatformConfig> = {
  'darwin-arm64': {
    bunUrl: `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-darwin-aarch64.zip`,
    bunBinary: 'bun',
    platform: 'darwin',
    arch: 'arm64',
  },
  'darwin-x64': {
    bunUrl: `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-darwin-x64.zip`,
    bunBinary: 'bun',
    platform: 'darwin',
    arch: 'x64',
  },
  'linux-x64': {
    bunUrl: `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip`,
    bunBinary: 'bun',
    platform: 'linux',
    arch: 'x64',
  },
  'win32-x64': {
    bunUrl: `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-windows-x64.zip`,
    bunBinary: 'bun.exe',
    platform: 'win32',
    arch: 'x64',
  },
};

async function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`Downloading: ${url}`);
    const file = fs.createWriteStream(dest);

    const request = (url: string) => {
      https.get(url, (response) => {
        // Handle redirects
        if (response.statusCode === 302 || response.statusCode === 301) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            request(redirectUrl);
            return;
          }
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: ${response.statusCode}`));
          return;
        }

        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', (err) => {
      fs.unlink(dest, () => undefined);
        reject(err);
      });
    };

    request(url);
  });
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  console.log(`Extracting: ${zipPath} to ${destDir}`);
  await fs.ensureDir(destDir);

  if (process.platform === 'win32') {
    execSync(`powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`, { stdio: 'inherit' });
  } else {
    execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: 'inherit' });
  }
}

async function setupBun(platformKey: string): Promise<string> {
  const config = PLATFORMS[platformKey];
  if (!config) {
    throw new Error(`Unsupported platform: ${platformKey}`);
  }

  const platformDir = path.join(QMD_DIR, platformKey);
  const bunDir = path.join(platformDir, 'bun');
  const bunBinaryPath = path.join(bunDir, config.bunBinary);

  // Check if already set up
  if (fs.existsSync(bunBinaryPath)) {
    console.log(`Bun already exists for ${platformKey}`);
    return bunBinaryPath;
  }

  await fs.ensureDir(platformDir);

  // Download Bun
  const zipPath = path.join(platformDir, 'bun.zip');
  await downloadFile(config.bunUrl, zipPath);

  // Extract
  await extractZip(zipPath, platformDir);

  // Move extracted files (Bun extracts to a subdirectory)
  const extractedDirs = fs.readdirSync(platformDir).filter(f => f.startsWith('bun-'));
  if (extractedDirs.length > 0) {
    const extractedDir = path.join(platformDir, extractedDirs[0]);
    await fs.move(extractedDir, bunDir, { overwrite: true });
  }

  // Cleanup zip
  await fs.remove(zipPath);

  // Make executable on Unix
  if (config.platform !== 'win32') {
    execSync(`chmod +x "${bunBinaryPath}"`);
  }

  console.log(`Bun installed for ${platformKey} at ${bunBinaryPath}`);
  return bunBinaryPath;
}

async function installQmd(bunPath: string, platformKey: string): Promise<void> {
  const platformDir = path.join(QMD_DIR, platformKey);
  const qmdDir = path.join(platformDir, 'qmd-package');
  const qmdBin = path.join(qmdDir, 'node_modules', '.bin', 'qmd');

  // Check if already installed
  if (fs.existsSync(qmdBin) || fs.existsSync(qmdBin + '.exe')) {
    console.log(`QMD already installed for ${platformKey}`);
    return;
  }

  await fs.ensureDir(qmdDir);

  // Create a minimal package.json
  await fs.writeJson(path.join(qmdDir, 'package.json'), {
    name: 'qmd-bundle',
    private: true,
    dependencies: {},
  });

  console.log(`Installing QMD using Bun for ${platformKey}...`);

  // Install QMD from GitHub
  const installProcess = spawn(bunPath, ['add', 'https://github.com/tobi/qmd'], {
    cwd: qmdDir,
    stdio: 'inherit',
    env: { ...process.env, BUN_INSTALL_CACHE_DIR: path.join(platformDir, '.bun-cache') },
  });

  await new Promise<void>((resolve, reject) => {
    installProcess.on('close', (code) => {
      if (code === 0) {
        console.log(`QMD installed for ${platformKey}`);
        resolve();
      } else {
        reject(new Error(`QMD installation failed with code ${code}`));
      }
    });
    installProcess.on('error', reject);
  });
}

async function setupPlatform(platformKey: string): Promise<void> {
  console.log(`\n=== Setting up QMD for ${platformKey} ===\n`);

  const bunPath = await setupBun(platformKey);
  await installQmd(bunPath, platformKey);

  // Create a wrapper script that makes it easy to run QMD
  const platformDir = path.join(QMD_DIR, platformKey);
  const config = PLATFORMS[platformKey];

  // QMD's entry point is a shell script that calls bun with src/qmd.ts
  // We need to call the TypeScript source directly with our bundled bun
  // Use --cwd to ensure proper module resolution from QMD's directory

  if (config.platform === 'win32') {
    // Windows batch file - call bun with the TypeScript source
    const wrapperPath = path.join(platformDir, 'qmd.cmd');
    const wrapperContent = `@echo off
set "SCRIPT_DIR=%~dp0"
"%SCRIPT_DIR%bun\\bun.exe" --cwd="%SCRIPT_DIR%qmd-package\\node_modules\\qmd" "src\\qmd.ts" %*
`;
    await fs.writeFile(wrapperPath, wrapperContent);
  } else {
    // Unix shell script - call bun with the TypeScript source
    // Note: In development, module resolution may conflict with parent node_modules.
    // This works correctly in the packaged app where QMD is isolated in Resources.
    const wrapperPath = path.join(platformDir, 'qmd');
    const wrapperContent = `#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
QMD_DIR="$DIR/qmd-package/node_modules/qmd"
"$DIR/bun/bun" --cwd="$QMD_DIR" "src/qmd.ts" "$@"
`;
    await fs.writeFile(wrapperPath, wrapperContent);
    execSync(`chmod +x "${wrapperPath}"`);
  }

  console.log(`QMD wrapper created for ${platformKey}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Default to current platform if no args
  let platforms = args.length > 0 ? args : [`${os.platform()}-${os.arch()}`];

  // Support 'all' to build all platforms
  if (platforms.includes('all')) {
    platforms = Object.keys(PLATFORMS);
  }

  console.log('QMD Setup Script');
  console.log('================');
  console.log(`Platforms: ${platforms.join(', ')}`);
  console.log(`Output: ${QMD_DIR}`);

  await fs.ensureDir(QMD_DIR);

  for (const platform of platforms) {
    if (!PLATFORMS[platform]) {
      console.error(`Unknown platform: ${platform}. Available: ${Object.keys(PLATFORMS).join(', ')}`);
      continue;
    }

    try {
      await setupPlatform(platform);
    } catch (error) {
      console.error(`Failed to setup ${platform}:`, error);
      process.exit(1);
    }
  }

  console.log('\n=== QMD Setup Complete ===\n');
}

main().catch((error) => {
  console.error('Setup failed:', error);
  process.exit(1);
});
