// main.ts is mend, the CLI SPEC.md specifies: it reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none, printing what it changed or why it failed.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

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

/** A text file as its lines, its own line break, and whether it ends with one (SPEC.md section 3). */
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

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

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
  /** True when the path holds a file in the tree, or anything at all on disk. */
  exists(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  }
}

type Edit = (tree: Tree) => void;

/** Moves a patch performed, in order, for the `R old -> new` output lines (SPEC.md section 2). */
const moves: { old: string; new: string }[] = [];
function recordMove(oldP: string, newP: string): void {
  moves.push({ old: oldP, new: newP });
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

// ---------------------------------------------------------------------------
// Matching lines (SPEC.md section 5)
// ---------------------------------------------------------------------------

type Tier = 0 | 1 | 2;

function lineEq(tier: Tier, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return a.replace(/[ \t]+$/, '') === b.replace(/[ \t]+$/, '');
  return a.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') === b.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position at or after `from` where O's lines match the file's lines at `tier`. */
function occurrences(lines: string[], o: string[], tier: Tier, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(tier, o[j]!, lines[i + j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once at or after `from` (null when it occurs nowhere). */
function firstTier(lines: string[], o: string[], strict: boolean, from: number): Tier | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    if (occurrences(lines, o, t, from).length > 0) return t;
  }
  return null;
}

/** One hunk (unified) or chunk (V4A): old lines O, new lines N, and for each line of N the index
 * into O when it is a context line, or null when it is a `+` line. */
interface Hunk {
  /** Unified old start A (1-based); 0 when the format has none. */
  a: number;
  o: string[];
  n: string[];
  ctx: (number | null)[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
}

/** The lines N writes when O matched at `pos`: a context line is the file's own matched line, and
 * at tier 2 every other line is re-indented from O's first line's leading whitespace to the file's. */
function buildReplacement(file: FileState, h: Hunk, pos: number, tier: Tier): string[] {
  const f = h.o.length > 0 ? leadingWs(file.lines[pos]!) : '';
  const p = h.o.length > 0 ? leadingWs(h.o[0]!) : '';
  const out: string[] = [];
  for (let k = 0; k < h.n.length; k++) {
    const cj = h.ctx[k]!;
    if (cj !== null) {
      out.push(file.lines[pos + cj]!);
      continue;
    }
    let line = h.n[k]!;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(p)) line = f + line.slice(p.length);
    out.push(line);
  }
  return out;
}

/** Apply unified hunks in order to a file, tracking the running offset d (SPEC.md section 6). */
function applyHunks(f: FileState, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, f.lines.length));
      const atEnd = pos === f.lines.length;
      const rep = buildReplacement(f, h, pos, 0);
      f.lines.splice(pos, 0, ...rep);
      if (atEnd) f.final = !h.noEol;
      d += h.n.length;
      continue;
    }
    const tier = firstTier(f.lines, h.o, strict, 0);
    if (tier === null) throw new Fail('no-match', path);
    const occ = occurrences(f.lines, h.o, tier, 0);
    const target = h.a - 1 + d;
    let best = occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const o of occ) {
      const dist = Math.abs(o - target);
      if (dist < bestDist) {
        best = o;
        bestDist = dist;
      }
    }
    const runsToEnd = best + h.o.length === f.lines.length;
    const rep = buildReplacement(f, h, best, tier);
    f.lines.splice(best, h.o.length, ...rep);
    if (runsToEnd) f.final = !h.noEol;
    d += h.n.length - h.o.length;
  }
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

/** The path a `--- ` or `+++ ` line names (null for `/dev/null`), after the four characters,
 * up to the first tab, with surrounding spaces removed and a leading `a/` or `b/` removed. */
function diffPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** The body of one hunk: its lines, with trailing empty lines removed (they are not part of it). */
interface HunkExt extends Hunk {
  /** A `\` line follows the hunk's last `+` line. */
  plusNoEol: boolean;
}

function hunkBody(body: string[], a: number): HunkExt {
  const o: string[] = [];
  const n: string[] = [];
  const ctx: (number | null)[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l === '') {
      o.push('');
      n.push('');
      ctx.push(o.length - 1);
      lastCtxPlus = k;
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      o.push(t);
      n.push(t);
      ctx.push(o.length - 1);
      lastCtxPlus = k;
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push(l.slice(1));
      ctx.push(null);
      lastCtxPlus = k;
      lastPlus = k;
    }
    // a `\` line refers to the body line before it and adds no line of its own
  }
  const follows = (k: number): boolean => k >= 0 && body[k + 1] !== undefined && body[k + 1]![0] === '\\';
  return { a, o, n, ctx, noEol: follows(lastCtxPlus), plusNoEol: follows(lastPlus) };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  interface Draft {
    gitOld: string | null;
    gitNew: string | null;
    hdrOld: string | null | undefined;
    hdrNew: string | null | undefined;
    renameFrom: string | undefined;
    renameTo: string | undefined;
    isCreate: boolean;
    isDelete: boolean;
    hunks: HunkExt[];
  }
  const drafts: Draft[] = [];
  let cur: Draft | null = null;
  let inHeader = false;
  let i = 0;
  const newDraft = (gitOld: string | null, gitNew: string | null): Draft => {
    const d: Draft = {
      gitOld,
      gitNew,
      hdrOld: undefined,
      hdrNew: undefined,
      renameFrom: undefined,
      renameTo: undefined,
      isCreate: false,
      isDelete: false,
      hunks: [],
    };
    drafts.push(d);
    return d;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      // The form is `diff --git a/<X> b/<Y>`: an empty <X> or <Y> is not a path, so the
      // line is not of the form above and is a parse error at its own line (SPEC.md section 6).
      if (m === null || m[1]!.trim() === '' || m[2]!.trim() === '') throw new Exit2(`error: parse ${i + 1}`);
      const go = m[1]!.trim();
      const gn = m[2]!.trim();
      cur = newDraft(go === '/dev/null' ? null : go, gn === '/dev/null' ? null : gn);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
          body.push(l);
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const h = hunkBody(body, Number(hm[1]));
      cur.hunks.push(h);
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader && line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next === undefined || !next.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      cur.hdrOld = diffPath(line);
      cur.hdrNew = diffPath(next);
      i += 2;
      continue;
    }
    if (!inHeader && line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = newDraft(null, null);
      cur.hdrOld = diffPath(line);
      cur.hdrNew = diffPath(lines[i + 1]!);
      inHeader = true;
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('+++ ')) cur.hdrNew = diffPath(line);
      else if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line === 'new file mode' || line.startsWith('new file mode ')) cur.isCreate = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) cur.isDelete = true;
      // every other header line is ignored
      i++;
      continue;
    }
    // outside bodies, lines that are not part of a section header are ignored
    i++;
  }
  if (drafts.length === 0) throw new Exit2('error: parse 1');
  return drafts.map((d) => {
    const oldPath = d.hdrOld !== undefined ? d.hdrOld : d.renameFrom !== undefined ? d.renameFrom : d.gitOld;
    const newPath = d.hdrNew !== undefined ? d.hdrNew : d.renameTo !== undefined ? d.renameTo : d.gitNew;
    const hunks = d.hunks;
    const isCreate = d.isCreate;
    const isDelete = d.isDelete;
    return (tree: Tree): void => {
      if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
      if (oldPath === null || isCreate) {
        if (newPath === null) throw new Fail('unsafe', '/dev/null');
        if (tree.exists(newPath)) throw new Fail('exists', newPath);
        const plusLines: string[] = [];
        let plusNoEol = false;
        let hasPlus = false;
        for (const h of hunks) {
          let hHasPlus = false;
          for (let k = 0; k < h.n.length; k++) {
            if (h.ctx[k] === null) {
              plusLines.push(h.n[k]!);
              hHasPlus = true;
            }
          }
          if (hHasPlus) {
            hasPlus = true;
            plusNoEol = h.plusNoEol;
          }
        }
        const final = hasPlus ? !plusNoEol : true;
        tree.now.set(newPath, plusLines.length === 0 ? '' : plusLines.join('\n') + (final ? '\n' : ''));
        return;
      }
      if (newPath === null || isDelete) {
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
        return;
      }
      if (oldPath !== newPath) {
        const curText = tree.get(oldPath);
        if (curText === null) throw new Fail('missing', oldPath);
        if (tree.exists(newPath)) throw new Fail('exists', newPath);
        const f = splitFile(curText);
        applyHunks(f, hunks, strict, oldPath);
        tree.now.set(newPath, joinFile(f));
        tree.now.set(oldPath, null);
        recordMove(oldPath, newPath);
        return;
      }
      const curText = tree.get(oldPath);
      if (curText === null) throw new Fail('missing', oldPath);
      const f = splitFile(curText);
      applyHunks(f, hunks, strict, oldPath);
      tree.now.set(oldPath, joinFile(f));
    };
  });
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.exists(path)) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = splitFile(cur);
    const tier = firstTier(f.lines, oldLines, strict, 0);
    if (tier === null) throw new Fail('no-match', path);
    const occ = occurrences(f.lines, oldLines, tier, 0);
    if (occ.length !== 1) throw new Fail('ambiguous', path);
    const pos = occ[0]!;
    const h: Hunk = { a: 0, o: oldLines, n: newLines, ctx: newLines.map(() => null), noEol: false };
    const rep = buildReplacement(f, h, pos, tier);
    f.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, joinFile(f));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (sep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    edits.push(srEdit(path, lines.slice(searchLine + 1, sep), lines.slice(sep + 1, rep), strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

function isV4aSectionStart(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.exists(path)) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: string[];
  ctx: (number | null)[];
}

function parseVChunkBody(body: string[], anchor: string | null, eof: boolean): VChunk {
  const o: string[] = [];
  const n: string[] = [];
  const ctx: (number | null)[] = [];
  for (const l of body) {
    if (l === '') {
      o.push('');
      n.push('');
      ctx.push(o.length - 1);
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      o.push(t);
      n.push(t);
      ctx.push(o.length - 1);
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push(l.slice(1));
      ctx.push(null);
    }
  }
  return { anchor: anchor === '' ? null : anchor, eof, o, n, ctx };
}

function v4aUpdateEdit(path: string, secLines: string[], secStart: number, updateLineNo: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (secLines.length > 0 && secLines[0]!.startsWith('*** Move to: ')) {
    moveTo = secLines[0]!.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: { anchor: string | null; eof: boolean; body: string[] } | null = null;
  const flush = (): void => {
    if (cur !== null) {
      chunks.push(parseVChunkBody(cur.body, cur.anchor, cur.eof));
      cur = null;
    }
  };
  for (; idx < secLines.length; idx++) {
    const l = secLines[idx]!;
    const lineNo = secStart + idx + 1;
    if (l.startsWith('@@')) {
      flush();
      cur = { anchor: l.slice(2).trim(), eof: false, body: [] };
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      cur.eof = true;
      flush();
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length === 0) cur = { anchor: null, eof: false, body: [] };
        else throw new Exit2(`error: parse ${lineNo}`);
      }
      cur.body.push(l);
      continue;
    }
    throw new Exit2(`error: parse ${lineNo}`);
  }
  flush();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.exists(moveTo)) throw new Fail('exists', moveTo);
    const f = splitFile(curText);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const tiers: Tier[] = strict ? [0] : [0, 1, 2];
        let tier: Tier | null = null;
        for (const t of tiers) {
          let found = false;
          for (let k = cursor; k < f.lines.length; k++) {
            if (lineEq(t, ch.anchor, f.lines[k]!)) {
              found = true;
              break;
            }
          }
          if (found) {
            tier = t;
            break;
          }
        }
        if (tier === null) throw new Fail('no-match', path);
        let ai = -1;
        for (let k = cursor; k < f.lines.length; k++) {
          if (lineEq(tier, ch.anchor, f.lines[k]!)) {
            ai = k;
            break;
          }
        }
        cursor = ai + 1;
      }
      if (ch.o.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        const h: Hunk = { a: 0, o: [], n: ch.n, ctx: ch.ctx, noEol: false };
        const rep = buildReplacement(f, h, pos, 0);
        f.lines.splice(pos, 0, ...rep);
        cursor = pos + rep.length;
        continue;
      }
      const tier = firstTier(f.lines, ch.o, strict, cursor);
      if (tier === null) throw new Fail('no-match', path);
      const occ = occurrences(f.lines, ch.o, tier, cursor);
      let pos = -1;
      for (const o of occ) {
        if (ch.eof && o + ch.o.length !== f.lines.length) continue;
        pos = o;
        break;
      }
      if (pos === -1) throw new Fail('no-match', path);
      const h: Hunk = { a: 0, o: ch.o, n: ch.n, ctx: ch.ctx, noEol: false };
      const rep = buildReplacement(f, h, pos, tier);
      f.lines.splice(pos, ch.o.length, ...rep);
      cursor = pos + rep.length;
    }
    const text = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      recordMove(path, moveTo);
    } else {
      tree.now.set(path, text);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (isV4aSectionStart(line)) {
      const kind = line.startsWith('*** Add') ? 'add' : line.startsWith('*** Delete') ? 'delete' : 'update';
      const marker = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
      const path = line.slice(marker.length).trim();
      let end = i + 1;
      while (end < last && !isV4aSectionStart(lines[end]!)) end++;
      let e = end;
      while (e > i + 1 && blank(lines[e - 1]!)) e--;
      const secLines = lines.slice(i + 1, e);
      const secStart = i + 1;
      if (kind === 'add') {
        const fileLines: string[] = [];
        for (let k = 0; k < secLines.length; k++) {
          const l = secLines[k]!;
          if (l.startsWith('+')) fileLines.push(l.slice(1));
          else if (l === '') fileLines.push('');
          else throw new Exit2(`error: parse ${secStart + k + 1}`);
        }
        edits.push(v4aAddEdit(path, fileLines));
      } else if (kind === 'delete') {
        for (let k = 0; k < secLines.length; k++) {
          if (!blank(secLines[k]!)) throw new Exit2(`error: parse ${secStart + k + 1}`);
        }
        edits.push(v4aDeleteEdit(path));
      } else {
        edits.push(v4aUpdateEdit(path, secLines, secStart, i + 1, strict));
      }
      i = end;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

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
// Output and invocation (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function computeRows(tree: Tree): string[] {
  const covered = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const m of moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.get(m.old);
    const wasNew = tree.original(m.new);
    const nowNew = tree.get(m.new);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
      covered.add(m.old);
      covered.add(m.new);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: was === null ? `A ${p}` : now === null ? `D ${p}` : `M ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  return rows.map((r) => r.text);
}

function writeTree(tree: Tree): void {
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.push(p);
  }
  changed.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  for (const p of changed) {
    if (tree.now.get(p) === null) {
      try {
        rmSync(p, { force: true });
      } catch {
        // a path the tree says is gone: leave the disk as it is
      }
    }
  }
  for (const p of changed) {
    const now = tree.now.get(p)!;
    if (now === null) continue;
    try {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    } catch {
      // a path the tree cannot write: leave the disk as it is
    }
  }
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
  moves.length = 0;
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0)
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows = computeRows(tree);
  if (!check) writeTree(tree);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
