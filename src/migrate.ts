import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createChildLogger} from './logger.js';

const logger = createChildLogger({module: 'migrate'});
const execFileAsync = promisify(execFile);

/**
 * Run database migrations using Prisma before starting the service.
 * This keeps staging/production schemas in sync with the code.
 */
export async function runMigrations() {
    const prismaCli = path.join(process.cwd(), 'node_modules', '.bin', 'prisma');

    logger.info('Running prisma migrate deploy');

    try {
        const {stdout, stderr} = await execFileAsync(prismaCli, ['migrate', 'deploy'], {
            env: process.env
        });

        if (stdout?.trim()) {
            logger.info({stdout}, 'Prisma migrate output');
        }
        if (stderr?.trim()) {
            logger.warn({stderr}, 'Prisma migrate warnings');
        }

        logger.info('Prisma migrations applied');
    } catch (err) {
        logger.error({err}, 'Failed to run prisma migrate deploy');
        throw err;
    }
}
