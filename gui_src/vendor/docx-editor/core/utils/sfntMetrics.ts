/**
 * Read the Windows single-line metric from a raw OpenType/TrueType sfnt.
 *
 * Word uses (OS/2.usWinAscent + OS/2.usWinDescent) / head.unitsPerEm as the
 * base for automatic line spacing. Embedded DOCX fonts are de-obfuscated
 * before reaching this helper.
 */

const SFNT_HEADER_SIZE = 12;
const TABLE_RECORD_SIZE = 16;
const MAX_TABLES = 256;
const MIN_RATIO = 0.5;
const MAX_RATIO = 3;

type SfntTable = { offset: number; length: number };

function readTag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );
}

function tableFits(bufferLength: number, table: SfntTable, requiredLength: number): boolean {
  return (
    table.length >= requiredLength &&
    table.offset >= 0 &&
    table.offset <= bufferLength - requiredLength
  );
}

/**
 * Return the sfnt's OS/2 Windows ascent/descent ratio, or null for unsupported,
 * malformed, or implausible font data.
 */
export function readSfntSingleLineRatio(buffer: ArrayBuffer): number | null {
  if (buffer.byteLength < SFNT_HEADER_SIZE) return null;

  const view = new DataView(buffer);
  const numTables = view.getUint16(4, false);
  if (numTables === 0 || numTables > MAX_TABLES) return null;

  const directoryEnd = SFNT_HEADER_SIZE + numTables * TABLE_RECORD_SIZE;
  if (directoryEnd > buffer.byteLength) return null;

  let head: SfntTable | undefined;
  let os2: SfntTable | undefined;
  for (let index = 0; index < numTables; index++) {
    const recordOffset = SFNT_HEADER_SIZE + index * TABLE_RECORD_SIZE;
    const tag = readTag(view, recordOffset);
    if (tag !== 'head' && tag !== 'OS/2') continue;

    const table = {
      offset: view.getUint32(recordOffset + 8, false),
      length: view.getUint32(recordOffset + 12, false),
    };
    if (tag === 'head') head = table;
    else os2 = table;
  }

  // head.unitsPerEm is at byte 18; OS/2.usWinAscent/Descent are at 74/76.
  if (
    !head ||
    !os2 ||
    !tableFits(buffer.byteLength, head, 20) ||
    !tableFits(buffer.byteLength, os2, 78)
  ) {
    return null;
  }

  const unitsPerEm = view.getUint16(head.offset + 18, false);
  const ascent = view.getUint16(os2.offset + 74, false);
  const descent = view.getUint16(os2.offset + 76, false);
  if (unitsPerEm === 0 || ascent + descent === 0) return null;

  const ratio = (ascent + descent) / unitsPerEm;
  return Number.isFinite(ratio) && ratio >= MIN_RATIO && ratio <= MAX_RATIO ? ratio : null;
}
