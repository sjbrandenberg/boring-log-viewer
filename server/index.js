// Starts the render API. Listens on localhost only; Apache forwards
// /boring-log-viewer/api/ to it.
//   PORT (default 3000), HOST (default 127.0.0.1), RATE_LIMIT (requests/minute per client, default 60)
import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const rateLimitMax = Number(process.env.RATE_LIMIT ?? 60);

const app = await buildApp({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, rateLimitMax });

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
        await app.close();
        process.exit(0);
    });
}

try {
    await app.listen({ port, host });
} catch (err) {
    app.log.error(err);
    process.exit(1);
}
