// The git object model, implemented from scratch on node:crypto / node:zlib:
// blob/tree/commit/tag objects addressed by SHA-1, packfile read (with OFS/REF
// delta resolution) and packfile write (plain objects, no deltas), tree
// flattening/diffing and the ancestry walks the forge's surfaces share.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export type ObjectStore = Map<string, GitObject>;

export const ZERO_OID = '0000000000000000000000000000000000000000';

const OID_RE = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return OID_RE.test(value);
}

/** SHA-1 of `<type> <length>\0<data>`, the git object id. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object and answer its id. */
export function putObject(store: ObjectStore, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order of the name, directories compared with a trailing '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree (recursively) into a map of file path -> {mode, oid}. */
export function flattenTree(store: ObjectStore, treeOid: string): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = store.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build (and store) nested trees from a flattened path map; answers the root tree id. */
export function buildTreeFromMap(store: ObjectStore, files: ReadonlyMap<string, { mode: string; oid: string }>): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(store, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The empty tree's id (it is the same in every repository). */
export const EMPTY_TREE_OID = hashObject('tree', Buffer.alloc(0));

// ---------------------------------------------------------------- commits and tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  /** Committer timestamp in seconds, 0 when unparsable. */
  time: number;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  const stamp = / (\d+) [+-]\d{4}$/.exec(committer);
  return { tree, parents, author, committer, message, time: stamp === null ? 0 : Number(stamp[1]) };
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return { object: headers.get('object') ?? '', type: headers.get('type') ?? '', tag: headers.get('tag') ?? '' };
}

/** Build a commit object's bytes with an explicit identity line (name <email> ts tz). */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  authorLine: string;
  committerLine: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.authorLine}`, `committer ${fields.committerLine}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Follow tag objects until a non-tag object; null when the chain is broken. */
export function peelTag(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 32; hops += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type !== 'tag') return current;
    current = parseTag(object.data).object;
    if (!isOid(current)) return null;
  }
  return null;
}

/** The commit an object names (through tags), or null. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  const peeled = peelTag(store, oid);
  if (peeled === null) return null;
  return store.get(peeled)?.type === 'commit' ? peeled : null;
}

// ---------------------------------------------------------------- reachability

export interface ReachOptions {
  /** Commits in this set are included with their trees, but their parents are not followed. */
  cutCommits?: ReadonlySet<string>;
  /** Missing objects are skipped instead of throwing. */
  allowMissing?: boolean;
}

/** Every object reachable from `roots` (commit -> tree + parents, tree -> entries, tag -> target). */
export function collectReachable(store: ObjectStore, roots: Iterable<string>, options: ReachOptions = {}): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) {
      if (options.allowMissing === true) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (options.cutCommits === undefined || !options.cutCommits.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` through commit parents (both peeled to commits). */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  const target = peelToCommit(store, ancestor);
  const start = peelToCommit(store, descendant);
  if (target === null || start === null) return false;
  if (target === start) return true;
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === target) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The nearest common ancestor of two commits, or null. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const startA = peelToCommit(store, a);
  const startB = peelToCommit(store, b);
  if (startA === null || startB === null) return null;
  const ancestorsOfA = new Set<string>();
  const queueA = [startA];
  while (queueA.length > 0) {
    const oid = queueA.pop()!;
    if (ancestorsOfA.has(oid)) continue;
    ancestorsOfA.add(oid);
    const object = store.get(oid);
    if (object !== undefined && object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queueA.push(parent);
    }
  }
  const seenB = new Set<string>();
  const queueB = [startB];
  while (queueB.length > 0) {
    const oid = queueB.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = store.get(oid);
    if (object !== undefined && object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queueB.push(parent);
    }
  }
  return null;
}

// ---------------------------------------------------------------- tree diffs and merges

export type FlatTree = Map<string, { mode: string; oid: string }>;

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
}

/** The path-level difference between two flattened trees. */
export function diffMaps(base: FlatTree, head: FlatTree): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before === undefined && after !== undefined) changes.push({ path, status: 'added', oldOid: null, newOid: after.oid });
    else if (before !== undefined && after === undefined) changes.push({ path, status: 'removed', oldOid: before.oid, newOid: null });
    else if (before !== undefined && after !== undefined && before.oid !== after.oid) {
      changes.push({ path, status: 'modified', oldOid: before.oid, newOid: after.oid });
    }
  }
  return changes;
}

/**
 * A three-way merge of flattened trees. A path conflicts when both sides changed
 * it to different results (modify/delete and add/add-different included).
 */
export function mergeMaps(
  base: FlatTree,
  ours: FlatTree,
  theirs: FlatTree,
): { merged: FlatTree | null; conflicts: string[] } {
  const merged: FlatTree = new Map();
  const conflicts: string[] = [];
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path)?.oid ?? null;
    const o = ours.get(path)?.oid ?? null;
    const t = theirs.get(path)?.oid ?? null;
    let result: string | null;
    if (o === t) result = o;
    else if (b === o) result = t;
    else if (b === t) result = o;
    else {
      conflicts.push(path);
      continue;
    }
    if (result !== null) {
      const entry = (result === o ? ours : theirs).get(path) ?? base.get(path);
      merged.set(path, entry ?? { mode: '100644', oid: result });
    }
  }
  return conflicts.length > 0 ? { merged: null, conflicts } : { merged, conflicts };
}

/** Lines in a text buffer, git-style (a trailing partial line still counts). */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (const byte of data) if (byte === 0x0a) lines += 1;
  if (data[data.length - 1] !== 0x0a) lines += 1;
  return lines;
}

/** Added/removed line counts between two blob versions (exact LCS under a size cap, else whole-file). */
export function lineDelta(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  if (oldData === null && newData === null) return { additions: 0, deletions: 0 };
  if (oldData === null) return { additions: countLines(newData!), deletions: 0 };
  if (newData === null) return { additions: 0, deletions: countLines(oldData) };
  const oldLines = oldData.toString('utf8').split('\n');
  const newLines = newData.toString('utf8').split('\n');
  if (oldLines.length > 4000 || newLines.length > 4000 || oldLines.length * newLines.length > 4_000_000) {
    return { additions: countLines(newData), deletions: countLines(oldData) };
  }
  // Longest-common-subsequence length over lines; the rest is added/removed.
  const width = newLines.length + 1;
  let prev = new Uint32Array(width);
  let curr = new Uint32Array(width);
  for (let i = 1; i <= oldLines.length; i += 1) {
    for (let j = 1; j <= newLines.length; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  const common = prev[newLines.length]!;
  return {
    additions: Math.max(0, countLines(newData) - common),
    deletions: Math.max(0, countLines(oldData) - common),
  };
}

// ---------------------------------------------------------------- packfiles

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) copyOffset += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if ((op & (1 << bit)) !== 0) copySize += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/** Inflate one zlib stream at `offset`; answers its bytes and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  data: Buffer;
  baseOffset: number;
  baseOid: string;
  resolvedType: GitObjectType | null;
  resolvedData: Buffer | null;
  oid: string;
}

/**
 * Read a packfile and resolve every object, OFS_DELTA and REF_DELTA included.
 * A REF_DELTA base the pack omits (a thin pack) comes from `resolveExternal`.
 */
export function readPack(pack: Buffer, resolveExternal?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum does not match its bytes');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset]!;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset]!;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: RawPackEntry = {
      offset: entryOffset,
      typeCode,
      data: Buffer.alloc(0),
      baseOffset: 0,
      baseOid: '',
      resolvedType: null,
      resolvedData: null,
      oid: '',
    };
    if (typeCode === 6) {
      let b = pack[offset]!;
      offset += 1;
      let value = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = pack[offset]!;
        offset += 1;
        value = (value + 1) * 128 + (b & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== size) {
      throw new Error(`pack entry at ${entryOffset} declares ${size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const byOid = new Map<string, RawPackEntry>();
  const resolve = (entry: RawPackEntry): GitObject => {
    if (entry.resolvedType !== null && entry.resolvedData !== null) return { type: entry.resolvedType, data: entry.resolvedData };
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset);
      if (baseEntry === undefined) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = byOid.get(entry.baseOid);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveExternal?.(entry.baseOid);
        if (external === undefined) throw new Error(`ref-delta base ${entry.baseOid} is not available`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    entry.resolvedType = type;
    entry.resolvedData = data;
    entry.oid = hashObject(type, data);
    byOid.set(entry.oid, entry);
    return { type, data };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(entry.oid)) objects.set(entry.oid, resolved);
  }
  return objects;
}

/** Encode one object's pack header (the type/size varint). */
function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas), with a correct SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
