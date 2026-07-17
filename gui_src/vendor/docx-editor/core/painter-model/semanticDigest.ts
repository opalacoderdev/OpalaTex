/**
 * Deterministic digest for painter inputs.
 *
 * PageLayout geometry alone is not a content version: equal-length text edits,
 * marks, comments, revisions, and image source changes can all preserve every
 * fragment coordinate. This digest gives the virtualization reconciler a
 * compact semantic version without retaining a second serialized block tree.
 */
export function semanticDigest(...values: unknown[]): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  let length = 0;
  const seen = new WeakMap<object, number>();
  let nextObjectId = 0;

  const write = (value: string): void => {
    length += value.length;
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      first = Math.imul(first ^ code, 0x01000193);
      second = Math.imul(second ^ code, 0x85ebca6b);
      second ^= second >>> 13;
    }
  };

  const visit = (value: unknown): void => {
    if (value === null) {
      write('null;');
      return;
    }

    switch (typeof value) {
      case 'undefined':
        write('undefined;');
        return;
      case 'boolean':
        write(value ? 'true;' : 'false;');
        return;
      case 'number':
        write(`number:${Object.is(value, -0) ? '-0' : String(value)};`);
        return;
      case 'bigint':
        write(`bigint:${String(value)};`);
        return;
      case 'string':
        write(`string:${value.length}:${value};`);
        return;
      case 'symbol':
        write(`symbol:${String(value.description)};`);
        return;
      case 'function':
        write(`function:${value.name};`);
        return;
    }

    const object = value as object;
    const prior = seen.get(object);
    if (prior !== undefined) {
      write(`ref:${prior};`);
      return;
    }
    seen.set(object, nextObjectId++);

    if (Array.isArray(value)) {
      write(`array:${value.length}[`);
      for (const item of value) visit(item);
      write('];');
      return;
    }

    if (value instanceof Date) {
      write(`date:${value.toISOString()};`);
      return;
    }

    if (value instanceof Map) {
      const entries = Array.from(value.entries()).map(([key, entryValue]) => ({
        key,
        entryValue,
        order: semanticDigest(key),
      }));
      entries.sort((a, b) => a.order.localeCompare(b.order));
      write(`map:${entries.length}{`);
      for (const entry of entries) {
        visit(entry.key);
        visit(entry.entryValue);
      }
      write('};');
      return;
    }

    if (value instanceof Set) {
      const entries = Array.from(value.values()).map((entry) => ({
        entry,
        order: semanticDigest(entry),
      }));
      entries.sort((a, b) => a.order.localeCompare(b.order));
      write(`set:${entries.length}{`);
      for (const entry of entries) visit(entry.entry);
      write('};');
      return;
    }

    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      write(`view:${value.constructor.name}:${bytes.length}:`);
      for (const byte of bytes) write(String.fromCharCode(byte));
      write(';');
      return;
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    write(`object:${keys.length}{`);
    for (const key of keys) {
      write(`key:${key.length}:${key};`);
      visit(record[key]);
    }
    write('};');
  };

  visit(values);
  return `${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}-${length.toString(36)}`;
}
