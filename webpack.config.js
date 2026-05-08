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
        // Optional native dependency of elkjs/netlistsvg used for
        // multi-threaded layout. Not installed; ELK falls back to a
        // synchronous in-process layout if this require throws.
        'webworker-threads': 'commonjs webworker-threads',
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
            {
                // Inline netlistsvg's skin SVG into the bundle as a
                // string so we don't need to ship node_modules.
                test: /netlistsvg[\\/]lib[\\/].*\.svg$/,
                type: 'asset/source',
            },
        ],
    },
};
module.exports = config;
