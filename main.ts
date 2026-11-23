// mend: apply an AI-written edit to a tree of text files. See SPEC.md.
// Node 22, standard library only. Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// When MAKEFUN_ENV_URL is set, the trial is handed over to runner.ts.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runTrial } from './runner.ts';

// ---------- small helpers ----------

function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function isBlank(s: string): boolean {
  return s.trim() === '';
}
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// A patch's lines: split at \n, one trailing \r removed from each, and without
// the empty piece after a final \n. (SPEC section 3.)
function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n').map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
  if (text.endsWith('\n')) parts.pop();
  return parts;
}

// A file's lines, its line break, and whether it ends with one. (SPEC section 3.)
interface FileState {
  lines: string[];
  br: string;
  ends: boolean;
}
function splitFile(text: string): FileState {
  const firstLf = text.indexOf('\n');
  const br = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, ends: false };
  const parts = text.split(br);
  let ends = false;
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
    ends = true;
  }
  return { lines: parts, br, ends };
}
function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}
// A file of no lines is written empty, so it ends with no line break.
function normalizeFile(f: FileState): void {
  if (f.lines.length === 0) f.ends = false;
}

// ---------- line matching (SPEC section 5) ----------

function leadingWs(s: string): string {
  const m = s.match(/^[ \t]*/);
  return m === null ? '' : m[0];
}
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}
function findOccurrences(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(lines[i + j], O[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
// First tier (0, 1, 2; only 0 with --strict) at which O occurs at least once,
// searching at or after `from`.
function findTier(
  lines: string[],
  O: string[],
  from: number,
  strict: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(lines, O, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

// A line of N: a context line is written as the file's own matched line;
// every other line is the patch's line, re-indented at tier 2. (SPEC section 5.)
interface NLine {
  text: string;
  ctx: boolean;
  oIndex: number;
}
function buildN(N: NLine[], fileLines: string[], pos: number, tier: number, O: string[]): string[] {
  const out: string[] = [];
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = leadingWs(fileLines[pos] ?? '');
    P = leadingWs(O[0]);
  }
  for (const nl of N) {
    if (nl.ctx) {
      out.push(fileLines[pos + nl.oIndex]);
      continue;
    }
    let text = nl.text;
    if (tier === 2 && !/^[ \t]*$/.test(text) && text.startsWith(P)) {
      text = F + text.slice(P.length);
    }
    out.push(text);
  }
  return out;
}

// ---------- edits ----------

interface BodyLine {
  t: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}
interface Hunk {
  a: number;
  body: BodyLine[];
}
interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}
type Edit =
  | { kind: 'u'; oldPath: string | null; newPath: string | null; isCreate: boolean; isDelete: boolean; hunks: Hunk[] }
  | { kind: 's'; path: string; oldLines: string[]; newLines: string[] }
  | { kind: 'va'; path: string; lines: string[] }
  | { kind: 'vd'; path: string }
  | { kind: 'vu'; path: string; moveTo: string | null; chunks: VChunk[] }
  | { kind: 'jc'; path: string; text: string }
  | { kind: 'js'; path: string; oldStr: string; newStr: string }
  | { kind: 'ji'; path: string; line: number; text: string };

type ApplyResult = { ok: true } | { ok: false; code: string; path: string };
function fail(code: string, path: string): ApplyResult {
  return { ok: false, code, path };
}

// O and N of a hunk/chunk body, in body order. Context lines are in both.
function bodyON(body: BodyLine[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const bl of body) {
    if (bl.t === 'ctx') {
      const idx = O.length;
      O.push(bl.text);
      N.push({ text: bl.text, ctx: true, oIndex: idx });
    } else if (bl.t === 'old') {
      O.push(bl.text);
    } else if (bl.t === 'new') {
      N.push({ text: bl.text, ctx: false, oIndex: -1 });
    }
  }
  return { O, N };
}

// Whether a `\` line follows the hunk's last context or `+` line.
function hunkNoNewline(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i].t === 'ctx' || body[i].t === 'new') last = i;
  }
  if (last === -1) return false;
  return last + 1 < body.length && body[last + 1].t === 'bs';
}
// Whether a `\` line follows the last `+` line of a creation, over all hunks.
function creationNoNewline(hunks: Hunk[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h--) {
    const body = hunks[h].body;
    let last = -1;
    for (let i = 0; i < body.length; i++) {
      if (body[i].t === 'new') last = i;
    }
    if (last !== -1) return last + 1 < body.length && body[last + 1].t === 'bs';
  }
  return false;
}

// Apply one unified hunk to a file state. d is this section's length delta so far.
function applyHunk(file: FileState, hunk: Hunk, d: number, strict: boolean): { ok: boolean; dDelta: number } {
  const { O, N } = bodyON(hunk.body);
  const noNl = hunkNoNewline(hunk.body);
  if (O.length === 0) {
    let idx = hunk.a + d;
    if (idx < 0) idx = 0;
    if (idx > file.lines.length) idx = file.lines.length;
    const atEnd = idx === file.lines.length;
    const newLines = buildN(N, file.lines, idx, 0, O);
    file.lines.splice(idx, 0, ...newLines);
    if (atEnd) file.ends = !noNl;
    return { ok: true, dDelta: N.length };
  }
  const found = findTier(file.lines, O, 0, strict);
  if (found === null) return { ok: false, dDelta: 0 };
  const target = hunk.a - 1 + d;
  let best = found.occ[0];
  let bestDist = Math.abs(best - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const pos = best;
  const oldLen = file.lines.length;
  const atEnd = pos + O.length === oldLen;
  const newLines = buildN(N, file.lines, pos, found.tier, O);
  file.lines.splice(pos, O.length, ...newLines);
  if (atEnd) file.ends = !noNl;
  return { ok: true, dDelta: N.length - O.length };
}

function applyUnified(
  tree: Map<string, string>,
  e: Extract<Edit, { kind: 'u' }>,
  strict: boolean,
  moves: [string, string][],
): ApplyResult {
  const oldP = e.oldPath;
  const newP = e.newPath;
  if (oldP !== null && !isSafePath(oldP)) return fail('unsafe', oldP);
  if (newP !== null && !isSafePath(newP)) return fail('unsafe', newP);
  if (e.isCreate) {
    if (newP === null) return { ok: true };
    if (tree.has(newP)) return fail('exists', newP);
    const lines: string[] = [];
    for (const h of e.hunks) {
      for (const bl of h.body) if (bl.t === 'new') lines.push(bl.text);
    }
    const ends = lines.length > 0 && !creationNoNewline(e.hunks);
    tree.set(newP, joinFile({ lines, br: '\n', ends }));
    return { ok: true };
  }
  if (e.isDelete) {
    if (oldP === null) return { ok: true };
    if (!tree.has(oldP)) return fail('missing', oldP);
    tree.delete(oldP);
    return { ok: true };
  }
  if (oldP !== null && newP !== null && oldP !== newP) {
    if (!tree.has(oldP)) return fail('missing', oldP);
    if (tree.has(newP)) return fail('exists', newP);
    const file = splitFile(tree.get(oldP) as string);
    let d = 0;
    for (const h of e.hunks) {
      const r = applyHunk(file, h, d, strict);
      if (!r.ok) return fail('no-match', oldP);
      d += r.dDelta;
    }
    normalizeFile(file);
    tree.delete(oldP);
    tree.set(newP, joinFile(file));
    moves.push([oldP, newP]);
    return { ok: true };
  }
  const p = oldP ?? newP;
  if (p === null) return { ok: true };
  if (!tree.has(p)) return fail('missing', p);
  const file = splitFile(tree.get(p) as string);
  let d = 0;
  for (const h of e.hunks) {
    const r = applyHunk(file, h, d, strict);
    if (!r.ok) return fail('no-match', p);
    d += r.dDelta;
  }
  normalizeFile(file);
  tree.set(p, joinFile(file));
  return { ok: true };
}

function applySearchReplace(
  tree: Map<string, string>,
  e: Extract<Edit, { kind: 's' }>,
  strict: boolean,
): ApplyResult {
  if (!isSafePath(e.path)) return fail('unsafe', e.path);
  if (e.oldLines.length === 0) {
    if (tree.has(e.path)) return fail('exists', e.path);
    const ends = e.newLines.length > 0;
    tree.set(e.path, joinFile({ lines: [...e.newLines], br: '\n', ends }));
    return { ok: true };
  }
  if (!tree.has(e.path)) return fail('missing', e.path);
  const file = splitFile(tree.get(e.path) as string);
  const found = findTier(file.lines, e.oldLines, 0, strict);
  if (found === null) return fail('no-match', e.path);
  if (found.occ.length > 1) return fail('ambiguous', e.path);
  const pos = found.occ[0];
  const N: NLine[] = e.newLines.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
  const newLines = buildN(N, file.lines, pos, found.tier, e.oldLines);
  file.lines.splice(pos, e.oldLines.length, ...newLines);
  normalizeFile(file);
  tree.set(e.path, joinFile(file));
  return { ok: true };
}

function applyV4A(
  tree: Map<string, string>,
  e: Extract<Edit, { kind: 'va' | 'vd' | 'vu' }>,
  strict: boolean,
  moves: [string, string][],
): ApplyResult {
  if (!isSafePath(e.path)) return fail('unsafe', e.path);
  if (e.kind === 'va') {
    if (tree.has(e.path)) return fail('exists', e.path);
    const ends = e.lines.length > 0;
    tree.set(e.path, joinFile({ lines: [...e.lines], br: '\n', ends }));
    return { ok: true };
  }
  if (e.kind === 'vd') {
    if (!tree.has(e.path)) return fail('missing', e.path);
    tree.delete(e.path);
    return { ok: true };
  }
  if (e.moveTo !== null && !isSafePath(e.moveTo)) return fail('unsafe', e.moveTo);
  if (!tree.has(e.path)) return fail('missing', e.path);
  if (e.moveTo !== null && tree.has(e.moveTo)) return fail('exists', e.moveTo);
  const file = splitFile(tree.get(e.path) as string);
  let cursor = 0;
  for (const chunk of e.chunks) {
    if (chunk.anchor !== null && chunk.anchor !== '') {
      const found = findTier(file.lines, [chunk.anchor], cursor, strict);
      if (found === null) return fail('no-match', e.path);
      cursor = found.occ[0] + 1;
    }
    const { O, N } = bodyON(chunk.body);
    if (O.length === 0) {
      const idx = chunk.eof ? file.lines.length : cursor;
      const newLines = buildN(N, file.lines, idx, 0, O);
      file.lines.splice(idx, 0, ...newLines);
      cursor = idx + newLines.length;
      continue;
    }
    // First tier with an occurrence at or after the cursor; an end-of-file
    // chunk takes only an occurrence that ends at the file's last line.
    const tiers = strict ? [0] : [0, 1, 2];
    let picked: { tier: number; pos: number } | null = null;
    for (const t of tiers) {
      const occ = findOccurrences(file.lines, O, t, cursor);
      const cand = chunk.eof ? occ.filter((p) => p + O.length === file.lines.length) : occ;
      if (cand.length > 0) {
        picked = { tier: t, pos: cand[0] };
        break;
      }
    }
    if (picked === null) return fail('no-match', e.path);
    const newLines = buildN(N, file.lines, picked.pos, picked.tier, O);
    file.lines.splice(picked.pos, O.length, ...newLines);
    cursor = picked.pos + newLines.length;
  }
  normalizeFile(file);
  const content = joinFile(file);
  if (e.moveTo !== null) {
    tree.delete(e.path);
    tree.set(e.moveTo, content);
    moves.push([e.path, e.moveTo]);
  } else {
    tree.set(e.path, content);
  }
  return { ok: true };
}

function applyJson(
  tree: Map<string, string>,
  e: Extract<Edit, { kind: 'jc' | 'js' | 'ji' }>,
): ApplyResult {
  if (!isSafePath(e.path)) return fail('unsafe', e.path);
  if (e.kind === 'jc') {
    if (tree.has(e.path)) return fail('exists', e.path);
    tree.set(e.path, e.text);
    return { ok: true };
  }
  if (!tree.has(e.path)) return fail('missing', e.path);
  if (e.kind === 'js') {
    const text = tree.get(e.path) as string;
    const crlf = splitFile(text).br === '\r\n';
    let hay = text;
    let oldS = e.oldStr;
    let newS = e.newStr;
    if (crlf) {
      hay = text.replace(/\r\n/g, '\n');
      oldS = oldS.replace(/\r\n/g, '\n');
      newS = newS.replace(/\r\n/g, '\n');
    }
    let count = 0;
    let at = 0;
    let first = -1;
    for (;;) {
      const idx = hay.indexOf(oldS, at);
      if (idx === -1) break;
      if (first === -1) first = idx;
      count++;
      if (count > 1) break;
      at = idx + 1;
    }
    if (count === 0) return fail('no-match', e.path);
    if (count > 1) return fail('ambiguous', e.path);
    let result = hay.slice(0, first) + newS + hay.slice(first + oldS.length);
    if (crlf) result = result.replace(/\n/g, '\r\n');
    tree.set(e.path, result);
    return { ok: true };
  }
  const file = splitFile(tree.get(e.path) as string);
  if (e.line < 0 || e.line > file.lines.length) return fail('no-match', e.path);
  const ins = splitPatchLines(e.text);
  file.lines.splice(e.line, 0, ...ins);
  normalizeFile(file);
  tree.set(e.path, joinFile(file));
  return { ok: true };
}

function applyEdit(
  tree: Map<string, string>,
  e: Edit,
  strict: boolean,
  moves: [string, string][],
): ApplyResult {
  switch (e.kind) {
    case 'u':
      return applyUnified(tree, e, strict, moves);
    case 's':
      return applySearchReplace(tree, e, strict);
    case 'va':
    case 'vd':
    case 'vu':
      return applyV4A(tree, e, strict, moves);
    default:
      return applyJson(tree, e);
  }
}

// Edits apply in order to the tree as earlier edits left it; a failed edit
// changes nothing, later edits still run, and no file is written at all
// when any edit failed. Each edit is tried on a copy of the tree.
function applyEdits(
  tree: Map<string, string>,
  edits: Edit[],
  strict: boolean,
): { failures: { code: string; path: string }[]; moves: [string, string][] } {
  const failures: { code: string; path: string }[] = [];
  const moves: [string, string][] = [];
  for (const e of edits) {
    const trial = new Map(tree);
    const trialMoves: [string, string][] = [];
    const r = applyEdit(trial, e, strict, trialMoves);
    if (r.ok) {
      tree.clear();
      for (const [k, v] of trial) tree.set(k, v);
      moves.push(...trialMoves);
    } else {
      failures.push({ code: r.code, path: r.path });
    }
  }
  return { failures, moves };
}

// ---------- format detection (SPEC section 4) ----------

function detectFormat(lines: string[]): string | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const firstCh = lines[first].trimStart()[0];
  if (firstCh === '[' || firstCh === '{') return 'json';
  for (let i = 0; i < lines.length; i++) {
    if (trimEndWs(lines[i]) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      return 'unified';
    }
  }
  return null;
}

// ---------- unified diffs (SPEC section 6) ----------

type ParseResult<T> = { ok: true; value: T } | { ok: false; line: number };

interface UnifiedSectionRaw {
  pairOld: string | null;
  pairNew: string | null;
  plusNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

// The path after `--- ` or `+++ `: text after four characters, up to the first
// tab, with surrounding spaces removed; /dev/null means no file; a leading
// a/ or b/ is removed.
function parseDiffPath(line: string): string | null {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = trimWs(rest);
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/')) rest = rest.slice(2);
  else if (rest.startsWith('b/')) rest = rest.slice(2);
  if (rest === '/dev/null') return null;
  return rest;
}

function parseUnified(lines: string[]): ParseResult<Edit[]> {
  const diffRe = /^diff --git a\/(.+) b\/(.+?)[ \t]*$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const sections: UnifiedSectionRaw[] = [];
  let cur: UnifiedSectionRaw | null = null;
  let curHunk: Hunk | null = null;
  let state: 'outside' | 'header' | 'body' | 'after' = 'outside';

  function startSection(diff: { old: string; new: string } | null, pair: { old: string; new: string } | null): void {
    cur = {
      pairOld: pair === null ? null : pair.old,
      pairNew: pair === null ? null : pair.new,
      plusNew: null,
      renameFrom: null,
      renameTo: null,
      diffOld: diff === null ? null : diff.old,
      diffNew: diff === null ? null : diff.new,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    curHunk = null;
    state = 'header';
  }
  function closeSection(): void {
    if (cur !== null) sections.push(cur);
    cur = null;
    curHunk = null;
  }
  function endBody(): void {
    if (curHunk !== null) {
      while (curHunk.body.length > 0) {
        const last = curHunk.body[curHunk.body.length - 1];
        if (last.t === 'ctx' && last.text === '') curHunk.body.pop();
        else break;
      }
    }
  }
  function diffPaths(line: string): { old: string; new: string } | null {
    const m = line.match(diffRe);
    if (m === null) return null;
    return { old: m[1], new: m[2] };
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const next = i + 1 < lines.length ? lines[i + 1] : null;
    if (state === 'outside') {
      if (line.startsWith('diff --git ')) {
        const d = diffPaths(line);
        if (d === null) return { ok: false, line: i + 1 };
        startSection(d, null);
        i++;
      } else if (line.startsWith('--- ') && next !== null && next.startsWith('+++ ')) {
        startSection(null, { old: parseDiffPath(line), new: parseDiffPath(next) });
        i += 2;
      } else if (line.startsWith('@@')) {
        return { ok: false, line: i + 1 };
      } else {
        i++;
      }
    } else if (state === 'header') {
      if (line.startsWith('diff --git ')) {
        const d = diffPaths(line);
        if (d === null) return { ok: false, line: i + 1 };
        closeSection();
        startSection(d, null);
        i++;
      } else if (line.startsWith('--- ')) {
        if (next !== null && next.startsWith('+++ ')) {
          if (cur !== null) {
            cur.pairOld = parseDiffPath(line);
            cur.pairNew = parseDiffPath(next);
          }
          i += 2;
        } else {
          return { ok: false, line: i + 2 };
        }
      } else if (line.startsWith('+++ ')) {
        if (cur !== null) cur.plusNew = parseDiffPath(line);
        i++;
      } else if (line.startsWith('rename from ')) {
        if (cur !== null) cur.renameFrom = trimWs(line.slice('rename from '.length));
        i++;
      } else if (line.startsWith('rename to ')) {
        if (cur !== null) cur.renameTo = trimWs(line.slice('rename to '.length));
        i++;
      } else if (line === 'new file mode' || line.startsWith('new file mode ')) {
        if (cur !== null) cur.newFile = true;
        i++;
      } else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        if (cur !== null) cur.deletedFile = true;
        i++;
      } else if (line.startsWith('@@')) {
        const m = line.match(hunkRe);
        if (m === null) return { ok: false, line: i + 1 };
        curHunk = { a: parseInt(m[1], 10), body: [] };
        if (cur !== null) cur.hunks.push(curHunk);
        state = 'body';
        i++;
      } else {
        i++;
      }
    } else if (state === 'body') {
      if (line.startsWith('diff --git ')) {
        endBody();
        const d = diffPaths(line);
        if (d === null) return { ok: false, line: i + 1 };
        closeSection();
        startSection(d, null);
        i++;
      } else if (line.startsWith('--- ') && next !== null && next.startsWith('+++ ')) {
        endBody();
        closeSection();
        startSection(null, { old: parseDiffPath(line), new: parseDiffPath(next) });
        i += 2;
      } else if (line.startsWith('@@')) {
        endBody();
        const m = line.match(hunkRe);
        if (m === null) return { ok: false, line: i + 1 };
        curHunk = { a: parseInt(m[1], 10), body: [] };
        if (cur !== null) cur.hunks.push(curHunk);
        i++;
      } else if (
        line.startsWith(' ') ||
        line.startsWith('-') ||
        line.startsWith('+') ||
        line.startsWith('\\') ||
        line === ''
      ) {
        if (curHunk !== null) {
          if (line === '') curHunk.body.push({ t: 'ctx', text: '' });
          else if (line.startsWith(' ')) curHunk.body.push({ t: 'ctx', text: line.slice(1) });
          else if (line.startsWith('-')) curHunk.body.push({ t: 'old', text: line.slice(1) });
          else if (line.startsWith('+')) curHunk.body.push({ t: 'new', text: line.slice(1) });
          else curHunk.body.push({ t: 'bs', text: line });
        }
        i++;
      } else {
        endBody();
        state = 'after';
      }
    } else {
      // state === 'after': outside bodies, inside a section; prose is ignored.
      if (line.startsWith('diff --git ')) {
        const d = diffPaths(line);
        if (d === null) return { ok: false, line: i + 1 };
        closeSection();
        startSection(d, null);
        i++;
      } else if (line.startsWith('--- ') && next !== null && next.startsWith('+++ ')) {
        closeSection();
        startSection(null, { old: parseDiffPath(line), new: parseDiffPath(next) });
        i += 2;
      } else if (line.startsWith('@@')) {
        const m = line.match(hunkRe);
        if (m === null) return { ok: false, line: i + 1 };
        curHunk = { a: parseInt(m[1], 10), body: [] };
        if (cur !== null) cur.hunks.push(curHunk);
        state = 'body';
        i++;
      } else {
        i++;
      }
    }
  }
  if (state === 'body') endBody();
  if (cur !== null) closeSection();
  if (sections.length === 0) return { ok: false, line: 1 };
  const edits: Edit[] = sections.map((s) => {
    const oldPath = s.pairOld ?? s.renameFrom ?? s.diffOld;
    const newPath = s.pairNew ?? s.plusNew ?? s.renameTo ?? s.diffNew;
    return {
      kind: 'u',
      oldPath,
      newPath,
      isCreate: oldPath === null || s.newFile,
      isDelete: newPath === null || s.deletedFile,
      hunks: s.hunks,
    };
  });
  return { ok: true, value: edits };
}

// ---------- SEARCH/REPLACE blocks (SPEC section 7) ----------

function parseSearchReplace(lines: string[]): ParseResult<Edit[]> {
  const blocks: { path: string; oldLines: string[]; newLines: string[] }[] = [];
  let prevReplaceEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (trimEndWs(lines[i]) !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevReplaceEnd; j--) {
      const t = lines[j];
      if (isBlank(t)) continue;
      const trimmed = t.trim();
      if (trimmed.startsWith('```')) continue;
      path = trimmed;
      break;
    }
    if (path === null) {
      if (blocks.length === 0) return { ok: false, line: searchLine };
      path = blocks[blocks.length - 1].path;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (trimEndWs(lines[j]) === '=======') {
        eq = j;
        break;
      }
      if (trimEndWs(lines[j]) === '>>>>>>> REPLACE') return { ok: false, line: searchLine };
    }
    if (eq === -1) return { ok: false, line: searchLine };
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (trimEndWs(lines[j]) === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) return { ok: false, line: searchLine };
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  if (blocks.length === 0) return { ok: false, line: 1 };
  return {
    ok: true,
    value: blocks.map((b) => ({ kind: 's', path: b.path, oldLines: b.oldLines, newLines: b.newLines })),
  };
}

// ---------- V4A patches (SPEC section 8) ----------

interface V4ASectionRaw {
  kind: 'add' | 'delete' | 'update';
  path: string;
  headerLine: number;
  raw: string[];
}

function parseV4A(lines: string[]): ParseResult<Edit[]> {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) return { ok: false, line: 1 };
  if (lines[first].trim() !== '*** Begin Patch') return { ok: false, line: first + 1 };
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') return { ok: false, line: lines.length + 1 };

  const sections: V4ASectionRaw[] = [];
  let cur: V4ASectionRaw | null = null;
  function closeSection(): void {
    if (cur !== null) {
      while (cur.raw.length > 0 && isBlank(cur.raw[cur.raw.length - 1])) cur.raw.pop();
      sections.push(cur);
    }
    cur = null;
  }
  for (let i = first + 1; i < last; i++) {
    const line = lines[i];
    if (line.startsWith('*** Add File: ')) {
      closeSection();
      cur = { kind: 'add', path: trimWs(line.slice('*** Add File: '.length)), headerLine: i + 1, raw: [] };
    } else if (line.startsWith('*** Delete File: ')) {
      closeSection();
      cur = { kind: 'delete', path: trimWs(line.slice('*** Delete File: '.length)), headerLine: i + 1, raw: [] };
    } else if (line.startsWith('*** Update File: ')) {
      closeSection();
      cur = { kind: 'update', path: trimWs(line.slice('*** Update File: '.length)), headerLine: i + 1, raw: [] };
    } else if (cur === null) {
      if (isBlank(line)) continue;
      return { ok: false, line: i + 1 };
    } else {
      cur.raw.push(line);
    }
  }
  closeSection();
  if (sections.length === 0) return { ok: false, line: 1 };

  const edits: Edit[] = [];
  for (const s of sections) {
    if (s.kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < s.raw.length; k++) {
        const l = s.raw[k];
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else return { ok: false, line: s.headerLine + 1 + k };
      }
      edits.push({ kind: 'va', path: s.path, lines: fileLines });
      continue;
    }
    if (s.kind === 'delete') {
      for (let k = 0; k < s.raw.length; k++) {
        if (!isBlank(s.raw[k])) return { ok: false, line: s.headerLine + 1 + k };
      }
      edits.push({ kind: 'vd', path: s.path });
      continue;
    }
    // update
    let moveTo: string | null = null;
    let rest = s.raw;
    if (rest.length > 0 && rest[0].startsWith('*** Move to: ')) {
      moveTo = trimWs(rest[0].slice('*** Move to: '.length));
      rest = rest.slice(1);
    }
    const chunks: VChunk[] = [];
    let chunk: VChunk | null = null;
    function pushChunk(): void {
      if (chunk !== null) chunks.push(chunk);
      chunk = null;
    }
    for (let k = 0; k < rest.length; k++) {
      const l = rest[k];
      const lineNo = s.headerLine + 1 + (s.raw.length - rest.length) + k;
      if (l.startsWith('@@')) {
        pushChunk();
        const anchor = trimWs(l.slice(2));
        chunk = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      } else if (l === '*** End of File') {
        // Ends the chunk in progress and anchors it to the end of the file.
        // It never starts a chunk: with no chunk in progress it is a no-op,
        // so a section holding only this line has no chunk at all.
        if (chunk !== null) {
          chunk.eof = true;
          pushChunk();
        }
      } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
        if (chunk === null) chunk = { anchor: null, body: [], eof: false };
        if (l === '') chunk.body.push({ t: 'ctx', text: '' });
        else if (l.startsWith(' ')) chunk.body.push({ t: 'ctx', text: l.slice(1) });
        else if (l.startsWith('-')) chunk.body.push({ t: 'old', text: l.slice(1) });
        else chunk.body.push({ t: 'new', text: l.slice(1) });
      } else {
        return { ok: false, line: lineNo };
      }
    }
    pushChunk();
    if (chunks.length === 0 && moveTo === null) return { ok: false, line: s.headerLine };
    edits.push({ kind: 'vu', path: s.path, moveTo, chunks });
  }
  return { ok: true, value: edits };
}

// ---------- JSON edits (SPEC section 9) ----------

function validateJsonEdit(obj: unknown): Edit | null {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { kind: 'jc', path: o.path, text: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    let newStr = '';
    if ('new_str' in o) {
      if (typeof o.new_str !== 'string') return null;
      newStr = o.new_str;
    }
    return { kind: 'js', path: o.path, oldStr: o.old_str, newStr };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { kind: 'ji', path: o.path, line: o.insert_line, text: o.new_str };
  }
  return null;
}

function parseJson(lines: string[], patchText: string): ParseResult<Edit[]> {
  const firstNonWs = patchText.search(/\S/);
  if (firstNonWs === -1) return { ok: false, line: 1 };
  if (patchText[firstNonWs] === '[') {
    const arrayStartLine = patchText.slice(0, firstNonWs).split('\n').length;
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      return { ok: false, line: arrayStartLine };
    }
    if (!Array.isArray(arr)) return { ok: false, line: arrayStartLine };
    if (arr.length === 0) return { ok: false, line: 1 };
    const edits: Edit[] = [];
    for (const el of arr) {
      const e = validateJsonEdit(el);
      if (e === null) return { ok: false, line: arrayStartLine };
      edits.push(e);
    }
    return { ok: true, value: edits };
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line)) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return { ok: false, line: i + 1 };
    }
    const e = validateJsonEdit(obj);
    if (e === null) return { ok: false, line: i + 1 };
    edits.push(e);
  }
  if (edits.length === 0) return { ok: false, line: 1 };
  return { ok: true, value: edits };
}

// ---------- tree IO ----------

function readTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string, rel: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      const r = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(p, r);
      else if (entry.isFile()) out.set(r, readFileSync(p, 'utf8'));
    }
  };
  walk(dir, '');
  return out;
}

function writeTree(orig: Map<string, string>, tree: Map<string, string>): void {
  const cwd = process.cwd();
  for (const [p, content] of tree) {
    if (orig.get(p) !== content) {
      const f = join(cwd, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, content, 'utf8');
    }
  }
  for (const p of orig.keys()) {
    if (!tree.has(p)) {
      rmSync(join(cwd, ...p.split('/')), { force: true });
    }
  }
}

// One line per changed path, in byte order of the paths (UTF-8); a move
// replaces its D and A lines and sorts by its new path. (SPEC section 2.)
function computeOutput(
  orig: Map<string, string>,
  tree: Map<string, string>,
  moves: [string, string][],
): string[] {
  const lines: { key: string; text: string }[] = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const [oldP, newP] of moves) {
    if (orig.has(oldP) && !tree.has(oldP) && !orig.has(newP) && tree.has(newP)) {
      lines.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      usedOld.add(oldP);
      usedNew.add(newP);
    }
  }
  const all = new Set([...orig.keys(), ...tree.keys()]);
  for (const p of all) {
    const inOrig = orig.has(p);
    const inTree = tree.has(p);
    if (inOrig && !inTree) {
      if (!usedOld.has(p)) lines.push({ key: p, text: `D ${p}` });
    } else if (!inOrig && inTree) {
      if (!usedNew.has(p)) lines.push({ key: p, text: `A ${p}` });
    } else if (inOrig && inTree && orig.get(p) !== tree.get(p)) {
      lines.push({ key: p, text: `M ${p}` });
    }
  }
  lines.sort((a, b) => byteCompare(a.key, b.key));
  return lines.map((l) => l.text);
}

// ---------- main ----------

function usage(): { out: string; code: number } {
  return { out: 'error: usage\n', code: 2 };
}

async function main(): Promise<{ out: string; code: number }> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl !== undefined && envUrl !== '') {
    await runTrial(envUrl);
    return { out: '', code: 0 };
  }

  const args = process.argv.slice(2);
  let format: string | null = null;
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let endOpts = false;
  const positional: string[] = [];
  for (const a of args) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seenCheck) return usage();
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) return usage();
        seenStrict = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) return usage();
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') {
          return usage();
        }
        format = v;
      } else {
        return usage();
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return usage();

  const patchArg = positional.length === 1 ? positional[0] : null;
  let patchText: string;
  if (patchArg === null || patchArg === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(patchArg, 'utf8');
    } catch {
      return { out: 'error: no-patch\n', code: 2 };
    }
  }

  const lines = splitPatchLines(patchText);
  let detected: string;
  if (format === null || format === 'auto') {
    const d = detectFormat(lines);
    if (d === null) return { out: 'error: format\n', code: 2 };
    detected = d;
  } else {
    detected = format;
  }

  let parsed: ParseResult<Edit[]>;
  if (detected === 'unified') parsed = parseUnified(lines);
  else if (detected === 'search-replace') parsed = parseSearchReplace(lines);
  else if (detected === 'v4a') parsed = parseV4A(lines);
  else parsed = parseJson(lines, patchText);
  if (!parsed.ok) return { out: `error: parse ${parsed.line}\n`, code: 2 };
  const edits = parsed.value;

  const origTree = readTree(process.cwd());
  const tree = new Map(origTree);
  const { failures, moves } = applyEdits(tree, edits, strict);
  if (failures.length > 0) {
    const out =
      failures.map((f) => `error: ${f.code} ${f.path}`).join('\n') +
      `\nfailed: ${failures.length} of ${edits.length} edits\n`;
    return { out, code: 1 };
  }
  const outLines = computeOutput(origTree, tree, moves);
  if (!check) writeTree(origTree, tree);
  const n = outLines.length;
  const out = outLines.map((l) => `${l}\n`).join('') + `ok: ${n} ${n === 1 ? 'file' : 'files'}\n`;
  return { out, code: 0 };
}

const result = await main();
if (result.out !== '') process.stdout.write(result.out);
process.exitCode = result.code;
