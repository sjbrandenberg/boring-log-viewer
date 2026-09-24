// Builds the static paste page into public/: bundles site/app.js (with the
// renderer and Ajv) and copies the HTML, CSS, icon and JSON Schema.
//   node scripts/build-site.js           one-off build
//   node scripts/build-site.js --serve   rebuild on change and serve on :8080
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import * as esbuild from 'esbuild';

const root = new URL('../', import.meta.url);
const out = new URL('public/', root);
const serve = process.argv.includes('--serve');

function copyStatic() {
    for (const file of ['index.html', 'styles.css', 'favicon.svg']) {
        cpSync(new URL(`site/${file}`, root), new URL(file, out));
    }
    mkdirSync(new URL('schema/', out), { recursive: true });
    cpSync(new URL('schema/boring-log.schema.json', root), new URL('schema/boring-log.schema.json', out));
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyStatic();

const options = {
    entryPoints: [new URL('site/app.js', root).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
    bundle: true,
    format: 'esm',
    target: ['es2022'],
    minify: !serve,
    sourcemap: serve ? 'inline' : false,
    outfile: new URL('app.js', out).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    logLevel: 'info',
    plugins: [{
        name: 'copy-static',
        setup(build) {
            build.onEnd(() => copyStatic());
        },
    }],
};

if (serve) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    const { port } = await ctx.serve({ servedir: new URL('public/', root).pathname.replace(/^\/([A-Za-z]:)/, '$1'), port: 8080 });
    console.log(`serving http://localhost:${port}/`);
} else {
    await esbuild.build(options);
}
