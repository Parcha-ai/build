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

        // Copy externalized dependencies
        const deps = [
          { name: 'node-pty', source: path.join(__dirname, 'node_modules', 'node-pty') },
          { name: '@anthropic-ai/claude-agent-sdk', source: path.join(__dirname, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'), dest: path.join(nodeModulesPath, '@anthropic-ai', 'claude-agent-sdk') },
          { name: '@anthropic-ai/claude-agent-sdk-darwin-arm64', source: path.join(__dirname, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-darwin-arm64'), dest: path.join(nodeModulesPath, '@anthropic-ai', 'claude-agent-sdk-darwin-arm64') },
          { name: '@anthropic-ai/sdk', source: path.join(__dirname, 'node_modules', '@anthropic-ai', 'sdk'), dest: path.join(nodeModulesPath, '@anthropic-ai', 'sdk') },
          // Codex binaries removed from bundle — triggers macOS XProtect malware block.
          // Codex is spawned at runtime from the system-installed binary instead.
          // @anthropic-ai/sdk runtime dependencies
          { name: 'standardwebhooks', source: path.join(__dirname, 'node_modules', 'standardwebhooks') },
          // Monaco editor assets for code editing
          { name: 'monaco-editor', source: path.join(__dirname, 'node_modules', 'monaco-editor') },
        ];

        for (const dep of deps) {
          const dest = dep.dest || path.join(nodeModulesPath, dep.name);
          await fs.ensureDir(path.dirname(dest));
          await fs.copy(dep.source, dest);
          console.log(`[Packaging] Copied ${dep.name} to ${dest}`);
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
