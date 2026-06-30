export function parseComment(body: any): string | null { const comment = body?.comment; return comment?.trim() ? comment.trim() : null; }
