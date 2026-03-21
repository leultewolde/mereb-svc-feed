export interface DecodedHomeFeedCursorHomeMode {
  mode: 'home';
  rank: bigint;
  insertedAt: Date;
  postId: string;
}

export interface DecodedHomeFeedCursorFallbackMode {
  mode: 'fallback';
  createdAt: Date;
  postId: string;
}

export type DecodedHomeFeedCursor =
  | DecodedHomeFeedCursorHomeMode
  | DecodedHomeFeedCursorFallbackMode;

type EncodedHomeFeedCursor =
  | {
      mode: 'home';
      rank: string;
      insertedAt: string;
      postId: string;
    }
  | {
      mode: 'fallback';
      createdAt: string;
      postId: string;
    };

export function encodeHomeFeedCursor(cursor: DecodedHomeFeedCursor): string {
  const encoded: EncodedHomeFeedCursor =
    cursor.mode === 'home'
      ? {
          mode: 'home',
          rank: cursor.rank.toString(),
          insertedAt: cursor.insertedAt.toISOString(),
          postId: cursor.postId
        }
      : {
          mode: 'fallback',
          createdAt: cursor.createdAt.toISOString(),
          postId: cursor.postId
        };

  return Buffer.from(JSON.stringify(encoded), 'utf8').toString('base64');
}

export function decodeHomeFeedCursor(cursor: string): DecodedHomeFeedCursor | null {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded) as Partial<EncodedHomeFeedCursor>;

    if (parsed.mode === 'home') {
      if (
        typeof parsed.rank !== 'string' ||
        typeof parsed.insertedAt !== 'string' ||
        typeof parsed.postId !== 'string'
      ) {
        return null;
      }

      const insertedAt = new Date(parsed.insertedAt);
      if (Number.isNaN(insertedAt.getTime())) {
        return null;
      }

      return {
        mode: 'home',
        rank: BigInt(parsed.rank),
        insertedAt,
        postId: parsed.postId
      };
    }

    if (parsed.mode === 'fallback') {
      if (typeof parsed.createdAt !== 'string' || typeof parsed.postId !== 'string') {
        return null;
      }

      const createdAt = new Date(parsed.createdAt);
      if (Number.isNaN(createdAt.getTime())) {
        return null;
      }

      return {
        mode: 'fallback',
        createdAt,
        postId: parsed.postId
      };
    }

    return null;
  } catch {
    return null;
  }
}
