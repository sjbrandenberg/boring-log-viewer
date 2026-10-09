// Builds the static paste page into public/: bundles site/app.js (with the
// renderer, Ajv and Leaflet) and copies the HTML, CSS (with Leaflet's), icon
// and JSON Schema.
//   node scripts/build-site.js           one-off build
//   node scripts/build-site.js --serve   rebuild on change and serve on :8080
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import * as esbuild from 'esbuild';

const root = new URL('../', import.meta.url);
const out = new URL('public/', root);
const serve = process.argv.includes('--serve');

function copyStatic() {
    for (const file of ['index.html', 'styles.css', 'favicon.svg', 'site-page.css']) {
        cpSync(new URL(`site/${file}`, root), new URL(file, out));
    }
    cpSync(new URL('node_modules/leaflet/dist/leaflet.css', root), new URL('leaflet.css', out));
    cpSync(new URL('node_modules/leaflet/dist/images/', root), new URL('images/', out), { recursive: true });
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

// The site page (POST /api/site) has its own script; the API embeds it.
const sitePage = {
    ...options,
    entryPoints: [new URL('site/site-page.js', root).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
    outfile: new URL('site-page.js', out).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    minify: true,
    sourcemap: false,
    plugins: [],
};

if (serve) {
    await esbuild.build(sitePage);
    const ctx = await esbuild.context(options);
    await ctx.watch();
    const { port } = await ctx.serve({ servedir: new URL('public/', root).pathname.replace(/^\/([A-Za-z]:)/, '$1'), port: 8080 });
    console.log(`serving http://localhost:${port}/`);
} else {
    await esbuild.build(options);
    await esbuild.build(sitePage);
}
