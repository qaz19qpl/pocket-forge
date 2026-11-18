// Git smart HTTP: ref advertisement, upload-pack (protocol v2 ls-refs/fetch
// with shallow support, plus the v0 fallback) and receive-pack v0 with
// report-status. Everything runs against the forge's in-memory object stores.

import {
  ZERO_OID,
  collectReachable,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  peelTag,
  peelToCommit,
  readPack,
  writePack,
  type GitObject,
} from './gitobj.ts';
import { Forge, type RepoState } from './store.ts';

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Parse a pkt-line stream; answers the packets and the bytes past the first flush at packet level. */
export function parsePackets(buffer: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      return { packets, rest: buffer.subarray(offset) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  if (offset !== buffer.length) throw new Error('trailing bytes after the pkt-line stream');
  return { packets, rest: Buffer.alloc(0) };
}

/** Parse packets until the stream ends (no early flush return). */
function parseAllPackets(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  if (offset !== buffer.length) throw new Error('trailing bytes after the pkt-line stream');
  return packets;
}

function linesOf(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------- advertisements

const UPLOAD_CAPS_V0 =
  'side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not no-progress symref=HEAD:refs/heads/main agent=makefun-forge/1.0';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta agent=makefun-forge/1.0';

/** The refs a repository advertises, HEAD first, then name order, tags with their peeled targets. */
export function advertisedRefs(repo: RepoState): Array<{ oid: string; name: string; peeled?: string }> {
  const refs: Array<{ oid: string; name: string; peeled?: string }> = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (headOid !== undefined) refs.push({ oid: headOid, name: 'HEAD' });
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name)!;
    const entry: { oid: string; name: string; peeled?: string } = { oid, name };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = peelTag(repo.objects, oid);
      if (peeled !== null && peeled !== oid) entry.peeled = peeled;
    }
    refs.push(entry);
  }
  return refs;
}

/** GET /info/refs for one service. */
export function infoRefs(
  forge: Forge,
  owner: string,
  repoName: string,
  service: string,
  protocolV2: boolean,
): { status: number; contentType: string; body: Buffer } {
  const repo = forge.repoOrNull(owner, repoName);
  if (repo === null || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
    return { status: 404, contentType: 'text/plain', body: Buffer.from('Repository not found\n', 'utf8') };
  }
  const contentType = `application/x-${service}-advertisement`;
  if (protocolV2 && service === 'git-upload-pack') {
    const body = Buffer.concat([
      pktLine('version 2\n'),
      pktLine('agent=makefun-forge/1.0\n'),
      pktLine('ls-refs=unborn\n'),
      pktLine('fetch=shallow\n'),
      pktLine('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    return { status: 200, contentType, body };
  }
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = advertisedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------- ls-refs (v2)

function lsRefs(repo: RepoState, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  // HEAD rides along only when a ref-prefix covers it: real git asks with
  // `ref-prefix HEAD`; the kit's prefixes (refs/heads, refs/tags) do not.
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    } else {
      parts.push(pktLine(`${ZERO_OID} HEAD${symrefs ? ` symref-target:${headRef}` : ''}\n`));
    }
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (peel) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelTag(repo.objects, oid);
        if (peeled !== null && peeled !== oid) line += ` peeled:${peeled}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  /** Whether the client ended its request with `done` (real git negotiates in rounds otherwise). */
  done: boolean;
  /** deepen is relative to the client's current shallow depth (real git sends this). */
  deepenRelative: boolean;
}

interface FetchPlan {
  objects: GitObject[];
  shallowLines: string[];
  unshallowLines: string[];
  shallowInvolved: boolean;
  commonHave: string | null;
}

/** Decide which objects a fetch sends and how the shallow boundary moves. */
function planFetch(repo: RepoState, request: FetchRequest): FetchPlan {
  const store = repo.objects;
  const clientShallow = new Set(request.shallow.filter((oid) => store.has(oid)));
  // deepen-relative (real git): the requested depth extends the client's
  // current shallow depth, i.e. the generation of its deepest boundary.
  let deepen = request.deepen;
  if (request.deepenRelative && deepen !== null && clientShallow.size > 0) {
    const generations = new Map<string, number>();
    const queue: Array<{ oid: string; gen: number }> = [];
    for (const want of request.wants) {
      const commit = peelToCommit(store, want);
      if (commit !== null) queue.push({ oid: commit, gen: 1 });
    }
    let deepest = 0;
    while (queue.length > 0) {
      const { oid, gen } = queue.shift()!;
      if (generations.has(oid) && generations.get(oid)! <= gen) continue;
      generations.set(oid, gen);
      if (clientShallow.has(oid)) deepest = Math.max(deepest, gen);
      const object = store.get(oid);
      if (object !== undefined && object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, gen: gen + 1 });
      }
    }
    if (deepest > 0) deepen = deepest + deepen;
  }
  const haveSet = collectReachable(store, request.haves.filter((oid) => store.has(oid)), {
    cutCommits: clientShallow,
    allowMissing: true,
  });
  for (const notRef of request.deepenNot) {
    const tip = repo.refs.get(notRef) ?? repo.refs.get(`refs/heads/${notRef}`);
    if (tip !== undefined) {
      for (const oid of collectReachable(store, [tip], { allowMissing: true })) haveSet.add(oid);
    }
  }

  const candidate = new Set<string>();
  const commitGen = new Map<string, number>();
  if (deepen !== null || request.deepenSince !== null) {
    // Breadth-first by generation from the wants (peeled to commits).
    const queue: Array<{ oid: string; gen: number }> = [];
    for (const want of request.wants) {
      if (!store.has(want)) continue;
      // Tag objects along the peel chain ride along; the commit is queued.
      let current = want;
      for (let hops = 0; hops < 32; hops += 1) {
        const object = store.get(current);
        if (object === undefined || object.type !== 'tag') break;
        candidate.add(current);
        current = parseTag(object.data).object;
        if (!isOid(current)) break;
      }
      const commit = peelToCommit(store, want);
      if (commit !== null) queue.push({ oid: commit, gen: 1 });
      else if (store.has(want) && store.get(want)?.type !== 'commit') {
        // A tree/blob want: its closure goes whole.
        for (const oid of collectReachable(store, [want], { allowMissing: true })) candidate.add(oid);
      }
    }
    while (queue.length > 0) {
      const { oid, gen } = queue.shift()!;
      if (commitGen.has(oid) && commitGen.get(oid)! <= gen) continue;
      if (deepen !== null && gen > deepen) continue;
      commitGen.set(oid, gen);
      candidate.add(oid);
      const commit = parseCommit(store.get(oid)!.data);
      for (const oid2 of collectReachable(store, [commit.tree], { allowMissing: true })) candidate.add(oid2);
      const cutByDepth = deepen !== null && gen >= deepen;
      const cutByTime = request.deepenSince !== null && commit.time < request.deepenSince;
      if (!cutByDepth && !cutByTime) {
        for (const parent of commit.parents) queue.push({ oid: parent, gen: gen + 1 });
      }
    }
  } else {
    for (const oid of collectReachable(store, request.wants.filter((oid) => store.has(oid)), { allowMissing: true })) {
      candidate.add(oid);
      if (store.get(oid)?.type === 'commit') commitGen.set(oid, 0);
    }
  }

  const send: GitObject[] = [];
  const sent = new Set<string>();
  for (const oid of candidate) {
    if (haveSet.has(oid) || sent.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    sent.add(oid);
    send.push(object);
  }
  // Commits first (generation order), then the rest: a tidy, deterministic pack.
  send.sort((a, b) => {
    const rank = (object: GitObject): number => (object.type === 'commit' ? 0 : object.type === 'tree' ? 1 : object.type === 'tag' ? 2 : 3);
    return rank(a) - rank(b);
  });

  const shallowInvolved = deepen !== null || request.deepenSince !== null || clientShallow.size > 0;
  const shallowLines: string[] = [];
  const unshallowLines: string[] = [];
  if (shallowInvolved) {
    const clientCommits = new Set<string>();
    for (const oid of haveSet) if (store.get(oid)?.type === 'commit') clientCommits.add(oid);
    const boundary = new Set<string>();
    for (const oid of candidate) {
      const object = store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length === 0) continue;
      const isBoundary = parents.some((parent) => !candidate.has(parent) && !clientCommits.has(parent));
      if (isBoundary) boundary.add(oid);
    }
    for (const oid of boundary) if (!clientShallow.has(oid)) shallowLines.push(`shallow ${oid}`);
    for (const oid of clientShallow) {
      if (candidate.has(oid) && !boundary.has(oid)) unshallowLines.push(`unshallow ${oid}`);
    }
  }

  let commonHave: string | null = null;
  for (const have of request.haves) {
    if (store.has(have)) {
      commonHave = have;
      break;
    }
  }
  return { objects: send, shallowLines, unshallowLines, shallowInvolved, commonHave };
}

/** Sideband-64k framing for a pack: band-1 packets of at most 65515 payload bytes, then a flush. */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(payload));
  }
  return parts;
}

function fetchResponse(repo: RepoState, request: FetchRequest, version2: boolean): Buffer {
  const plan = planFetch(repo, request);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (version2) {
    // Canonical v2 framing (as git's own upload-pack does it): sections are
    // separated by a delim packet and only the whole response ends with a
    // flush. The kit's parser accepts both delim and flush as separators.
    const sections: Buffer[][] = [];
    if (request.haves.length > 0 || !request.done) {
      const acks: Buffer[] = [pktLine('acknowledgments\n')];
      acks.push(pktLine(plan.commonHave === null ? 'NAK\n' : `ACK ${plan.commonHave}\n`));
      // Without `done` the client is mid-negotiation; `ready` ends it here.
      if (!request.done) acks.push(pktLine('ready\n'));
      sections.push(acks);
    }
    if (plan.shallowInvolved) {
      const info: Buffer[] = [pktLine('shallow-info\n')];
      for (const line of plan.shallowLines) info.push(pktLine(`${line}\n`));
      for (const line of plan.unshallowLines) info.push(pktLine(`${line}\n`));
      sections.push(info);
    }
    sections.push([pktLine('packfile\n'), ...sidebandPack(pack)]);
    sections.forEach((section, index) => {
      parts.push(...section);
      parts.push(index === sections.length - 1 ? PKT_FLUSH : PKT_DELIM);
    });
    return Buffer.concat(parts);
  }
  for (const line of plan.shallowLines) parts.push(pktLine(`${line}\n`));
  for (const line of plan.unshallowLines) parts.push(pktLine(`${line}\n`));
  parts.push(pktLine(plan.commonHave === null ? 'NAK\n' : `ACK ${plan.commonHave}\n`));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** POST /git-upload-pack: a v2 command (ls-refs/fetch) or a v0 fetch. */
export function uploadPack(forge: Forge, owner: string, repoName: string, body: Buffer, protocolV2: boolean): { status: number; contentType: string; body: Buffer } {
  const repo = forge.repoOrNull(owner, repoName);
  if (repo === null) return { status: 404, contentType: 'text/plain', body: Buffer.from('Repository not found\n', 'utf8') };
  const contentType = 'application/x-git-upload-pack-result';
  try {
    if (protocolV2) {
      const packets = parseAllPackets(body);
      // Split into the command section (up to the delim) and the argument section (up to the flush).
      const sections: Packet[][] = [];
      let current: Packet[] = [];
      for (const packet of packets) {
        if (packet.kind === 'delim' || packet.kind === 'flush') {
          sections.push(current);
          current = [];
          if (packet.kind === 'flush') break;
        } else if (packet.kind === 'data') {
          current.push(packet);
        }
      }
      if (current.length > 0) sections.push(current);
      const commandLines = linesOf(sections[0] ?? []);
      const command = commandLines.find((line) => line.startsWith('command='));
      const args = linesOf(sections[1] ?? []);
      if (command === 'command=ls-refs') {
        return { status: 200, contentType, body: lsRefs(repo, args) };
      }
      if (command === 'command=fetch') {
        const request = parseFetchArgs(args);
        // A want-ref names a ref; resolve it to the ref's current tip.
        request.wants = request.wants.map((want) => {
          if (!want.startsWith('ref:')) return want;
          return repo.refs.get(want.slice(4)) ?? want;
        });
        return { status: 200, contentType, body: fetchResponse(repo, request, true) };
      }
      return { status: 400, contentType: 'text/plain', body: Buffer.from('Unknown command\n', 'utf8') };
    }
    // v0: wants section, flush, haves section, flush.
    const packets = parseAllPackets(body);
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let deepen: number | null = null;
    let deepenSince: number | null = null;
    const deepenNot: string[] = [];
    let section = 0;
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        section += 1;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (section === 0) {
        if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!);
        else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) deepen = Number.parseInt(line.slice(7), 10);
        else if (line.startsWith('deepen-since ')) deepenSince = Number.parseInt(line.slice(13), 10);
        else if (line.startsWith('deepen-not ')) deepenNot.push(line.slice(11).trim());
      } else if (line.startsWith('have ')) {
        haves.push(line.slice(5).trim());
      }
    }
    const request: FetchRequest = { wants, haves, shallow, deepen, deepenSince, deepenNot, done: true, deepenRelative: false };
    return { status: 200, contentType, body: fetchResponse(repo, request, false) };
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('Bad request\n', 'utf8') };
  }
}

function parseFetchArgs(args: readonly string[]): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null, deepenSince: null, deepenNot: [], done: false, deepenRelative: false };
  for (const arg of args) {
    if (arg.startsWith('want ')) request.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) request.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) request.shallow.push(arg.slice(8).trim());
    else if (arg === 'done') request.done = true;
    else if (arg === 'deepen-relative') request.deepenRelative = true;
    else if (arg.startsWith('deepen ')) request.deepen = Number.parseInt(arg.slice(7), 10);
    else if (arg.startsWith('deepen-since ')) request.deepenSince = Number.parseInt(arg.slice(13), 10);
    else if (arg.startsWith('deepen-not ')) request.deepenNot.push(arg.slice(11).trim());
    else if (arg.startsWith('want-ref ')) {
      // A want by ref name: resolve it like a want of its tip.
      const ref = arg.slice(9).trim();
      request.wants.push(`ref:${ref}`);
    }
  }
  return request;
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /git-receive-pack: unpack, validate fast-forwards per ref, report status. */
export function receivePack(forge: Forge, owner: string, repoName: string, body: Buffer): { status: number; contentType: string; body: Buffer } {
  const repo = forge.repoOrNull(owner, repoName);
  if (repo === null) return { status: 404, contentType: 'text/plain', body: Buffer.from('Repository not found\n', 'utf8') };
  const contentType = 'application/x-git-receive-pack-result';
  let commands: PushCommand[] = [];
  let capabilities = new Set<string>();
  let pack = Buffer.alloc(0);
  try {
    const parsed = parsePackets(body);
    const lines: string[] = [];
    for (const packet of parsed.packets) {
      if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
    lines.forEach((line, index) => {
      let text = line;
      if (index === 0) {
        const nul = text.indexOf('\0');
        if (nul >= 0) {
          capabilities = new Set(text.slice(nul + 1).split(' ').filter((cap) => cap !== ''));
          text = text.slice(0, nul);
        }
      }
      const parts = text.split(' ');
      if (parts.length === 3 && isOid(parts[0]!) && isOid(parts[1]!)) {
        commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
      }
    });
    pack = parsed.rest;
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('Bad request\n', 'utf8') };
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      const objects = readPack(pack, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (error) {
      unpackOk = false;
      unpackDetail = error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(0, 120) : 'error';
    }
  }

  const headRef = `refs/heads/${repo.defaultBranch}`;
  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}`];
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpacker error`);
      continue;
    }
    const reason = applyPushCommand(repo, command, headRef);
    reportLines.push(reason === null ? `ok ${command.ref}` : `ng ${command.ref} ${reason}`);
  }

  const reportStream = Buffer.concat([...reportLines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  if (capabilities.has('side-band-64k')) {
    const parts: Buffer[] = [];
    const CHUNK = 65515;
    for (let offset = 0; offset < reportStream.length; offset += CHUNK) {
      const chunk = reportStream.subarray(offset, Math.min(reportStream.length, offset + CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(PKT_FLUSH);
    return { status: 200, contentType, body: Buffer.concat(parts) };
  }
  return { status: 200, contentType, body: reportStream };
}

/** Validate and apply one push command; null when applied, else the refusal reason. */
function applyPushCommand(repo: RepoState, command: PushCommand, headRef: string): string | null {
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/') || ref.includes('..') || ref.includes('//')) return 'invalid ref';
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (oldOid !== current) return 'stale info';
  if (newOid === ZERO_OID) {
    if (ref === headRef) return 'deletion of the current branch prohibited';
    repo.refs.delete(ref);
    return null;
  }
  if (!repo.objects.has(newOid)) return 'missing object';
  if (oldOid !== ZERO_OID) {
    const oldCommit = peelToCommit(repo.objects, oldOid);
    const newCommit = peelToCommit(repo.objects, newOid);
    if (oldCommit !== null && newCommit !== null && oldCommit !== newCommit && !isAncestor(repo.objects, oldCommit, newCommit)) {
      return 'non-fast-forward';
    }
  }
  repo.refs.set(ref, newOid);
  return null;
}
