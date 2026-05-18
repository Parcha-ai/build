import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import * as os from 'os';
import * as path from 'path';

import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';

// Get version for output directory
const packageJson = require('./package.json');
const version = packageJson.version || '0.0.0';
const offlineElectronZipDir = process.env.GREP_ELECTRON_ZIP_DIR || null;
const offlineElectronCacheRoot = process.env.GREP_ELECTRON_CACHE_ROOT || path.join(os.homedir(), 'Library', 'Caches', 'electron');
const skipElectronChecksums = process.env.GREP_SKIP_ELECTRON_CHECKSUMS === '1';

const config: ForgeConfig = {
  // Output to versioned folder
  outDir: `./out/v${version}`,
  packagerConfig: {
    asar: true,
    name: 'Build',
    executableName: 'build',
    appBundleId: 'com.parcha.build',
    // macOS icon - Build logo (black on purple)
    icon: './assets/build-icon',
    // macOS specific
    darwinDarkModeSupport: true,
    appCategoryType: 'public.app-category.developer-tools',
    // Disable signing during packaging - the postPackage hook copies
    // additional files which would invalidate the signature.
    // For development builds, adhoc signing is sufficient.
    // For distribution, sign manually after postPackage completes.
    osxSign: false as any,
    ...(offlineElectronZipDir ? { electronZipDir: offlineElectronZipDir } : {}),
    ...(skipElectronChecksums ? {
      download: {
        cacheRoot: offlineElectronCacheRoot,
        unsafelyDisableChecksums: true,
      },
    } : {}),
  },
  rebuildConfig: {},
  hooks: {
    postPackage: async (forgeConfig, options) => {
      const fs = require('fs-extra');
      const path = require('path');

      for (const outputPath of options.outputPaths) {
        let resourcesPath;
        if (options.platform === 'darwin') {
          resourcesPath = path.join(outputPath, 'Build.app', 'Contents', 'Resources');
        } else {
          resourcesPath = path.join(outputPath, 'resources');
        }

        // Copy to Resources/node_modules (one level up from app.asar)
        const nodeModulesPath = path.join(resourcesPath, 'node_modules');
        await fs.ensureDir(nodeModulesPath);

        // Recursively resolve and copy a package and all its production dependencies
        const copied = new Set<string>();
        async function copyWithDeps(pkgName: string) {
          if (copied.has(pkgName)) return;
          copied.add(pkgName);

          const sourcePath = pkgName.startsWith('@')
            ? path.join(__dirname, 'node_modules', ...pkgName.split('/'))
            : path.join(__dirname, 'node_modules', pkgName);
          const destPath = pkgName.startsWith('@')
            ? path.join(nodeModulesPath, ...pkgName.split('/'))
            : path.join(nodeModulesPath, pkgName);

          if (!fs.existsSync(sourcePath)) {
            console.log(`[Packaging] Warning: ${pkgName} not found, skipping`);
            return;
          }

          await fs.ensureDir(path.dirname(destPath));
          await fs.copy(sourcePath, destPath);
          console.log(`[Packaging] Copied ${pkgName}`);

          // Recurse into production dependencies
          const pkgJsonPath = path.join(sourcePath, 'package.json');
          if (fs.existsSync(pkgJsonPath)) {
            const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
            for (const dep of Object.keys(pkgJson.dependencies || {})) {
              await copyWithDeps(dep);
            }
          }
        }

        // Externalized packages (must match webpack.main.config.ts externals)
        const externalPackages = [
          'node-pty',
          '@anthropic-ai/claude-agent-sdk',
          '@anthropic-ai/claude-agent-sdk-darwin-arm64',
          '@anthropic-ai/sdk',
          'monaco-editor',
        ];

        for (const pkg of externalPackages) {
          await copyWithDeps(pkg);
        }

        // Copy bundled QMD (semantic codebase search)
        const platformKey = `${options.platform}-${options.arch}`;
        const qmdSourceDir = path.join(__dirname, 'resources', 'qmd', platformKey);
        const qmdDestDir = path.join(resourcesPath, 'qmd');

        if (fs.existsSync(qmdSourceDir)) {
          await fs.copy(qmdSourceDir, qmdDestDir);
          console.log(`[Packaging] Copied QMD for ${platformKey} to ${qmdDestDir}`);
        } else {
          console.log(`[Packaging] Warning: QMD not found for ${platformKey}. Run 'npx ts-node scripts/setup-qmd.ts ${platformKey}' to set up.`);
        }

        // Sign the app with adhoc signature after all modifications
        // This must happen after copying dependencies to ensure valid signature
        if (options.platform === 'darwin') {
          const { execSync } = require('child_process');
          const appPath = path.join(outputPath, 'Build.app');
          console.log(`[Packaging] Signing app with adhoc signature: ${appPath}`);
          try {
            execSync(`codesign --force --sign - "${appPath}"`, { stdio: 'inherit' });
            console.log('[Packaging] App signed successfully');
          } catch (err) {
            console.error('[Packaging] Warning: Failed to sign app:', err);
          }

          // Copy to /Applications
          const applicationsPath = '/Applications/Build.app';
          console.log(`[Packaging] Copying to ${applicationsPath}...`);
          try {
            await fs.remove(applicationsPath);
            await fs.copy(appPath, applicationsPath);
            console.log('[Packaging] Installed to /Applications/Build.app');
          } catch (err) {
            console.error('[Packaging] Warning: Failed to copy to /Applications:', err);
          }
        }
      }
    },
  },
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerDMG({
      format: 'ULFO',
    }),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new WebpackPlugin({
      mainConfig,
      devServer: {
        port: parseInt(process.env.DEV_WEBPACK_PORT || '9000', 10),
        // Filter out Monaco editor disposal errors from the error overlay
        // These are harmless race conditions in @monaco-editor/react
        client: {
          overlay: {
            runtimeErrors: (error: Error) => {
              const suppressPatterns = [
                'TextModel got disposed before DiffEditorWidget model got reset',
                'no diff result available',
                'Diff editor requires a model',
                'Cannot read properties of disposed',
                'DISPOSED',
              ];
              const errorMessage = error?.message || '';
              return !suppressPatterns.some(pattern => errorMessage.includes(pattern));
            },
          },
        },
      },
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: './src/renderer/index.html',
            js: './src/renderer/index.tsx',
            name: 'main_window',
            preload: {
              js: './src/main/preload.ts',
            },
          },
        ],
      },
      // Include externalized dependencies in node_modules
      packageSourceMaps: false,
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      // Disable Chromium safe storage for local packaged builds to avoid repeated
      // macOS Keychain/password prompts on launch.
      [FuseV1Options.EnableCookieEncryption]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
