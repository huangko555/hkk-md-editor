const { build } = require("esbuild");
const { resolve } = require("path");
const { existsSync } = require("fs");
const { copy } = require("esbuild-plugin-copy");

const isProd = process.argv.indexOf('--mode=production') >= 0;

// 这些依赖体积大或包含原生模块,不参与 bundle,运行时从 node_modules 加载
const dependencies = [
    'vscode-html-to-docx', 'highlight.js', 'pdf-lib', 'cheerio', 'katex', 'mustache',
    'puppeteer-core', 'mermaid', 'chrome-finder', 'markdown-it',
    'markdown-it-checkbox', 'markdown-it-plantuml', 'markdown-it-toc-done-right',
    'markdown-it-anchor',
];

const aliasPlugin = {
    name: 'alias',
    setup(b) {
        b.onResolve({ filter: /^@\// }, (args) => {
            const basePath = resolve('./src', args.path.slice(2));
            for (const path of [basePath, `${basePath}.ts`, `${basePath}.js`]) {
                if (existsSync(path)) return { path };
            }
            return { path: basePath };
        });
    }
};

function main() {
    build({
        entryPoints: ['./src/extension.ts'],
        bundle: true,
        outfile: "out/extension.js",
        external: ['vscode', ...dependencies],
        format: 'cjs',
        platform: 'node',
        metafile: true,
        minify: isProd,
        watch: !isProd,
        sourcemap: !isProd,
        logOverride: {
            'duplicate-object-key': "silent",
            'suspicious-boolean-not': "silent",
        },
        plugins: [
            aliasPlugin,
            // 复制 markdown-pdf 导出用的模板
            ...(isProd ? [copy({
                resolveFrom: 'out',
                assets: {
                    from: ['./template/**/*'],
                    to: ['./'],
                    keepStructure: true
                },
            })] : []),
            {
                name: 'build notice',
                setup(b) {
                    b.onStart(() => console.log('build start'));
                    b.onEnd(() => console.log('build success'));
                }
            },
        ],
    });
}

function createLib() {
    const points = dependencies.reduce((point, dependency) => {
        const pkgPath = resolve(`./node_modules/${dependency}/package.json`);
        if (!existsSync(pkgPath)) {
            console.warn(`[skip] node_modules/${dependency} 不存在,跳过(请确认 npm install 已装上)`);
            return point;
        }
        const main = require(pkgPath).main ?? "index.js";
        const mainAbsPath = resolve(`./node_modules/${dependency}`, main);
        if (existsSync(mainAbsPath)) {
            point[dependency] = mainAbsPath;
        }
        return point;
    }, {});
    build({
        entryPoints: points,
        bundle: true,
        outdir: "out/node_modules",
        format: 'cjs',
        platform: 'node',
        minify: true,
        treeShaking: true,
        metafile: true
    });
}

if (isProd) createLib();
main();
