export interface FeedMediaRecord {
  type: string;
  url?: string;
  key?: string;
}

export interface FeedMediaView {
  type: string;
  url: string;
}

export interface StoredPostMediaPayload {
  type: string;
  key: string;
}

export function mediaTypeFromKey(key: string): string {
  return key.endsWith('.mp4') ? 'video' : 'image';
}

export function buildStoredPostMediaPayload(mediaKeys: string[] | undefined): StoredPostMediaPayload[] {
  return (mediaKeys ?? []).map((key) => ({
    type: mediaTypeFromKey(key),
    key
  }));
}

export function normalizeCreatedAt(input: unknown): string {
  if (input instanceof Date) {
    return input.toISOString();
  }
  if (typeof input === 'number') {
    return new Date(input).toISOString();
  }
  if (typeof input === 'string') {
    const asNumber = Number(input);
    if (!Number.isNaN(asNumber)) {
      return new Date(asNumber).toISOString();
    }
    const parsed = new Date(input);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  const fallback = new Date(input as string);
  if (!Number.isNaN(fallback.getTime())) {
    return fallback.toISOString();
  }
  return new Date().toISOString();
}

