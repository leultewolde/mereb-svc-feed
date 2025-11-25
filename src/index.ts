import { buildServer } from './server.js';
import { getNumberEnv, loadEnv } from '@mereb/shared-packages';
import { runMigrations } from './migrate.js';

loadEnv();

const PORT = getNumberEnv('PORT', 4002);
const HOST = process.env.HOST ?? '0.0.0.0';

try {
    await runMigrations();

    const app = await buildServer();
    await app.listen({ port: PORT, host: HOST });
    console.log(`Server listening on ${HOST}:${PORT}`);
} catch (err) {
    console.error('Failed to start server', err);
    process.exit(1);
}
