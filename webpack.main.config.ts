import type { Configuration } from 'webpack';

import { rules } from './webpack.rules';
import { plugins } from './webpack.plugins';

export const mainConfig: Configuration = {
  /**
   * This is the main entry point for your application, it's the first file
   * that runs in the main process.
   */
  entry: './src/main/index.ts',
  // Put your normal webpack config below here
  module: {
    rules,
  },
  plugins,
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
  },
  // Externalize packages with native modules like pheuter/claude-agent-desktop
  externals: {
    'node-pty': 'commonjs node-pty',
    '@anthropic-ai/claude-agent-sdk': 'commonjs @anthropic-ai/claude-agent-sdk',
    '@anthropic-ai/sdk': 'commonjs @anthropic-ai/sdk',
    // codex-sdk no longer imported — we spawn the codex binary directly
    // Keep the external to prevent webpack from trying to bundle the ESM package if any stray type imports remain
    '@openai/codex-sdk': 'commonjs @openai/codex-sdk',
  },
};
