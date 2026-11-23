// main.ts is mend, the CLI SPEC.md specifies: it applies edits AI models write, in four formats, to a tree of
// text files. It does all ten sections of SPEC.md: the command line, the output and exit codes, safe paths,
// format detection, line matching at three tiers (section 5), unified diffs (section 6), SEARCH/REPLACE blocks
// (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing write (section 10).
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move edits that succeeded, as (old, new) pairs, for the `R` output lines. */
  readonly moves: { old: string; nw: string }[] = [];
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

// ---------------------------------------------------------------------------
// Section 5: matching lines, and files as lines (section 3).
// ---------------------------------------------------------------------------

/** A file's text as lines, its line break, and whether it ends with one. */
interface ParsedFile {
  lines: string[];
  br: string;
  finalBr: boolean;
}

function parseFile(text: string): ParsedFile {
  if (text === '') return { lines: [], br: '\n', finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { lines: parts, br, finalBr };
}

function renderFile(f: ParsedFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBr ? f.br : '');
}

const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** Whether two lines are equal at a tier: 0 exact, 1 trailing spaces/tabs off, 2 both sides off. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWS(a) === trimEndWS(b);
  return trimWS(a) === trimWS(b);
}

/** 0-based positions at which O occurs in lines at a tier, searching from `from`. */
function findOccurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * The first tier at which O occurs at or after `from`, with its positions; null when none.
 * With `eofOnly`, only occurrences ending at the file's last line count.
 */
function firstTierWith(O: string[], lines: string[], from: number, strict: boolean, eofOnly: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = findOccurrences(O, lines, t, from).filter((p) => !eofOnly || p + O.length === lines.length);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** One body line of a hunk or chunk: context, old, new, or a `\` marker line. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'mark';
  text: string;
}

/**
 * Split a hunk/chunk body into old lines O and new lines N. `nCtx[j]` is the index into O of N[j]
 * when N[j] is a context line, and -1 when it is a `+` line.
 */
function splitON(body: BodyLine[]): { O: string[]; N: string[]; nCtx: number[] } {
  const O: string[] = [];
  const N: string[] = [];
  const nCtx: number[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      nCtx.push(O.length);
      O.push(b.text);
      N.push(b.text);
    } else if (b.kind === 'old') {
      O.push(b.text);
    } else if (b.kind === 'new') {
      nCtx.push(-1);
      N.push(b.text);
    }
  }
  return { O, N, nCtx };
}

/**
 * Replace lines[pos .. pos + O.length) with N. A context line is written as the file's own matched line;
 * at tier 2 every other line of N is re-indented from O's first line's leading whitespace to the file's.
 */
function applyONAt(lines: string[], pos: number, O: string[], N: string[], nCtx: number[], tier: number): string[] {
  const F = pos < lines.length ? leadWS(lines[pos]!) : '';
  const P = O.length > 0 ? leadWS(O[0]!) : '';
  const out = N.map((t, j) => {
    const oi = nCtx[j]!;
    if (oi >= 0) return lines[pos + oi]!;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) return F + t.slice(P.length);
    return t;
  });
  return [...lines.slice(0, pos), ...out, ...lines.slice(pos + O.length)];
}

/** Whether a `\` line follows the body's last context or `+` line. */
function backslashAfterLastCtxPlus(body: BodyLine[]): boolean {
  let last = -1;
  body.forEach((b, i) => {
    if (b.kind === 'ctx' || b.kind === 'new') last = i;
  });
  if (last < 0) return false;
  const next = body[last + 1];
  return next !== undefined && next.kind === 'mark';
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface Hunk {
  /** The -A start line of the hunk header (1-based in the old file). */
  a: number;
  body: BodyLine[];
}

interface UniSection {
  /** Null means /dev/null: no file. */
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` / `+++ ` line: text after the four characters, to the first tab, trimmed. */
function uniPath(l: string): string | null {
  let t = l.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function isDiffGitLine(l: string): boolean {
  return l === 'diff --git' || l.startsWith('diff --git ');
}

/** Parse a `diff --git a/<X> b/<Y>` line, or null when it is not of that form. */
function parseDiffGit(l: string): { old: string; nw: string } | null {
  const rest = l.slice('diff --git'.length);
  if (!rest.startsWith(' ')) return null;
  const body = rest.slice(1).trimEnd();
  if (!body.startsWith('a/')) return null;
  const idx = body.indexOf(' b/');
  if (idx < 0) return null;
  const old = body.slice(2, idx);
  const nw = body.slice(idx + 3);
  if (old === '' || nw === '') return null;
  return { old, nw };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse a hunk header line, or throw the parse error for its line. */
function parseHunkHeader(l: string, idx: number): { a: number } {
  const m = HUNK_RE.exec(l);
  if (m === null) throw new Exit2(`error: parse ${idx + 1}`);
  return { a: parseInt(m[1]!, 10) };
}

/** Consume a hunk body starting at `start` (the line after the header); trailing empty lines are dropped. */
function consumeHunkBody(lines: string[], start: number): { body: BodyLine[]; next: number } {
  const raw: string[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && j + 1 < lines.length && lines[j + 1]!.startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      raw.push(l);
      j += 1;
      continue;
    }
    break;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const body: BodyLine[] = raw.map((l) => {
    if (l === '') return { kind: 'ctx' as const, text: '' };
    if (l[0] === ' ') return { kind: 'ctx' as const, text: l.slice(1) };
    if (l[0] === '-') return { kind: 'old' as const, text: l.slice(1) };
    if (l[0] === '+') return { kind: 'new' as const, text: l.slice(1) };
    return { kind: 'mark' as const, text: l.slice(1) };
  });
  return { body, next: j };
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  // Header bookkeeping for the current section, until its first hunk.
  let inHeader = false;
  let headerPair = false;
  let pairOld: string | null | undefined;
  let pairNew: string | null | undefined;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let diffOld: string | null = null;
  let diffNew: string | null = null;

  const finishSection = (): void => {
    if (cur === null) return;
    if (pairOld !== undefined) cur.oldPath = pairOld;
    else if (renameFrom !== null) cur.oldPath = renameFrom;
    else if (diffOld !== null) cur.oldPath = diffOld;
    if (pairNew !== undefined) cur.newPath = pairNew;
    else if (renameTo !== null) cur.newPath = renameTo;
    else if (diffNew !== null) cur.newPath = diffNew;
  };

  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (isDiffGitLine(l)) {
      const p = parseDiffGit(l);
      if (p === null) throw new Exit2(`error: parse ${i + 1}`);
      finishSection();
      cur = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      headerPair = false;
      pairOld = undefined;
      pairNew = undefined;
      renameFrom = null;
      renameTo = null;
      diffOld = p.old;
      diffNew = p.nw;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) {
      if (cur !== null && inHeader && !headerPair) {
        pairOld = uniPath(l);
        pairNew = uniPath(lines[i + 1]!);
        headerPair = true;
        i += 2;
        continue;
      }
      finishSection();
      cur = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      headerPair = true;
      pairOld = uniPath(l);
      pairNew = uniPath(lines[i + 1]!);
      renameFrom = null;
      renameTo = null;
      diffOld = null;
      diffNew = null;
      i += 2;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) {
        renameFrom = l.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        renameTo = l.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      // A header line names the mode only as the exact phrase, followed by a space or the end
      // of the line: a longer word such as `new file modeXYZ` is any other line, ignored.
      if (l === 'new file mode' || l.startsWith('new file mode ')) {
        cur.isCreate = true;
        i += 1;
        continue;
      }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        cur.isDelete = true;
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) {
        const h = parseHunkHeader(l, i);
        const { body, next } = consumeHunkBody(lines, i + 1);
        cur.hunks.push({ a: h.a, body });
        inHeader = false;
        i = next;
        continue;
      }
      i += 1;
      continue;
    }
    // Between hunks: a new hunk, or an ignored line.
    if (l.startsWith('@@')) {
      const h = parseHunkHeader(l, i);
      const { body, next } = consumeHunkBody(lines, i + 1);
      cur.hunks.push({ a: h.a, body });
      i = next;
      continue;
    }
    i += 1;
  }
  finishSection();
  return sections;
}

/** Apply a section's hunks in order to a file's text; throws Fail on the first failing hunk. */
function applyHunks(content: string, hunks: Hunk[], strict: boolean, path: string): string {
  let f = parseFile(content);
  let d = 0;
  for (const h of hunks) {
    const { O, N, nCtx } = splitON(h.body);
    if (O.length === 0) {
      const pos = Math.max(0, Math.min(f.lines.length, h.a + d));
      const atEnd = pos === f.lines.length;
      const lines = [...f.lines.slice(0, pos), ...N, ...f.lines.slice(pos)];
      let finalBr = f.finalBr;
      if (atEnd) finalBr = !backslashAfterLastCtxPlus(h.body);
      f = { lines, br: f.br, finalBr };
      d += N.length;
      continue;
    }
    const found = firstTierWith(O, f.lines, 0, strict, false);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.positions[0]!;
    for (const p of found.positions) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const runsToEnd = best + O.length === f.lines.length;
    const lines = applyONAt(f.lines, best, O, N, nCtx, found.tier);
    let finalBr = f.finalBr;
    if (runsToEnd) finalBr = !backslashAfterLastCtxPlus(h.body);
    f = { lines, br: f.br, finalBr };
    d += N.length - O.length;
  }
  return renderFile(f);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((sec) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = oldP === null || sec.isCreate;
    const isDelete = newP === null || sec.isDelete;
    return (tree: Tree) => {
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
      if (isCreate) {
        const p = newP;
        if (p === null) return; // creating /dev/null names no file
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        let lastPlus: { hunk: Hunk; idx: number } | null = null;
        for (const h of sec.hunks) {
          h.body.forEach((b, bi) => {
            if (b.kind === 'new') {
              plus.push(b.text);
              lastPlus = { hunk: h, idx: bi };
            }
          });
        }
        let finalBr = true;
        if (lastPlus !== null) {
          const next = lastPlus.hunk.body[lastPlus.idx + 1];
          if (next !== undefined && next.kind === 'mark') finalBr = false;
        }
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (finalBr ? '\n' : ''));
        return;
      }
      if (isDelete) {
        const p = oldP;
        if (p === null) return; // deleting /dev/null names no file
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      if (oldP !== null && newP !== null && oldP !== newP) {
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const result = applyHunks(tree.get(oldP)!, sec.hunks, strict, oldP);
        tree.now.set(oldP, null);
        tree.now.set(newP, result);
        tree.moves.push({ old: oldP, nw: newP });
        return;
      }
      const p = (oldP ?? newP)!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, applyHunks(tree.get(p)!, sec.hunks, strict, p));
    };
  });
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return blocks;
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  return parseSearchReplace(lines).map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const content = tree.get(b.path);
    if (content === null) throw new Fail('missing', b.path);
    const f = parseFile(content);
    const found = firstTierWith(b.oldLines, f.lines, 0, strict, false);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.positions[0]!;
    const nCtx = b.newLines.map(() => -1);
    f.lines = applyONAt(f.lines, pos, b.oldLines, b.newLines, nCtx, found.tier);
    tree.now.set(b.path, renderFile(f));
  });
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface VLine {
  text: string;
  no: number;
}

interface VChunk {
  /** Null when the chunk has no anchor (an empty `@@` text is no anchor). */
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lineNo: number;
  lines: VLine[];
  chunks: VChunk[];
}

const V_ADD = '*** Add File: ';
const V_DELETE = '*** Delete File: ';
const V_UPDATE = '*** Update File: ';
const V_MOVE_TO = '*** Move to: ';

function parseV4A(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: { kind: 'add' | 'delete' | 'update'; path: string; lineNo: number; lines: VLine[] } | null = null;
  const flush = (): void => {
    if (cur === null) return;
    while (cur.lines.length > 0 && blank(cur.lines[cur.lines.length - 1]!.text)) cur.lines.pop();
    sections.push({ kind: cur.kind, path: cur.path, moveTo: null, lineNo: cur.lineNo, lines: cur.lines, chunks: [] });
    cur = null;
  };
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (l.startsWith(V_ADD) || l.startsWith(V_DELETE) || l.startsWith(V_UPDATE)) {
      flush();
      const kind = l.startsWith(V_ADD) ? 'add' : l.startsWith(V_DELETE) ? 'delete' : 'update';
      const prefix = kind === 'add' ? V_ADD : kind === 'delete' ? V_DELETE : V_UPDATE;
      cur = { kind, path: l.slice(prefix.length).trim(), lineNo: i + 1, lines: [] };
      i += 1;
      continue;
    }
    if (cur === null) {
      if (blank(l)) {
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    cur.lines.push({ text: l, no: i + 1 });
    i += 1;
  }
  flush();
  // Validate each section's lines and split Update sections into chunks.
  for (const sec of sections) {
    if (sec.kind === 'add') {
      for (const l of sec.lines) {
        if (l.text !== '' && !l.text.startsWith('+')) throw new Exit2(`error: parse ${l.no}`);
      }
    } else if (sec.kind === 'delete') {
      for (const l of sec.lines) {
        if (!blank(l.text)) throw new Exit2(`error: parse ${l.no}`);
      }
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (sec.lines.length > 0 && sec.lines[0]!.text.startsWith(V_MOVE_TO)) {
        moveTo = sec.lines[0]!.text.slice(V_MOVE_TO.length).trim();
        idx = 1;
      }
      sec.moveTo = moveTo;
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      for (; idx < sec.lines.length; idx++) {
        const l = sec.lines[idx]!;
        if (l.text.startsWith('@@')) {
          const anchorText = l.text.slice(2).trim();
          curChunk = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
          chunks.push(curChunk);
          continue;
        }
        if (l.text === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${l.no}`);
          curChunk.eof = true;
          curChunk = null;
          continue;
        }
        if (l.text === '' || l.text[0] === ' ' || l.text[0] === '-' || l.text[0] === '+') {
          if (curChunk === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${l.no}`);
            curChunk = { anchor: null, eof: false, body: [] };
            chunks.push(curChunk);
          }
          const t = l.text;
          curChunk.body.push(
            t === '' ? { kind: 'ctx', text: '' }
            : t[0] === ' ' ? { kind: 'ctx', text: t.slice(1) }
            : t[0] === '-' ? { kind: 'old', text: t.slice(1) }
            : { kind: 'new', text: t.slice(1) },
          );
          continue;
        }
        throw new Exit2(`error: parse ${l.no}`);
      }
      sec.chunks = chunks;
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
    }
  }
  return sections;
}

/** The first line at or after `from` equal to the anchor at the first tier where one is; -1 when none. */
function findAnchorLine(lines: string[], from: number, anchor: string, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(anchor, lines[i]!, t)) return i;
    }
  }
  return -1;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return parseV4A(lines).map((sec) => (tree: Tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      const fileLines = sec.lines.map((l) => (l.text === '' ? '' : l.text.slice(1)));
      tree.now.set(sec.path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const content = tree.get(sec.path);
    if (content === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    let f = parseFile(content);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const at = findAnchorLine(f.lines, cursor, ch.anchor, strict);
        if (at < 0) throw new Fail('no-match', sec.path);
        cursor = at + 1;
      }
      const { O, N, nCtx } = splitON(ch.body);
      if (O.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        f = { ...f, lines: [...f.lines.slice(0, pos), ...N, ...f.lines.slice(pos)] };
        cursor = pos + N.length;
        continue;
      }
      const found = firstTierWith(O, f.lines, cursor, strict, ch.eof);
      if (found === null) throw new Fail('no-match', sec.path);
      const pos = found.positions[0]!;
      f = { ...f, lines: applyONAt(f.lines, pos, O, N, nCtx, found.tier) };
      cursor = pos + N.length;
    }
    const result = renderFile(f);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, result);
      tree.moves.push({ old: sec.path, nw: sec.moveTo });
    } else {
      tree.now.set(sec.path, result);
    }
  });
}

// ---------------------------------------------------------------------------
// Section 1, 2 and 10: the command line, the output and exit codes, the write.
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
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: one per path whose state changed, in byte order; a move whose old path existed before
  // and does not after, and whose new path did not exist before and does after, is one `R` line sorting
  // by its new path instead of the pair's `D` and `A` lines.
  const rows: { sort: string; text: string }[] = [];
  const inR = new Set<string>();
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.nw) === null && tree.get(m.nw) !== null) {
      rows.push({ sort: m.nw, text: `R ${m.old} -> ${m.nw}` });
      inR.add(m.old);
      inR.add(m.nw);
    }
  }
  for (const p of tree.now.keys()) {
    if (inR.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ sort: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sort, 'utf8'), Buffer.from(b.sort, 'utf8')));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
