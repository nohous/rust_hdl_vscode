//@ts-check

'use strict';

const path = require('path');

/**@type {import('webpack').Configuration}*/
const config = {
    target: 'node', // vscode extensions run in a Node.js-context 📖 -> https://webpack.js.org/configuration/node/
    entry: './client/src/extension.ts', // the entry point of this extension, 📖 -> https://webpack.js.org/configuration/entry-context/
    output: {
        // the bundle is stored in the 'dist' folder (check package.json), 📖 -> https://webpack.js.org/configuration/output/
        path: path.resolve(__dirname, 'dist'),
        filename: 'extension.js',
        libraryTarget: 'commonjs2',
        devtoolModuleFilenameTemplate: '../[resource-path]',
    },
    devtool: 'source-map',
    externals: {
        vscode: 'commonjs vscode', // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
    },
    resolve: {
        alias: {
            'universal-user-agent': path.resolve(
                __dirname,
                'client/node_modules/universal-user-agent/dist-node/index.js'
            ),
        },
        // support reading TypeScript and JavaScript files, 📖 -> https://github.com/TypeStrong/ts-loader
        extensions: ['.ts', '.js'],
    },
    optimization: {
        minimize: false
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: [
                    {
                        loader: 'ts-loader',
                        options: {
                            compilerOptions: {
                                sourceMap: true,
                            },
                        },
                    },
                ],
            },
        ],
    },
};

/** Data-flow schematic webview script: browser target, ELK runs in-page. */
/**@type {import('webpack').Configuration}*/
const dataflowView = {
    target: 'web',
    entry: './client/webview/main.ts',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'dataflowView.js',
    },
    devtool: 'source-map',
    resolve: {
        extensions: ['.ts', '.js'],
        modules: [path.resolve(__dirname, 'client/node_modules'), 'node_modules'],
        // elk.bundled.js probes for this optional worker shim; the in-page
        // fallback is used instead.
        fallback: { 'web-worker': false },
    },
    optimization: {
        minimize: false,
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: [
                    {
                        loader: 'ts-loader',
                        options: {
                            configFile: path.resolve(__dirname, 'client/webview/tsconfig.json'),
                        },
                    },
                ],
            },
        ],
    },
};

module.exports = [config, dataflowView];
