// Win32 version resource (.res) for the guest stub. The guest compiler links this
// file. Tests on the Mac parse the bytes. No rc.exe and no Windows process.
const FIELD_ORDER = ['originalFilename', 'productName', 'companyName', 'fileDescription'];
const RESOURCE_KEYS = {
  originalFilename: 'OriginalFilename', productName: 'ProductName',
  companyName: 'CompanyName', fileDescription: 'FileDescription',
};
const KEY_FIELDS = Object.fromEntries(Object.entries(RESOURCE_KEYS).map(([field, key]) => [key, field]));
const fail = code => { throw Object.assign(Error(code), { code }); };

export function versionFields(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('VERSION_RESOURCE_INVALID');
  const fields = {};
  for (const key of FIELD_ORDER) {
    const text = value[key];
    if (typeof text !== 'string' || text.length < 1 || text.length > 200 || /[\u0000-\u001f]/.test(text)) fail('VERSION_RESOURCE_INVALID');
    fields[key] = text;
  }
  return fields;
}

function word(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}
function dword(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0);
  return bytes;
}
function utf16z(text) { return Buffer.from(text + '\0', 'utf16le'); }
function pad(bytes) {
  const extra = (4 - (bytes.length % 4)) % 4;
  return extra ? Buffer.concat([bytes, Buffer.alloc(extra)]) : bytes;
}
function finish(bytes) {
  // wLength covers the structure and not the padding that aligns the next one.
  const aligned = pad(bytes);
  aligned.writeUInt16LE(bytes.length, 0);
  return aligned;
}
function textBlock(key, valueWords, children) {
  let bytes = Buffer.concat([word(0), word(valueWords), word(1), utf16z(key)]);
  bytes = pad(bytes);
  if (children) bytes = Buffer.concat([bytes, children]);
  return finish(bytes);
}
function stringEntry(key, value) {
  const encoded = utf16z(value);
  return textBlock(key, encoded.length / 2, encoded);
}
function fixedInfo() {
  const bytes = Buffer.alloc(52);
  bytes.writeUInt32LE(0xFEEF04BD, 0);
  bytes.writeUInt32LE(0x00010000, 4);
  bytes.writeUInt32LE(0x00010000, 8);
  bytes.writeUInt32LE(0x00010000, 16);
  bytes.writeUInt32LE(0x3F, 24);
  bytes.writeUInt32LE(0x00040004, 32);
  bytes.writeUInt32LE(1, 36);
  return bytes;
}
function versionInfo(fields) {
  const strings = Buffer.concat([
    ...FIELD_ORDER.map(key => stringEntry(RESOURCE_KEYS[key], fields[key])),
    // FileVersionInfo leaves the other strings empty unless these two exist.
    stringEntry('FileVersion', '1.0.0.0'),
    stringEntry('ProductVersion', '1.0.0.0'),
  ]);
  const table = textBlock('040904b0', 0, strings);
  const info = textBlock('StringFileInfo', 0, table);
  const translation = Buffer.from([0x09, 0x04, 0xB0, 0x04]);
  let variable = Buffer.concat([word(0), word(translation.length), word(0), utf16z('Translation')]);
  variable = pad(variable);
  variable = finish(Buffer.concat([variable, translation]));
  const variables = textBlock('VarFileInfo', 0, variable);
  const fixed = fixedInfo();
  let root = Buffer.concat([word(0), word(fixed.length), word(0), utf16z('VS_VERSION_INFO')]);
  root = pad(root);
  return finish(Buffer.concat([root, fixed, info, variables]));
}
function resource(typeId, nameId, language, data) {
  let header = Buffer.concat([
    dword(data.length), dword(0), word(0xFFFF), word(typeId), word(0xFFFF), word(nameId),
  ]);
  header = pad(header);
  header = Buffer.concat([header, dword(0), word(0x0030), word(language), dword(0), dword(0)]);
  header.writeUInt32LE(header.length, 4);
  return Buffer.concat([header, pad(data)]);
}

export function versionResource(value) {
  const fields = versionFields(value);
  const prefix = Buffer.alloc(32);
  prefix.writeUInt32LE(0x20, 4);
  prefix.writeUInt16LE(0xFFFF, 8);
  prefix.writeUInt16LE(0xFFFF, 12);
  return Buffer.concat([prefix, resource(16, 1, 0x0409, versionInfo(fields))]);
}

function readUtf16z(bytes, offset) {
  let end = offset;
  while (end + 1 < bytes.length) {
    if (bytes.readUInt16LE(end) === 0) return { text: bytes.toString('utf16le', offset, end), next: end + 2 };
    end += 2;
  }
  fail('VERSION_RESOURCE_INVALID');
}
function align(offset) { return (offset + 3) & ~3; }
function walk(bytes, offset, end, into) {
  if (offset + 6 > end) return;
  const length = bytes.readUInt16LE(offset);
  const valueLength = bytes.readUInt16LE(offset + 2);
  const type = bytes.readUInt16LE(offset + 4);
  if (length < 6 || offset + length > end) fail('VERSION_RESOURCE_INVALID');
  const key = readUtf16z(bytes, offset + 6);
  let cursor = align(key.next);
  if (valueLength) {
    const size = type === 1 ? valueLength * 2 : valueLength;
    if (type === 1 && KEY_FIELDS[key.text]) into[KEY_FIELDS[key.text]] = bytes.toString('utf16le', cursor, cursor + size).replace(/\0+$/, '');
    cursor = align(cursor + size);
  }
  const childEnd = offset + length;
  while (cursor + 6 <= childEnd) {
    const child = bytes.readUInt16LE(cursor);
    if (child < 6 || cursor + child > childEnd) break;
    walk(bytes, cursor, childEnd, into);
    cursor = align(cursor + child);
  }
}

export function readVersionStrings(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 64 || bytes.readUInt32LE(0) !== 0 || bytes.readUInt32LE(4) !== 0x20) fail('VERSION_RESOURCE_INVALID');
  const dataSize = bytes.readUInt32LE(32);
  const headerSize = bytes.readUInt32LE(36);
  if (headerSize < 32 || 32 + headerSize + dataSize > bytes.length) fail('VERSION_RESOURCE_INVALID');
  const into = {};
  walk(bytes.subarray(32 + headerSize, 32 + headerSize + dataSize), 0, dataSize, into);
  return versionFields(into);
}

export function assertVersionCopied(expected, actual) {
  const want = versionFields(expected), got = versionFields(actual);
  for (const key of FIELD_ORDER) if (want[key] !== got[key]) fail('STUB_METADATA_MISMATCH');
  return want;
}
