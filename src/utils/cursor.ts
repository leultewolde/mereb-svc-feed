export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const decoded = Buffer.from(cursor, 'base64').toString('utf8');
  const [ts, id] = decoded.split('|');
  return { createdAt: new Date(ts), id };
}
