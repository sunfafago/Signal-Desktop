// Copyright 2018 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { HTTPError } from './HTTPError.std.js';

export function toLogFormat(error: unknown): string {
  let result = '';

  if (error instanceof HTTPError) {
    result = `HTTPError ${error.code}`;
    if (error.cause !== undefined && error.cause !== null) {
      const c = error.cause;
      result += `\nCaused by: ${c instanceof Error ? c.message : String(c)}`;
      if (c instanceof Error && 'code' in c && typeof (c as NodeJS.ErrnoException).code === 'string') {
        result += ` (code: ${(c as NodeJS.ErrnoException).code})`;
      }
    }
    return result;
  }

  if (error instanceof Error && error.stack) {
    result = error.stack;
  } else if (error && typeof error === 'object' && 'message' in error) {
    result = String(error.message);
  } else {
    result = String(error);
  }

  if (error && typeof error === 'object' && 'cause' in error) {
    result += `\nCaused by: ${String(error.cause)}`;
  }

  return result;
}

export function toLocation(
  source?: string,
  line?: number,
  column?: number
): string {
  if (source == null) {
    return '(@ unknown)';
  }
  if (line != null && column != null) {
    return `(@ ${source}:${line}:${column})`;
  }
  if (line != null) {
    return `(@ ${source}:${line})`;
  }
  return `(@ ${source})`;
}

export class ProfileDecryptError extends Error {}
