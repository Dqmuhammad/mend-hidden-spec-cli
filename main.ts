// main.ts is mend, the CLI SPEC.md specifies (MIT). It applies an edit that an AI model wrote, in four formats
// (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool calls), to a tree of text files, all or nothing.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** A file as lines: its line break, its lines, and whether it ends with a line break (SPEC.md section 3). */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function serializeFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
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

/** One new line: its text, and the index into O of the context line it is, or null when it is added (section 5). */
interface NLine {
  text: string;
  ctx: number | null;
}

const norm = (line: string, tier: number): string => {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
};

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** Tier 2 re-indentation (section 5): a non-blank new line starting with P has that P replaced by F. */
function reindent(line: string, p: string, f: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/** Occurrences of O in lines at or after `from`, at the first tier (up to maxTier) with one; for an end-of-file
 * chunk only occurrences ending at the file's last line (sections 5 and 8). */
function findTierFrom(
  lines: string[],
  o: string[],
  from: number,
  maxTier: number,
  eof: boolean,
): { tier: number; occ: number[] } | null {
  for (let t = 0; t <= maxTier; t++) {
    const want = o.map((l) => norm(l, t));
    const occ: number[] = [];
    for (let i = from; i + o.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (norm(lines[i + j]!, t) !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok && (!eof || i + o.length === lines.length)) occ.push(i);
    }
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Replace the k matched lines at pos by N: context lines are the file's own matched lines, other lines are
 * re-indented at tier 2 (section 5). */
function applyMatch(file: FileModel, o: string[], n: NLine[], pos: number, tier: number): void {
  const f = tier === 2 ? leadingWs(file.lines[pos]!) : '';
  const p = tier === 2 ? leadingWs(o[0]!) : '';
  const out: string[] = [];
  for (const nl of n) {
    if (nl.ctx !== null) out.push(file.lines[pos + nl.ctx]!);
    else if (tier === 2) out.push(reindent(nl.text, p, f));
    else out.push(nl.text);
  }
  file.lines.splice(pos, o.length, ...out);
}

/** First line at or after `from` equal to the anchor, at the first tier where one is (section 8). */
function findAnchor(lines: string[], anchor: string, from: number, maxTier: number): number {
  for (let t = 0; t <= maxTier; t++) {
    const want = norm(anchor, t);
    for (let i = from; i < lines.length; i++) {
      if (norm(lines[i]!, t) === want) return i;
    }
  }
  return -1;
}

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

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  /** Old-file start line from the header (1-based). */
  a: number;
  o: string[];
  n: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noFinalBreak: boolean;
  /** A `\` line follows the hunk's last `+` line (for creations). */
  lastPlusNoBreak: boolean;
  hasPlus: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_RE = /^diff --git a\/([^ ]+) b\/([^ ]+)$/;

/** The path of a `--- ` / `+++ ` line: after the four characters, up to the first tab, spaces removed,
 * a leading `a/` or `b/` removed; `/dev/null` means no file. */
function headerPath(l: string): string | null {
  let p = l.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = parseInt(m[1]!, 10);
  let j = i + 1;
  const body: string[] = [];
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j++;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const o: string[] = [];
  const n: NLine[] = [];
  const bsAfter = new Array<boolean>(body.length).fill(false);
  let lastCtxAdd = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l.startsWith('\\')) {
      if (k > 0) bsAfter[k - 1] = true;
    } else if (l.startsWith(' ')) {
      o.push(l.slice(1));
      n.push({ text: l.slice(1), ctx: o.length - 1 });
      lastCtxAdd = k;
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: null });
      lastCtxAdd = k;
      lastPlus = k;
    } else {
      o.push('');
      n.push({ text: '', ctx: o.length - 1 });
      lastCtxAdd = k;
    }
  }
  return {
    hunk: {
      a,
      o,
      n,
      noFinalBreak: lastCtxAdd >= 0 && bsAfter[lastCtxAdd] === true,
      lastPlusNoBreak: lastPlus >= 0 && bsAfter[lastPlus] === true,
      hasPlus: lastPlus >= 0,
    },
    next: j,
  };
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  /** A `---`/`+++` pair named the paths (SPEC.md section 6): `rename from`/`rename to` then do not. */
  pair: boolean;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, pair: false, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(l);
      const newP = headerPath(lines[i + 1]!);
      if (cur !== null && inHeader) {
        cur.oldPath = oldP;
        cur.newPath = newP;
        cur.pair = true;
      } else {
        cur = { oldPath: oldP, newPath: newP, pair: true, newFile: false, deletedFile: false, hunks: [] };
        sections.push(cur);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('@@')) {
        const h = parseHunk(lines, i);
        cur.hunks.push(h.hunk);
        inHeader = false;
        i = h.next;
        continue;
      }
      if (l.startsWith('rename from ') && !cur.pair) cur.oldPath = l.slice(12).trim();
      else if (l.startsWith('rename to ') && !cur.pair) cur.newPath = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.deletedFile = true;
      i++;
      continue;
    }
    if (cur !== null) {
      if (l.startsWith('@@')) {
        const h = parseHunk(lines, i);
        cur.hunks.push(h.hunk);
        i = h.next;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i++;
  }
  return sections;
}

/** Apply a section's hunks in order to a file model (section 6). */
function applyHunks(file: FileModel, hunks: Hunk[], maxTier: number, failPath: string): void {
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const idx = Math.min(Math.max(h.a + d, 0), file.lines.length);
      const atEnd = idx === file.lines.length;
      file.lines.splice(idx, 0, ...h.n.map((nl) => nl.text));
      if (atEnd) file.final = !h.noFinalBreak;
      d += h.n.length;
    } else {
      const found = findTierFrom(file.lines, h.o, 0, maxTier, false);
      if (found === null) throw new Fail('no-match', failPath);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      for (const p of found.occ) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const atEnd = best + h.o.length === file.lines.length;
      applyMatch(file, h.o, h.n, best, found.tier);
      if (atEnd) file.final = !h.noFinalBreak;
      d += h.n.length - h.o.length;
    }
  }
}

function unifiedEdits(sections: USection[], strict: boolean): Edit[] {
  const maxTier = strict ? 0 : 2;
  return sections.map((s) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    const isCreate = oldP === null || s.newFile;
    const isDelete = !isCreate && (newP === null || s.deletedFile);
    if (isCreate) {
      const target = newP ?? '/dev/null';
      return (tree: Tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) !== null) throw new Fail('exists', target);
        const plus: string[] = [];
        let noBreak = false;
        let sawPlus = false;
        for (const h of s.hunks) {
          for (const nl of h.n) if (nl.ctx === null) plus.push(nl.text);
          if (h.hasPlus) {
            sawPlus = true;
            noBreak = h.lastPlusNoBreak;
          }
        }
        const model: FileModel = { lines: plus, br: '\n', final: sawPlus ? !noBreak : true };
        tree.now.set(target, serializeFile(model));
      };
    }
    if (isDelete) {
      const target = oldP ?? '/dev/null';
      return (tree: Tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) === null) throw new Fail('missing', target);
        tree.now.set(target, null);
      };
    }
    if (oldP !== newP) {
      const from = oldP!;
      const to = newP!;
      return (tree: Tree) => {
        if (!safe(from)) throw new Fail('unsafe', from);
        if (!safe(to)) throw new Fail('unsafe', to);
        const text = tree.get(from);
        if (text === null) throw new Fail('missing', from);
        if (tree.get(to) !== null) throw new Fail('exists', to);
        const file = parseFile(text);
        applyHunks(file, s.hunks, maxTier, from);
        tree.now.set(from, null);
        tree.now.set(to, serializeFile(file));
        tree.moves.push([from, to]);
      };
    }
    const target = oldP!;
    return (tree: Tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      const text = tree.get(target);
      if (text === null) throw new Fail('missing', target);
      const file = parseFile(text);
      applyHunks(file, s.hunks, maxTier, target);
      tree.now.set(target, serializeFile(file));
    };
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSR(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i;
      let path: string | null = null;
      for (let j = searchLine - 1; j > prevReplace; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (prevPath !== null) path = prevPath;
        else throw new Exit2(`error: parse ${searchLine + 1}`);
      }
      let eq = -1;
      for (let j = searchLine + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      let rep = -1;
      if (eq >= 0) {
        for (let j = eq + 1; j < lines.length; j++) {
          if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
            rep = j;
            break;
          }
        }
      }
      if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
      blocks.push({ path, oldLines: lines.slice(searchLine + 1, eq), newLines: lines.slice(eq + 1, rep) });
      prevPath = path;
      prevReplace = rep;
      i = rep + 1;
    } else i++;
  }
  return blocks;
}

function srEdits(blocks: SRBlock[], strict: boolean): Edit[] {
  const maxTier = strict ? 0 : 2;
  return blocks.map((b) => {
    return (tree: Tree) => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }
      const text = tree.get(b.path);
      if (text === null) throw new Fail('missing', b.path);
      const file = parseFile(text);
      const found = findTierFrom(file.lines, b.oldLines, 0, maxTier, false);
      if (found === null) throw new Fail('no-match', b.path);
      if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
      const n: NLine[] = b.newLines.map((t) => ({ text: t, ctx: null }));
      applyMatch(file, b.oldLines, n, found.occ[0]!, found.tier);
      tree.now.set(b.path, serializeFile(file));
    };
  });
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lines: string[];
  moveTo: string | null;
  chunks: VChunk[];
  lineNo: number;
}

function parseV4A(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.trim() === '*** End Patch') throw new Exit2(`error: parse ${i + 1}`);
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice(14).trim();
      const content: string[] = [];
      i++;
      while (i < last) {
        const l2 = lines[i]!;
        if (isSectionStart(l2) || l2.trim() === '*** End Patch') break;
        if (l2.startsWith('+')) content.push(l2.slice(1));
        else if (l2 === '') content.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      while (content.length > 0 && blank(content[content.length - 1]!)) content.pop();
      sections.push({ kind: 'add', path, lines: content, moveTo: null, chunks: [], lineNo: i });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice(17).trim();
      const headerLine = i + 1;
      i++;
      let j = i;
      while (j < last && blank(lines[j]!)) j++;
      if (j < last && !isSectionStart(lines[j]!) && lines[j]!.trim() !== '*** End Patch') {
        throw new Exit2(`error: parse ${j + 1}`);
      }
      sections.push({ kind: 'delete', path, lines: [], moveTo: null, chunks: [], lineNo: headerLine });
      i = j;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice(17).trim();
      const headerLine = i + 1;
      i++;
      const raw: { text: string; no: number }[] = [];
      while (i < last) {
        const l2 = lines[i]!;
        if (isSectionStart(l2) || l2.trim() === '*** End Patch') break;
        raw.push({ text: l2, no: i + 1 });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice(13).trim();
        k = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (; k < raw.length; k++) {
        const l2 = raw[k]!.text;
        const ln = raw[k]!.no;
        if (l2.startsWith('@@')) {
          const a = l2.slice(2).trim();
          cur = { anchor: a === '' ? null : a, eof: false, o: [], n: [] };
          chunks.push(cur);
          continue;
        }
        if (l2 === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${ln}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (l2.startsWith(' ') || l2.startsWith('-') || l2.startsWith('+') || l2 === '') {
          if (cur === null) {
            if (chunks.length === 0) {
              cur = { anchor: null, eof: false, o: [], n: [] };
              chunks.push(cur);
            } else throw new Exit2(`error: parse ${ln}`);
          }
          if (l2.startsWith(' ')) {
            cur.o.push(l2.slice(1));
            cur.n.push({ text: l2.slice(1), ctx: cur.o.length - 1 });
          } else if (l2.startsWith('-')) {
            cur.o.push(l2.slice(1));
          } else if (l2.startsWith('+')) {
            cur.n.push({ text: l2.slice(1), ctx: null });
          } else {
            cur.o.push('');
            cur.n.push({ text: '', ctx: cur.o.length - 1 });
          }
          continue;
        }
        throw new Exit2(`error: parse ${ln}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      sections.push({ kind: 'update', path, lines: [], moveTo, chunks, lineNo: headerLine });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections;
}

function v4aEdits(sections: VSection[], strict: boolean): Edit[] {
  const maxTier = strict ? 0 : 2;
  return sections.map((s) => {
    if (s.kind === 'add') {
      return (tree: Tree) => {
        if (!safe(s.path)) throw new Fail('unsafe', s.path);
        if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
        tree.now.set(s.path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
      };
    }
    if (s.kind === 'delete') {
      return (tree: Tree) => {
        if (!safe(s.path)) throw new Fail('unsafe', s.path);
        if (tree.get(s.path) === null) throw new Fail('missing', s.path);
        tree.now.set(s.path, null);
      };
    }
    return (tree: Tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
      const text = tree.get(s.path);
      if (text === null) throw new Fail('missing', s.path);
      if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
      const file = parseFile(text);
      let cursor = 0;
      for (const ch of s.chunks) {
        if (ch.anchor !== null) {
          const idx = findAnchor(file.lines, ch.anchor, cursor, maxTier);
          if (idx < 0) throw new Fail('no-match', s.path);
          cursor = idx + 1;
        }
        if (ch.o.length === 0) {
          const at = ch.eof ? file.lines.length : cursor;
          const add = ch.n.map((nl) => nl.text);
          file.lines.splice(at, 0, ...add);
          cursor = at + add.length;
        } else {
          const found = findTierFrom(file.lines, ch.o, cursor, maxTier, ch.eof);
          if (found === null) throw new Fail('no-match', s.path);
          const pos = found.occ[0]!;
          applyMatch(file, ch.o, ch.n, pos, found.tier);
          cursor = pos + ch.n.length;
        }
      }
      const out = serializeFile(file);
      if (s.moveTo !== null) {
        tree.now.set(s.path, null);
        tree.now.set(s.moveTo, out);
        tree.moves.push([s.path, s.moveTo]);
      } else {
        tree.now.set(s.path, out);
      }
    };
  });
}

// ---------------------------------------------------------------------------
// Command line, output and exit codes (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

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
    else if (kind === 'unified') edits = unifiedEdits(parseUnified(lines), strict);
    else if (kind === 'search-replace') edits = srEdits(parseSR(lines), strict);
    else edits = v4aEdits(parseV4A(lines), strict);
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
  const rows: { key: string; line: string }[] = [];
  const rPairs: [string, string][] = [];
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rPairs.push([o, n]);
      rOld.add(o);
      rNew.add(n);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (rOld.has(p) || rNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of rPairs) rows.push({ key: n, line: `R ${o} -> ${n}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.line);
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
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
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
