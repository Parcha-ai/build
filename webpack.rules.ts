import type { ModuleOptions } from 'webpack';

const nativeModuleRules: Required<ModuleOptions>['rules'] = [
  // Add support for native node modules
  {
    // We're specifying native_modules in the test because the asset relocator loader generates a
    // "fake" .node file which is really a cjs file.
    test: /native_modules[/\\].+\.node$/,
    use: 'node-loader',
  },
  {
    test: /[/\\]node_modules[/\\].+\.(m?js|node)$/,
    // Exclude packages with native modules from asset relocator
    exclude: /node_modules[/\\](node-pty|@anthropic-ai)/,
    parser: { amd: false },
    use: {
      loader: '@vercel/webpack-asset-relocator-loader',
      options: {
        outputAssetBase: 'native_modules',
      },
    },
  },
];

const appRules: Required<ModuleOptions>['rules'] = [
  {
    test: /\.tsx?$/,
    exclude: /(node_modules|\.webpack)/,
    use: {
      loader: 'ts-loader',
      options: {
        transpileOnly: true,
      },
    },
  },
  // CSS from node_modules (xterm, etc.) - no PostCSS processing
  {
    test: /\.css$/,
    include: /node_modules/,
    use: ['style-loader', 'css-loader'],
  },
  // CSS with PostCSS for Tailwind (our source files only)
  {
    test: /\.css$/,
    exclude: /node_modules/,
    use: [
      'style-loader',
      'css-loader',
      {
        loader: 'postcss-loader',
        options: {
          postcssOptions: {
            plugins: [
              require('tailwindcss'),
              require('autoprefixer'),
            ],
          },
        },
      },
    ],
  },
  // WASM files (for Claude Agent SDK)
  {
    test: /\.wasm$/,
    type: 'asset/resource',
  },
  // Asset handling
  {
    test: /\.(png|svg|jpg|jpeg|gif|ico)$/i,
    type: 'asset/resource',
  },
  {
    test: /\.(woff|woff2|eot|ttf|otf)$/i,
    type: 'asset/resource',
  },
];

export const rules: Required<ModuleOptions>['rules'] = [
  ...nativeModuleRules,
  ...appRules,
];

export const rendererRules: Required<ModuleOptions>['rules'] = appRules;
