import type { MediaAssetResolverPort } from '../../../application/feed/ports.js';
import { InvalidMediaAssetError } from '../../../domain/feed/errors.js';

const DEFAULT_MEDIA_SERVICE_URL = 'http://localhost:4003';

function resolveBaseUrl(): string {
  const value = process.env.MEDIA_SERVICE_URL?.trim();
  if (!value) {
    return DEFAULT_MEDIA_SERVICE_URL;
  }
  return value.replace(/\/$/, '');
}

type MediaAssetResponse = {
  assetId: string;
  ownerId: string;
  status: string;
  key: string;
};

export class HttpMediaAssetResolverAdapter implements MediaAssetResolverPort {
  constructor(private readonly baseUrl = resolveBaseUrl()) {}

  async resolveOwnedReadyAsset(input: {
    assetId: string;
    userId: string;
  }): Promise<{ key: string }> {
    const endpoint = `${this.baseUrl}/assets/${encodeURIComponent(input.assetId)}`;
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      throw new InvalidMediaAssetError('INVALID_MEDIA_ASSET_NOT_FOUND');
    }

    const payload = await response.json() as Partial<MediaAssetResponse>;
    if (!payload.key || !payload.ownerId || !payload.status) {
      throw new InvalidMediaAssetError('INVALID_MEDIA_ASSET_RESPONSE');
    }
    if (payload.ownerId !== input.userId) {
      throw new InvalidMediaAssetError('INVALID_MEDIA_ASSET_OWNER');
    }
    if (payload.status !== 'ready') {
      throw new InvalidMediaAssetError('INVALID_MEDIA_ASSET_NOT_READY');
    }

    return {
      key: payload.key
    };
  }
}
