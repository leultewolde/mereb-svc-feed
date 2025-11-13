import { buildServer } from './server.js';
import { getNumberEnv, loadEnv } from '@mereb/shared-packages';

loadEnv();

const PORT = getNumberEnv('PORT', 4002);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = await buildServer();
await app.listen({ port: PORT, host: HOST });
