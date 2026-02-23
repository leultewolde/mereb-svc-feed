import { signMediaUrl } from '@mereb/shared-packages';
import type { MediaUrlSignerPort } from '../../../application/feed/ports.js';

export class SharedMediaUrlSignerAdapter implements MediaUrlSignerPort {
  signMediaUrl(key: string): string {
    return signMediaUrl(key);
  }
}

