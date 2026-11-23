// main.ts is mend, the CLI SPEC.md specifies (MIT). Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// It does all of SPEC.md: the command line, the output and exit codes, safe paths, format
// detection, the four edit formats (unified diffs, SEARCH/REPLACE blocks, V4A patches and
// JSON edits), matching lines at three tiers, and the all-or-nothing write.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file
// hands over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its line break, its lines, whether it ends with a line break. */
interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const isBlankLine = (s: string): boolean => s.trim() === '';

/** Line equality at a matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

/** Positions at or after `from` where O's lines occur in `lines` at `tier`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const last = lines.length - o.length;
  for (let i = from; i <= last; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs at or after
 * `from`, with every position at that tier; null when it occurs at no tier. When `eof` is
 * set only occurrences that end at the file's last line count.
 */
function findTier(lines: string[], o: string[], from: number, strict: boolean, eof: boolean): { tier: number; pos: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const pos = occurrences(lines, o, t, from).filter((p) => !eof || p + o.length === lines.length);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: a context line names the file line it is (its index in O), else null. */
interface NLine {
  text: string;
  fileIdx: number | null;
}

/**
 * Render N at a match: context lines are the file's own matched lines, and at tier 2 every
 * other line is re-indented from O's first line's leading whitespace to the file's.
 */
function renderN(n: NLine[], fileLines: string[], at: number, o: string[], tier: number): string[] {
  const f = leadingWs(fileLines[at] ?? '');
  const p = leadingWs(o[0] ?? '');
  return n.map((nl) => {
    if (nl.fileIdx !== null) return fileLines[at + nl.fileIdx]!;
    const t = nl.text;
    if (tier === 2 && t !== '' && !/^[ \t]*$/.test(t) && t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Unified diffs (SPEC.md section 6) ----

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

interface UHunk {
  /** The hunk's -A number (B and D are not used). */
  a: number;
  /** Context and `-` lines, in body order. */
  o: string[];
  /** Context and `+` lines, in body order. */
  n: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  bsAfterLastCtxOrPlus: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  bsAfterLastPlus: boolean;
  hasPlus: boolean;
}

interface USection {
  /** Null means /dev/null (no file). */
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  delete: boolean;
  hunks: UHunk[];
  /** A `\` line follows the section's last `+` line (creation files). */
  bsAfterLastPlus: boolean;
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path of a `--- ` or `+++ ` line: after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  return t.trim();
}

function buildHunk(a: number, body: string[]): UHunk {
  const o: string[] = [];
  const n: NLine[] = [];
  let lastCtxOrPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const bl = body[k]!;
    if (bl.startsWith(' ')) {
      const t = bl.slice(1);
      o.push(t);
      n.push({ text: t, fileIdx: o.length - 1 });
      lastCtxOrPlus = k;
    } else if (bl.startsWith('-')) {
      o.push(bl.slice(1));
    } else if (bl.startsWith('+')) {
      n.push({ text: bl.slice(1), fileIdx: null });
      lastCtxOrPlus = k;
      lastPlus = k;
    } else if (bl === '') {
      o.push('');
      n.push({ text: '', fileIdx: o.length - 1 });
      lastCtxOrPlus = k;
    }
    // `\` lines refer to the body line before them; they add nothing to O or N.
  }
  const follows = (idx: number): boolean => idx >= 0 && idx + 1 < body.length && body[idx + 1]!.startsWith('\\');
  return { a, o, n, bsAfterLastCtxOrPlus: follows(lastCtxOrPlus), bsAfterLastPlus: follows(lastPlus), hasPlus: lastPlus >= 0 };
}

interface RawUSection {
  diffOld: string | null;
  diffNew: string | null;
  dashOld: string | null;
  dashNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UHunk[];
  seenHunk: boolean;
}

function buildUSection(r: RawUSection): USection {
  const dashOld = r.dashOld !== null ? stripAB(r.dashOld) : null;
  const dashNew = r.dashNew !== null ? stripAB(r.dashNew) : null;
  let oldPath: string | null = null;
  let newPath: string | null = null;
  if (dashOld !== null) oldPath = dashOld === '/dev/null' ? null : dashOld;
  else if (r.renameFrom !== null) oldPath = r.renameFrom;
  else if (r.diffOld !== null) oldPath = r.diffOld;
  if (dashNew !== null) newPath = dashNew === '/dev/null' ? null : dashNew;
  else if (r.renameTo !== null) newPath = r.renameTo;
  else if (r.diffNew !== null) newPath = r.diffNew;
  const create = oldPath === null || r.newFile;
  const del = newPath === null || r.deletedFile;
  let bsAfterLastPlus = false;
  for (const h of r.hunks) if (h.hasPlus) bsAfterLastPlus = h.bsAfterLastPlus;
  return { oldPath, newPath, create, delete: del, hunks: r.hunks, bsAfterLastPlus };
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: RawUSection | null = null;
  let i = 0;
  const n = lines.length;
  const fresh = (diffOld: string | null, diffNew: string | null, dashOld: string | null, dashNew: string | null): RawUSection => ({
    diffOld,
    diffNew,
    dashOld,
    dashNew,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
    seenHunk: false,
  });
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur !== null) sections.push(buildUSection(cur));
      cur = fresh(m[1]!, m[2]!, null, null);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !cur.seenHunk) {
        cur.dashOld = headerPath(line);
        cur.dashNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (cur !== null) sections.push(buildUSection(cur));
      cur = fresh(null, null, headerPath(line), headerPath(lines[i + 1]!));
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      const body: string[] = [];
      let j = i + 1;
      while (j < n) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push(bl);
          j++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(buildHunk(a, body));
      cur.seenHunk = true;
      i = j;
      continue;
    }
    if (cur !== null && !cur.seenHunk) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`,
      // `Index:` and any other header line are ignored.
      i++;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored.
    i++;
  }
  if (cur !== null) sections.push(buildUSection(cur));
  return sections;
}

/** Apply one hunk to a file's lines; `d` is the length drift of this section's earlier hunks. */
function applyUnifiedHunk(state: FileState, h: UHunk, d: number, strict: boolean, path: string): FileState {
  const lines = state.lines;
  if (h.o.length === 0) {
    const at = Math.max(0, Math.min(h.a + d, lines.length));
    const added = h.n.map((nl) => nl.text);
    const out = [...lines.slice(0, at), ...added, ...lines.slice(at)];
    return { br: state.br, lines: out, final: at === lines.length ? !h.bsAfterLastCtxOrPlus : state.final };
  }
  const found = findTier(lines, h.o, 0, strict, false);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let at = found.pos[0]!;
  let best = Math.abs(at - target);
  for (const p of found.pos) {
    const dist = Math.abs(p - target);
    if (dist < best) {
      at = p;
      best = dist;
    }
  }
  const rendered = renderN(h.n, lines, at, h.o, found.tier);
  const out = [...lines.slice(0, at), ...rendered, ...lines.slice(at + h.o.length)];
  return { br: state.br, lines: out, final: at + h.o.length === lines.length ? !h.bsAfterLastCtxOrPlus : state.final };
}

function unifiedSectionEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    if (sec.create) {
      const p = sec.newPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const added: string[] = [];
      for (const h of sec.hunks) for (const nl of h.n) if (nl.fileIdx === null) added.push(nl.text);
      const text = added.length === 0 ? '' : added.join('\n') + (sec.bsAfterLastPlus ? '' : '\n');
      tree.now.set(p, text);
      return;
    }
    if (sec.delete) {
      const p = sec.oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = sec.oldPath!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const isMove = sec.newPath !== p;
    if (isMove && !safe(sec.newPath!)) throw new Fail('unsafe', sec.newPath!);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (isMove && tree.get(sec.newPath!) !== null) throw new Fail('exists', sec.newPath!);
    let state = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      state = applyUnifiedHunk(state, h, d, strict, p);
      d += h.n.length - h.o.length;
    }
    const text = joinFile(state);
    if (isMove) {
      tree.now.set(p, null);
      tree.now.set(sec.newPath!, text);
      tree.moves.push([p, sec.newPath!]);
    } else {
      tree.now.set(p, text);
    }
  };
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

interface SRBlock {
  path: string;
  old: string[];
  nw: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  const n = lines.length;
  let i = 0;
  let prevEnd = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchIdx = i;
      let path: string | null = null;
      for (let k = searchIdx - 1; k >= prevEnd; k--) {
        const l = lines[k]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (blocks.length === 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
        path = blocks[blocks.length - 1]!.path;
      }
      let j = searchIdx + 1;
      while (j < n && lines[j]!.trimEnd() !== '=======') j++;
      if (j >= n) throw new Exit2(`error: parse ${searchIdx + 1}`);
      let k = j + 1;
      while (k < n && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
      if (k >= n) throw new Exit2(`error: parse ${searchIdx + 1}`);
      blocks.push({ path, old: lines.slice(searchIdx + 1, j), nw: lines.slice(j + 1, k) });
      prevEnd = k + 1;
      i = k + 1;
      continue;
    }
    i++;
  }
  return blocks;
}

function srBlockEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.old.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const state = splitFile(before);
    const found = findTier(state.lines, b.old, 0, strict, false);
    if (found === null) throw new Fail('no-match', p);
    if (found.pos.length > 1) throw new Fail('ambiguous', p);
    const at = found.pos[0]!;
    const n: NLine[] = b.nw.map((t) => ({ text: t, fileIdx: null }));
    const rendered = renderN(n, state.lines, at, b.old, found.tier);
    const out = [...state.lines.slice(0, at), ...rendered, ...state.lines.slice(at + b.old.length)];
    tree.now.set(p, joinFile({ br: state.br, lines: out, final: state.final }));
  };
}

// ---- V4A patches (SPEC.md section 8) ----

interface VChunk {
  /** Null when the chunk has no anchor (empty anchor text is no anchor). */
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  /** Add File lines, in order. */
  addLines: string[];
  chunks: VChunk[];
}

interface VRawLine {
  text: string;
  /** 1-based patch line number. */
  num: number;
}

interface VRawSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  /** 1-based patch line number of the section's start line. */
  startLine: number;
  lines: VRawLine[];
}

function buildVChunk(c: { anchor: string | null; eof: boolean; body: VRawLine[] }): VChunk {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const l of c.body) {
    const t = l.text;
    if (t.startsWith(' ')) {
      const x = t.slice(1);
      o.push(x);
      n.push({ text: x, fileIdx: o.length - 1 });
    } else if (t.startsWith('-')) {
      o.push(t.slice(1));
    } else if (t.startsWith('+')) {
      n.push({ text: t.slice(1), fileIdx: null });
    } else {
      // An empty line is an empty context line.
      o.push('');
      n.push({ text: '', fileIdx: o.length - 1 });
    }
  }
  return { anchor: c.anchor !== null && c.anchor !== '' ? c.anchor : null, eof: c.eof, o, n };
}

function buildVSection(raw: VRawSection): VSection {
  const lines = raw.lines.slice();
  while (lines.length > 0 && isBlankLine(lines[lines.length - 1]!.text)) lines.pop();
  if (raw.kind === 'add') {
    const out: string[] = [];
    for (const l of lines) {
      if (l.text.startsWith('+')) out.push(l.text.slice(1));
      else if (l.text === '') out.push('');
      else throw new Exit2(`error: parse ${l.num}`);
    }
    return { kind: 'add', path: raw.path, moveTo: null, addLines: out, chunks: [] };
  }
  if (raw.kind === 'delete') {
    if (lines.length > 0) throw new Exit2(`error: parse ${lines[0]!.num}`);
    return { kind: 'delete', path: raw.path, moveTo: null, addLines: [], chunks: [] };
  }
  let moveTo: string | null = null;
  let rest = lines;
  if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to: ')) {
    moveTo = rest[0]!.text.slice('*** Move to: '.length).trim();
    rest = rest.slice(1);
  }
  const chunks: VChunk[] = [];
  let cur: { anchor: string | null; eof: boolean; body: VRawLine[] } | null = null;
  const pushChunk = (): void => {
    if (cur !== null) {
      chunks.push(buildVChunk(cur));
      cur = null;
    }
  };
  for (const l of rest) {
    const t = l.text;
    if (t.startsWith('@@')) {
      pushChunk();
      cur = { anchor: t.slice(2).trim(), eof: false, body: [] };
      continue;
    }
    if (t === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${l.num}`);
      cur.eof = true;
      pushChunk();
      continue;
    }
    if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${l.num}`);
        cur = { anchor: null, eof: false, body: [] };
      }
      cur.body.push(l);
      continue;
    }
    throw new Exit2(`error: parse ${l.num}`);
  }
  pushChunk();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${raw.startLine}`);
  return { kind: 'update', path: raw.path, moveTo, addLines: [], chunks };
}

function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VRawSection | null = null;
  const flush = (): void => {
    if (cur !== null) {
      sections.push(buildVSection(cur));
      cur = null;
    }
  };
  for (let i = first + 1; i < last; i++) {
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      flush();
      const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'delete' : 'update';
      const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
      cur = { kind, path: line.slice(prefix.length).trim(), startLine: i + 1, lines: [] };
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    cur.lines.push({ text: line, num: i + 1 });
  }
  flush();
  return sections;
}

/** Apply one V4A chunk; returns the new file state and the cursor just past the lines written. */
function applyVChunk(state: FileState, ch: VChunk, cursor: number, strict: boolean, path: string): { state: FileState; cursor: number } {
  let lines = state.lines;
  if (ch.anchor !== null) {
    const found = findTier(lines, [ch.anchor], cursor, strict, false);
    if (found === null) throw new Fail('no-match', path);
    cursor = found.pos[0]! + 1;
  }
  if (ch.o.length === 0) {
    const at = ch.eof ? lines.length : cursor;
    const added = ch.n.map((nl) => nl.text);
    lines = [...lines.slice(0, at), ...added, ...lines.slice(at)];
    return { state: { br: state.br, lines, final: state.final }, cursor: at + added.length };
  }
  const found = findTier(lines, ch.o, cursor, strict, ch.eof);
  if (found === null) throw new Fail('no-match', path);
  const at = found.pos[0]!;
  const rendered = renderN(ch.n, lines, at, ch.o, found.tier);
  lines = [...lines.slice(0, at), ...rendered, ...lines.slice(at + ch.o.length)];
  return { state: { br: state.br, lines, final: state.final }, cursor: at + rendered.length };
}

function v4aSectionEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    if (sec.kind === 'add') {
      const p = sec.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      const p = sec.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    let state = splitFile(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      const r = applyVChunk(state, ch, cursor, strict, p);
      state = r.state;
      cursor = r.cursor;
    }
    const text = joinFile(state);
    if (sec.moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(sec.moveTo, text);
      tree.moves.push([p, sec.moveTo]);
    } else {
      tree.now.set(p, text);
    }
  };
}

// ---- Running (SPEC.md sections 1, 2 and 10) ----

const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines).map((s) => unifiedSectionEdit(s, strict));
    else if (kind === 'search-replace') edits = parseSearchReplace(lines).map((b) => srBlockEdit(b, strict));
    else edits = parseV4a(lines).map((s) => v4aSectionEdit(s, strict));
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
