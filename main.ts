// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines
// each edit names at the first of three matching tiers, and writes every change or none.
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

const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

/** One edit: apply it to the tree, or throw Fail; a move edit records [old, new] in `moves` on success. */
type Edit = (tree: Tree, moves: Array<[string, string]>) => void;

/** A file's text as lines: its own line break, its lines, whether it ends with a break (section 3). */
interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

function lineEq(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Positions where O occurs in lines at a tier, from `from` on; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  const k = o.length;
  if (k === 0) return out;
  for (let i = Math.max(0, from); i + k <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (!lineEq(tier, o[j]!, lines[i + j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs (only tier 0 with --strict), with its positions, or null (section 5). */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N that is not a context line, re-indented at tier 2 (section 5). */
function reindent(text: string, o: string[], fileLines: string[], at: number, tier: number): string {
  if (tier !== 2 || o.length === 0) return text;
  if (text === '' || /^[ \t]+$/.test(text)) return text;
  const p = leadingWs(o[0]!);
  const f = leadingWs(fileLines[at] ?? '');
  if (!text.startsWith(p)) return text;
  return f + text.slice(p.length);
}

/** A body line of a unified hunk or a V4A chunk: context, removed, added, or a `\` line. */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

/** O: the context and `-` lines of a body, in order. */
const oOf = (body: BodyLine[]): string[] => body.filter((b) => b.kind === ' ' || b.kind === '-').map((b) => b.text);

/** N: the context lines as the file's own matched lines, the `+` lines re-indented at tier 2. */
function nOf(body: BodyLine[], fileLines: string[], at: number, o: string[], tier: number): string[] {
  const out: string[] = [];
  let oi = 0;
  for (const b of body) {
    if (b.kind === '-') {
      oi++;
      continue;
    }
    if (b.kind === '\\') continue;
    if (b.kind === ' ') {
      out.push(fileLines[at + oi]!);
      oi++;
      continue;
    }
    out.push(reindent(b.text, o, fileLines, at, tier));
  }
  return out;
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

// ---- Unified diffs (section 6) ----

interface Hunk {
  a: number;
  body: BodyLine[];
  /** a `\` line follows the hunk's last context or `+` line */
  lastNoEol: boolean;
  /** a `\` line follows the hunk's last `+` line */
  plusNoEol: boolean;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** A `--- ` / `+++ ` path: text after the four characters, up to the first tab, trimmed, a/ or b/ removed, /dev/null as null. */
function dashPath(line: string): string | null {
  const raw = line.slice(4);
  const tab = raw.indexOf('\t');
  let p = (tab < 0 ? raw : raw.slice(0, tab)).trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p === '/dev/null' ? null : p;
}

function isDiffGit(line: string): boolean {
  return line === 'diff --git' || line.startsWith('diff --git ');
}

/** The hunk's body: lines after the header that start with ` `, `-`, `+` or `\`, or are empty; trailing empty lines dropped. */
function readBody(lines: string[], start: number): { items: BodyLine[]; next: number; lastNoEol: boolean; plusNoEol: boolean } {
  const raw: string[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (isDiffGit(l)) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      raw.push(l);
      j++;
      continue;
    }
    break;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const items: BodyLine[] = raw.map((l) => {
    if (l === '') return { kind: ' ' as const, text: '' };
    return { kind: l[0]! as ' ' | '-' | '+' | '\\', text: l.slice(1) };
  });
  let lastCtxPlus = -1;
  let lastPlus = -1;
  items.forEach((b, idx) => {
    if (b.kind === ' ' || b.kind === '+') lastCtxPlus = idx;
    if (b.kind === '+') lastPlus = idx;
  });
  return {
    items,
    next: j,
    lastNoEol: lastCtxPlus >= 0 && items[lastCtxPlus + 1]?.kind === '\\',
    plusNoEol: lastPlus >= 0 && items[lastPlus + 1]?.kind === '\\',
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let pairDone = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isDiffGit(line)) {
      const m = DIFF_GIT_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { oldPath: m[1]!, newPath: m[2]!, create: false, del: false, hunks: [] };
      sections.push(cur);
      pairDone = false;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0 && !pairDone) {
        cur.oldPath = dashPath(line);
        cur.newPath = dashPath(lines[i + 1]!);
        pairDone = true;
      } else {
        cur = { oldPath: dashPath(line), newPath: dashPath(lines[i + 1]!), create: false, del: false, hunks: [] };
        sections.push(cur);
        pairDone = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      const body = readBody(lines, i);
      i = body.next;
      cur.hunks.push({ a: Number(m[1]), body: body.items, lastNoEol: body.lastNoEol, plusNoEol: body.plusNoEol });
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) {
        if (!pairDone) cur.oldPath = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (!pairDone) cur.newPath = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.create = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.del = true;
      }
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => makeUniEdit(s, strict));
}

function applyUniHunk(state: FileState, h: Hunk, d: number, strict: boolean, path: string): FileState {
  const o = oOf(h.body);
  if (o.length === 0) {
    const n = h.body.filter((b) => b.kind === '+').map((b) => b.text);
    const idx = Math.min(Math.max(h.a + d, 0), state.lines.length);
    const lines = [...state.lines.slice(0, idx), ...n, ...state.lines.slice(idx)];
    let final = state.final;
    if (idx === state.lines.length) final = !h.plusNoEol;
    return { br: state.br, lines, final };
  }
  const found = findTier(state.lines, o, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let at = found.occ[0]!;
  let best = Math.abs(at - target);
  for (const pos of found.occ) {
    const dist = Math.abs(pos - target);
    if (dist < best) {
      best = dist;
      at = pos;
    }
  }
  const n = nOf(h.body, state.lines, at, o, found.tier);
  const lines = [...state.lines.slice(0, at), ...n, ...state.lines.slice(at + o.length)];
  let final = state.final;
  if (at + o.length === state.lines.length) final = !h.lastNoEol;
  return { br: state.br, lines, final };
}

function makeUniEdit(sec: UniSection, strict: boolean): Edit {
  return (tree, moves) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = sec.create || oldP === null;
    const isDelete = !isCreate && (sec.del || newP === null);
    if (isCreate) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus = sec.hunks.flatMap((h) => h.body.filter((b) => b.kind === '+').map((b) => b.text));
      let final = true;
      for (let k = sec.hunks.length - 1; k >= 0; k--) {
        if (sec.hunks[k]!.body.some((b) => b.kind === '+')) {
          final = !sec.hunks[k]!.plusNoEol;
          break;
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const isMove = oldP !== null && newP !== null && oldP !== newP;
    const target = oldP!;
    const cur = tree.get(target);
    if (cur === null) throw new Fail('missing', target);
    if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    let state = parseFile(cur);
    let d = 0;
    for (const h of sec.hunks) {
      state = applyUniHunk(state, h, d, strict, target);
      d += h.body.filter((b) => b.kind === '+').length - h.body.filter((b) => b.kind === '-').length;
    }
    const out = renderFile(state);
    if (isMove) {
      tree.now.set(target, null);
      tree.now.set(newP!, out);
      moves.push([target, newP!]);
    } else {
      tree.now.set(target, out);
    }
  };
}

// ---- SEARCH/REPLACE blocks (section 7) ----

function makeSREdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const st = parseFile(cur);
    const found = findTier(st.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const n = newLines.map((t) => reindent(t, oldLines, st.lines, at, found.tier));
    const lines = [...st.lines.slice(0, at), ...n, ...st.lines.slice(at + oldLines.length)];
    tree.now.set(path, renderFile({ br: st.br, lines, final: st.final }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(makeSREdit(path, lines.slice(i + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

// ---- V4A patches (section 8) ----

interface V4aChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function applyV4aChunk(state: FileState, ch: V4aChunk, cursor: number, strict: boolean, path: string): { state: FileState; cursor: number } {
  let cur = cursor;
  if (ch.anchor !== null) {
    let foundAt = -1;
    const top = strict ? 0 : 2;
    for (let t = 0; t <= top && foundAt < 0; t++) {
      for (let i = cur; i < state.lines.length; i++) {
        if (lineEq(t, ch.anchor, state.lines[i]!)) {
          foundAt = i;
          break;
        }
      }
    }
    if (foundAt < 0) throw new Fail('no-match', path);
    cur = foundAt + 1;
  }
  const o = oOf(ch.body);
  if (o.length === 0) {
    const n = ch.body.filter((b) => b.kind === '+').map((b) => b.text);
    const idx = ch.eof ? state.lines.length : cur;
    const lines = [...state.lines.slice(0, idx), ...n, ...state.lines.slice(idx)];
    return { state: { br: state.br, lines, final: state.final }, cursor: idx + n.length };
  }
  const found = findTier(state.lines, o, strict, cur);
  if (found === null) throw new Fail('no-match', path);
  let at = -1;
  for (const pos of found.occ) {
    if (ch.eof && pos + o.length !== state.lines.length) continue;
    at = pos;
    break;
  }
  if (at < 0) throw new Fail('no-match', path);
  const n = nOf(ch.body, state.lines, at, o, found.tier);
  const lines = [...state.lines.slice(0, at), ...n, ...state.lines.slice(at + o.length)];
  return { state: { br: state.br, lines, final: state.final }, cursor: at + n.length };
}

/** Parse one V4A section's lines into its edit; structural faults are parse errors. */
function makeV4aEdit(kind: 'add' | 'delete' | 'update', path: string, headerLine: number, raw: Array<{ text: string; num: number }>, strict: boolean): Edit {
  if (kind === 'add') {
    const addLines: string[] = [];
    for (const item of raw) {
      if (item.text === '') addLines.push('');
      else if (item.text[0] === '+') addLines.push(item.text.slice(1));
      else throw new Exit2(`error: parse ${item.num}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    for (const item of raw) {
      if (item.text.trim() !== '') throw new Exit2(`error: parse ${item.num}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let moveTo: string | null = null;
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let firstLine = true;
  for (const item of raw) {
    const l = item.text;
    if (firstLine && l.startsWith('*** Move to:')) {
      moveTo = l.slice('*** Move to:'.length).trim();
      firstLine = false;
      continue;
    }
    firstLine = false;
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      chunks.push(cur);
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${item.num}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length === 0) {
          cur = { anchor: null, body: [], eof: false };
          chunks.push(cur);
        } else {
          throw new Exit2(`error: parse ${item.num}`);
        }
      }
      cur.body.push(l === '' ? { kind: ' ', text: '' } : { kind: l[0]! as ' ' | '-' | '+', text: l.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${item.num}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return (tree, moves) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let state = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      const r = applyV4aChunk(state, ch, cursor, strict, path);
      state = r.state;
      cursor = r.cursor;
    }
    const out = renderFile(state);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let j = first + 1;
  while (j < last) {
    const line = lines[j]!;
    if (blank(line)) {
      j++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File:')) {
      kind = 'add';
      path = line.slice('*** Add File:'.length).trim();
    } else if (line.startsWith('*** Delete File:')) {
      kind = 'delete';
      path = line.slice('*** Delete File:'.length).trim();
    } else if (line.startsWith('*** Update File:')) {
      kind = 'update';
      path = line.slice('*** Update File:'.length).trim();
    } else {
      throw new Exit2(`error: parse ${j + 1}`);
    }
    const headerLine = j + 1;
    j++;
    const raw: Array<{ text: string; num: number }> = [];
    while (j < last) {
      const l = lines[j]!;
      if (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:')) break;
      raw.push({ text: l, num: j + 1 });
      j++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    edits.push(makeV4aEdit(kind, path, headerLine, raw, strict));
  }
  return edits;
}

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Array<[string, string]> = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].sort(byteCmp);
  const rows: Array<{ key: string; text: string }> = [];
  const dSet = new Set<string>();
  const aSet = new Set<string>();
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null) aSet.add(p);
    if (now === null) dSet.add(p);
  }
  const covered = new Set<string>();
  for (const [oldP, newP] of moves) {
    if (dSet.has(oldP) && aSet.has(newP) && !covered.has(oldP) && !covered.has(newP)) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of changed) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => byteCmp(x.key, y.key));
  if (!check) {
    for (const p of changed) {
      if (tree.now.get(p) === null && tree.original(p) !== null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null || tree.original(p) === now) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
