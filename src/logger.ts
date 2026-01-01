import {createLogger, type Logger} from '@mereb/shared-packages';

export const logger: Logger = createLogger('svc-feed');

export function createChildLogger(bindings: Record<string, unknown>): Logger {
    return logger.child(bindings);
}
