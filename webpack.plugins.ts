import type IForkTsCheckerWebpackPlugin from 'fork-ts-checker-webpack-plugin';
import webpack from 'webpack';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ForkTsCheckerWebpackPlugin: typeof IForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const MonacoWebpackPlugin = require('monaco-editor-webpack-plugin');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const dotenv = require('dotenv');

// Load embedded API keys from .env.production (gitignored)
const envPath = path.resolve(__dirname, '.env.production');
const envConfig = dotenv.config({ path: envPath });
const env = envConfig.parsed || {};
const skipForkTsChecker = process.env.GREP_SKIP_FORK_TS_CHECKER === '1';

export const plugins = [
  ...(!skipForkTsChecker
    ? [
        new ForkTsCheckerWebpackPlugin({
          logger: 'webpack-infrastructure',
        }),
      ]
    : []),
  new MonacoWebpackPlugin({
    languages: ['javascript', 'typescript', 'json', 'html', 'css', 'markdown', 'python', 'yaml', 'shell'],
    features: ['coreCommands', 'find'],
  }),
  // Inject embedded API keys at build time for voice + auto-routing features
  new webpack.DefinePlugin({
    'process.env.EMBEDDED_OPENAI_API_KEY': JSON.stringify(''),
    'process.env.EMBEDDED_CEREBRAS_API_KEY': JSON.stringify(''),
  }),
];
