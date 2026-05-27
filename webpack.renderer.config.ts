import type { Configuration } from 'webpack';

import { rendererRules } from './webpack.rules';
import { plugins } from './webpack.plugins';

// CSS rules are defined in webpack.rules.ts with proper PostCSS/Tailwind support

export const rendererConfig: Configuration = {
  module: {
    rules: rendererRules,
  },
  plugins,
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css'],
  },
};
