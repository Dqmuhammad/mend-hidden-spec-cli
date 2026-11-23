// main.ts is mend, the CLI SPEC.md specifies (kit starter, MIT). It does sections 1 to 10 of SPEC.md: the command
// line, the output and exit codes, safe paths, format detection, JSON edits, the all-or-nothing write, line matching
// at three tiers (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7) and V4A patches
// (section 8). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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
  /** Successful moves, in order: [old, new]. Used only to render `R` output lines. */
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

/* ------------------------------------------------------------------ */
/* Files as lines (SPEC.md section 3) and matching lines (section 5)  */
/* ------------------------------------------------------------------ */

interface FileModel {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** Leading spaces and tabs of a line. */
function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** All 0-based positions i >= from where O matches lines[i..] at the given tier. */
function occurrences(lines: string[], O: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const nO = O.map((l) => normLine(l, tier));
  for (let i = Math.max(0, from); i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < O.length; k += 1) {
      if (normLine(lines[i + k]!, tier) !== nO[k]) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; 0 only with --strict) at which O occurs at least once. */
function findTier(lines: string[], O: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, O, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * One line of N: `text` is the patch's line; `ctx` says it is a context line, written as the file's own
 * matched line instead. For a context line, `oIdx` is its index in O.
 */
interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/**
 * Build the lines that replace O at position `at` in the file: context lines are the file's own matched lines;
 * at tier 2 every other line is re-indented (F = leading whitespace of the file's first matched line,
 * P = leading whitespace of O's first line).
 */
function buildReplacement(fileLines: string[], at: number, O: string[], N: NLine[], tier: number): string[] {
  if (tier !== 2 || O.length === 0) {
    return N.map((n) => (n.ctx ? fileLines[at + n.oIdx]! : n.text));
  }
  const F = leadWs(fileLines[at]!);
  const P = leadWs(O[0]!);
  return N.map((n) => {
    if (n.ctx) return fileLines[at + n.oIdx]!;
    const t = n.text;
    if (t !== '' && t.trim() !== '' && t.startsWith(P)) return F + t.slice(P.length);
    return t;
  });
}

/**
 * Apply one O -> N replacement to a file model at position `at` (O non-empty), or insert N at `pos`
 * (O empty). `touchesEnd` says whether the replaced region runs to the file's last line (or, for an
 * empty O, the insertion is at the end); in that case `noNl` decides the result's final line break.
 * Otherwise the file's final break stays as it was. Returns the net line-count change.
 */
function applyAt(model: FileModel, at: number, O: string[], N: NLine[], tier: number, touchesEnd: boolean, noNl: boolean): number {
  const repl = buildReplacement(model.lines, at, O, N, tier);
  model.lines.splice(at, O.length, ...repl);
  if (touchesEnd) model.final = !noNl;
  return repl.length - O.length;
}

/** Guard used by every edit: all paths it names must be safe, before anything else about them. */
function checkSafe(paths: Array<string | null | undefined>): void {
  for (const p of paths) {
    if (p === null || p === undefined) continue;
    if (!safe(p)) throw new Fail('unsafe', p);
  }
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

type BodyKind = 'ctx' | 'old' | 'new' | 'backslash';
interface BodyLine {
  kind: BodyKind;
  text: string;
}
interface Hunk {
  /** Old start line (1-based), A in `@@ -A[,B] +C[,D] @@`. */
  a: number;
  body: BodyLine[];
}
interface UniSection {
  oldPath: string | null | undefined; // null: /dev/null
  newPath: string | null | undefined; // null: /dev/null
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** Path after `--- ` / `+++ `: text after the four characters, up to the first tab, spaces removed. */
function uniPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;

/** A hunk header; any other line starting with `@@` is a parse error at its line. */
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Does the line at i start a new section? (`diff --git ...`, or `--- ` followed by `+++ `.) */
function startsSection(lines: string[], i: number): boolean {
  const l = lines[i]!;
  return l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '));
}

/** Parse one hunk body starting after the header at i; returns the hunk and the next line index. */
function parseHunkBody(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_HEAD.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const body: BodyLine[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') { body.push({ kind: 'ctx', text: '' }); j += 1; continue; }
    const c = l[0]!;
    if (c === ' ') { body.push({ kind: 'ctx', text: l.slice(1) }); j += 1; }
    else if (c === '-') { body.push({ kind: 'old', text: l.slice(1) }); j += 1; }
    else if (c === '+') { body.push({ kind: 'new', text: l.slice(1) }); j += 1; }
    else if (c === '\\') { body.push({ kind: 'backslash', text: l.slice(1) }); j += 1; }
    else break;
  }
  // Empty lines at the end of a body are not part of it.
  while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
  return { hunk: { a: parseInt(m[1]!, 10), body }, next: j };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: UniSection = { oldPath: m[1]!, newPath: m[2]!, newFile: false, deletedFile: false, hunks: [] };
      sections.push(sec);
      i = parseUniHeader(lines, i + 1, sec);
      i = parseUniHunks(lines, i, sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: UniSection = { oldPath: undefined, newPath: undefined, newFile: false, deletedFile: false, hunks: [] };
      sections.push(sec);
      i = parseUniHeader(lines, i, sec);
      i = parseUniHunks(lines, i, sec);
    } else if (l.startsWith('@@')) {
      // A hunk before any section.
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1; // prose, code fences: ignored outside bodies and headers
    }
  }
  return sections.map((sec) => unifiedEdit(sec, strict));
}

/**
 * A section's header: the lines after `diff --git` (or the `--- `/`+++ ` pair itself) up to the first hunk,
 * the next section, or the end of the patch. Returns the index of the first line after the header.
 */
function parseUniHeader(lines: string[], i: number, sec: UniSection): number {
  let hasPair = false;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) return i;
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (hasPair) return i; // a new section starts
        sec.oldPath = uniPath(l);
        sec.newPath = uniPath(lines[i + 1]!);
        hasPair = true;
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('+++ ')) {
      sec.newPath = uniPath(l);
      i += 1;
      continue;
    }
    if (l.startsWith('rename from ')) { sec.oldPath = l.slice('rename from '.length).trim(); i += 1; continue; }
    if (l.startsWith('rename to ')) { sec.newPath = l.slice('rename to '.length).trim(); i += 1; continue; }
    if (l === 'new file mode' || l.startsWith('new file mode ')) { sec.newFile = true; i += 1; continue; }
    if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) { sec.deletedFile = true; i += 1; continue; }
    // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`, `Index:`, any other line: ignored.
    i += 1;
  }
  return i;
}

/** The hunks of a section, up to the next section or the end of the patch. */
function parseUniHunks(lines: string[], i: number, sec: UniSection): number {
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) {
      const { hunk, next } = parseHunkBody(lines, i);
      sec.hunks.push(hunk);
      i = next;
      continue;
    }
    if (startsSection(lines, i)) return i;
    i += 1; // lines outside bodies that are not part of a section header are ignored
  }
  return i;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoNl(hunk: Hunk): boolean {
  const b = hunk.body;
  for (let k = b.length - 1; k >= 0; k -= 1) {
    if (b[k]!.kind === 'ctx' || b[k]!.kind === 'new') {
      return b[k + 1] !== undefined && b[k + 1]!.kind === 'backslash';
    }
  }
  return false;
}

/** The O and N of a hunk, in body order, with context lines marked and mapped to their O index. */
function hunkON(hunk: Hunk): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const line of hunk.body) {
    if (line.kind === 'ctx') { O.push(line.text); N.push({ text: line.text, ctx: true, oIdx: O.length - 1 }); }
    else if (line.kind === 'old') { O.push(line.text); }
    else if (line.kind === 'new') { N.push({ text: line.text, ctx: false, oIdx: -1 }); }
  }
  return { O, N };
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldPath = sec.oldPath !== undefined ? sec.oldPath : sec.newPath;
    const newPath = sec.newPath !== undefined ? sec.newPath : sec.oldPath;
    const isCreate = sec.oldPath === null || sec.newFile;
    const isDelete = sec.newPath === null || sec.deletedFile;
    const path = isCreate ? newPath : oldPath;
    checkSafe(isCreate || isDelete ? [path] : [oldPath, newPath]);
    if (path === null || path === undefined) throw new Fail('missing', '');
    if (isCreate) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      const out: string[] = [];
      let noNl = false;
      for (const hunk of sec.hunks) {
        for (let k = 0; k < hunk.body.length; k += 1) {
          const line = hunk.body[k]!;
          if (line.kind === 'new') {
            out.push(line.text);
            noNl = hunk.body[k + 1] !== undefined && hunk.body[k + 1]!.kind === 'backslash';
          }
        }
      }
      // A created file ends with a line break unless a `\` line follows its last `+` line.
      tree.now.set(path, out.length === 0 ? '' : out.join('\n') + (noNl ? '' : '\n'));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (isDelete) {
      tree.now.set(path, null);
      return;
    }
    const isMove = oldPath !== newPath;
    if (isMove) {
      if (newPath === null || newPath === undefined) throw new Fail('missing', '');
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
    }
    const model = splitFile(before);
    let d = 0;
    for (const hunk of sec.hunks) {
      const { O, N } = hunkON(hunk);
      const noNl = hunkNoNl(hunk);
      if (O.length === 0) {
        const pos = Math.min(Math.max(hunk.a + d, 0), model.lines.length);
        const wasEnd = pos === model.lines.length;
        d += applyAt(model, pos, O, N, 0, wasEnd, noNl);
        continue;
      }
      const found = findTier(model.lines, O, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + d;
      let at = found.occ[0]!;
      let best = Math.abs(at - target);
      for (const o of found.occ) {
        const dist = Math.abs(o - target);
        if (dist < best) { best = dist; at = o; }
      }
      const touchesEnd = at + O.length === model.lines.length;
      d += applyAt(model, at, O, N, found.tier, touchesEnd, noNl);
    }
    const out = joinFile(model);
    if (isMove) {
      tree.now.set(oldPath!, null);
      tree.now.set(newPath!, out);
      tree.moves.push([oldPath!, newPath!]);
    } else {
      tree.now.set(path, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1; // line index of the previous block's `>>>>>>> REPLACE`
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchLine = i;
    // The path: the nearest line before the SEARCH line, after the previous block's REPLACE line
    // (or the start of the patch), that is not blank and does not start with three backticks.
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevReplace; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    // The old lines run to the first `=======`, the new lines to the first `>>>>>>> REPLACE`.
    let sep = -1;
    for (let j = searchLine + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') { sep = j; break; }
    }
    let end = -1;
    if (sep >= 0) {
      for (let j = sep + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { end = j; break; }
      }
    }
    if (sep < 0 || end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevReplace = end;
    prevPath = path;
    i = end + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    checkSafe([path]);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = splitFile(before);
    const found = findTier(model.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const N: NLine[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    applyAt(model, at, oldLines, N, found.tier, false, false);
    tree.now.set(path, joinFile(model));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface VChunk {
  /** Anchor text ('' means no anchor). */
  anchor: string;
  /** True when a `*** End of File` line closed this chunk: it is anchored to the end of the file. */
  eof: boolean;
  body: BodyLine[];
}
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  /** Add File: the file's lines. Update File: its chunks. Delete File: unused. */
  lines: string[];
  chunks: VChunk[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = lines.map((l, idx) => (blank(l) ? -1 : idx)).reduce((a, b) => Math.max(a, b), -1);
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i += 1; continue; }
    let sec: VSection | null = null;
    if (l.startsWith('*** Add File: ')) sec = { kind: 'add', path: l.slice('*** Add File: '.length).trim(), moveTo: null, lines: [], chunks: [] };
    else if (l.startsWith('*** Delete File: ')) sec = { kind: 'delete', path: l.slice('*** Delete File: '.length).trim(), moveTo: null, lines: [], chunks: [] };
    else if (l.startsWith('*** Update File: ')) sec = { kind: 'update', path: l.slice('*** Update File: '.length).trim(), moveTo: null, lines: [], chunks: [] };
    else throw new Exit2(`error: parse ${i + 1}`);
    const secLine = i + 1;
    i += 1;
    // The section's raw lines run to the next section header or `*** End Patch`; blank lines at the
    // end of a section are not part of it.
    const rawBase = i;
    const raw: string[] = [];
    while (i < last) {
      const m = lines[i]!;
      if (m.startsWith('*** Add File: ') || m.startsWith('*** Delete File: ') || m.startsWith('*** Update File: ')) break;
      raw.push(m);
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    parseVSection(sec, raw, rawBase, secLine);
    edits.push(v4aEdit(sec, strict));
  }
  return edits;
}

/**
 * Interpret one section's raw lines (trailing blanks already removed). `rawBase` is the 0-based patch
 * line index of raw[0]; `secLine` the 1-based line number of the section's header line.
 */
function parseVSection(sec: VSection, raw: string[], rawBase: number, secLine: number): void {
  if (sec.kind === 'add') {
    for (let k = 0; k < raw.length; k += 1) {
      const l = raw[k]!;
      if (l.startsWith('+')) sec.lines.push(l.slice(1));
      else if (l === '') sec.lines.push('');
      else throw new Exit2(`error: parse ${rawBase + k + 1}`);
    }
    return;
  }
  if (sec.kind === 'delete') {
    if (raw.length > 0) throw new Exit2(`error: parse ${rawBase + 1}`);
    return;
  }
  // Update File: an optional `*** Move to:` first line, then chunks.
  let at = 0;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
    sec.moveTo = raw[0]!.slice('*** Move to: '.length).trim();
    at = 1;
  }
  let cur: VChunk | null = null;
  const close = (): void => {
    if (cur !== null) { sec.chunks.push(cur); cur = null; }
  };
  for (let k = at; k < raw.length; k += 1) {
    const l = raw[k]!;
    if (l.startsWith('@@')) {
      close();
      cur = { anchor: l.slice(2).trim(), eof: false, body: [] };
      continue;
    }
    if (l.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${rawBase + k + 1}`);
      cur.eof = true;
      close();
      continue;
    }
    if (l.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${rawBase + k + 1}`);
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) cur = { anchor: '', eof: false, body: [] };
      if (l === '') cur.body.push({ kind: 'ctx', text: '' });
      else if (l[0] === ' ') cur.body.push({ kind: 'ctx', text: l.slice(1) });
      else if (l[0] === '-') cur.body.push({ kind: 'old', text: l.slice(1) });
      else cur.body.push({ kind: 'new', text: l.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${rawBase + k + 1}`);
  }
  close();
  if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${secLine}`);
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    checkSafe([sec.path, sec.moveTo]);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.lines.length === 0 ? '' : `${sec.lines.join('\n')}\n`);
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const model = splitFile(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== '') {
        // The first line at or after the cursor equal to the anchor, at the first tier with one.
        const tiers = strict ? [0] : [0, 1, 2];
        let foundAt = -1;
        for (const t of tiers) {
          foundAt = -1;
          for (let j = cursor; j < model.lines.length; j += 1) {
            if (normLine(model.lines[j]!, t) === normLine(chunk.anchor, t)) { foundAt = j; break; }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', sec.path);
        cursor = foundAt + 1;
      }
      const { O, N } = hunkON({ a: 0, body: chunk.body });
      if (O.length === 0) {
        const pos = chunk.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        const repl = buildReplacement(model.lines, pos, O, N, 0);
        model.lines.splice(pos, 0, ...repl);
        cursor = pos + repl.length;
        continue;
      }
      const found = findTier(model.lines, O, strict, cursor);
      if (found === null) throw new Fail('no-match', sec.path);
      let at = -1;
      for (const o of found.occ) {
        if (chunk.eof && o + O.length !== model.lines.length) continue;
        at = o;
        break;
      }
      if (at < 0) throw new Fail('no-match', sec.path);
      const repl = buildReplacement(model.lines, at, O, N, found.tier);
      model.lines.splice(at, O.length, ...repl);
      cursor = at + repl.length;
    }
    const out = joinFile(model);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, out);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Running the patch (SPEC.md sections 1, 2 and 10)                    */
/* ------------------------------------------------------------------ */

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
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
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
    const movesBefore = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...movesBefore);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows, in byte order of the paths (an `R` line sorts by its new path).
  const rows: Array<{ key: string; text: string }> = [];
  const deleted = new Set<string>();
  const added = new Set<string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null) added.add(p);
    else if (now === null) deleted.add(p);
    else rows.push({ key: p, text: `M ${p}` });
  }
  // Pair a move's deletion with its addition into one `R` line (chained moves collapse to first -> last).
  const next = new Map<string, string>();
  for (const [o, n] of tree.moves) next.set(o, n);
  for (const [o] of tree.moves) {
    let cur = o;
    const seen = new Set([o]);
    while (next.has(cur) && !seen.has(next.get(cur)!)) { cur = next.get(cur)!; seen.add(cur); }
    if (deleted.has(o) && added.has(cur)) {
      rows.push({ key: cur, text: `R ${o} -> ${cur}` });
      deleted.delete(o);
      added.delete(cur);
    }
  }
  for (const p of deleted) rows.push({ key: p, text: `D ${p}` });
  for (const p of added) rows.push({ key: p, text: `A ${p}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
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
