// mend: applies an AI-written edit to a tree of text files.
//
// The edit comes as a patch in one of four shapes — a unified diff, SEARCH/REPLACE
// blocks, the V4A patch format, or JSON editor calls — and mend reads it the way
// SPEC.md says, finds the lines each edit names at the first of three matching
// tiers (exact, trailing whitespace ignored, both sides trimmed with re-indent),
// and writes every change or none at all. Node 22, standard library only; run it
// as `node main.ts [options] [PATCH]` with the working directory as the tree root.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

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

/** A patch's lines: split at \n, one trailing \r removed each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A file's lines, its line break, and whether it ends with one. */
interface FileState {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function serializeFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.finalBreak ? st.br : '');
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
}

type Edit = (tree: Tree) => void;

/** Section 5: a line at a tier — 0 exact, 1 trailing spaces/tabs off, 2 both sides off. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** The first tier at which O occurs in `lines` from `from`, with every position there. */
function findOcc(lines: string[], o: string[], strict: boolean, from: number): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos: number[] = [];
    for (let i = from; i + o.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (normLine(lines[i + j]!, t) !== normLine(o[j]!, t)) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The first line at or after `from` equal to a single-line anchor, at the first tier with one. */
function findSingle(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === normLine(anchor, t)) return i;
    }
  }
  return null;
}

/**
 * The N lines as written: a context line (nCtx[k] >= 0) is the file's own matched
 * line; at tier 2 every other non-empty line starting with O's first leading
 * whitespace has that prefix swapped for the file's first matched line's.
 */
function buildNew(o: string[], n: string[], nCtx: number[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const f = tier === 2 ? leadWs(fileLines[pos] ?? '') : '';
  const p = tier === 2 ? leadWs(o[0] ?? '') : '';
  for (let k = 0; k < n.length; k++) {
    const ci = nCtx[k]!;
    if (ci >= 0) {
      out.push(fileLines[pos + ci]!);
      continue;
    }
    const line = n[k]!;
    if (tier === 2 && line !== '' && !/^[ \t]*$/.test(line) && line.startsWith(p)) out.push(f + line.slice(p.length));
    else out.push(line);
  }
  return out;
}

/** Section 4: which format an auto patch is, or null when none fits. */
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

/** One JSON edit object (section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const read = (tree: Tree): string => {
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
      const before = read(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = read(tree);
      const st = parseFile(before);
      if (line < 0 || line > st.lines.length) throw new Fail('no-match', p);
      const next = [...st.lines.slice(0, line), ...add, ...st.lines.slice(line)];
      tree.now.set(p, serializeFile({ lines: next, br: st.br, finalBreak: st.finalBreak }));
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

/** One body line of a unified hunk or a V4A chunk. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

/** O, N and, for each N line, its O index when it is a context line, else -1. */
function splitBody(body: BodyLine[]): { o: string[]; n: string[]; nCtx: number[]; nKind: Array<'ctx' | 'new'> } {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: number[] = [];
  const nKind: Array<'ctx' | 'new'> = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      nCtx.push(o.length);
      nKind.push('ctx');
      o.push(b.text);
      n.push(b.text);
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      nCtx.push(-1);
      nKind.push('new');
      n.push(b.text);
    }
  }
  return { o, n, nCtx, nKind };
}

/** Empty context lines at the end of a body are not part of it. */
function trimBodyTail(body: BodyLine[]): void {
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') body.pop();
    else break;
  }
}

/** Section 6: one unified hunk. */
interface UniHunk {
  a: number;
  o: string[];
  n: string[];
  nCtx: number[];
  nKind: Array<'ctx' | 'new'>;
  noNl: boolean;
  lastPlusNoNl: boolean;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A hunk body: lines after the header, up to the first line that is not one. */
function parseUniHunk(lines: string[], i: number, m: RegExpExecArray, hunks: UniHunk[]): number {
  const total = lines.length;
  const a = parseInt(m[1]!, 10);
  i += 1;
  const body: BodyLine[] = [];
  while (i < total) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line === '') {
      body.push({ kind: 'ctx', text: '' });
      i += 1;
      continue;
    }
    const c = line[0]!;
    if (c === ' ') {
      body.push({ kind: 'ctx', text: line.slice(1) });
      i += 1;
      continue;
    }
    if (c === '-') {
      body.push({ kind: 'old', text: line.slice(1) });
      i += 1;
      continue;
    }
    if (c === '+') {
      body.push({ kind: 'new', text: line.slice(1) });
      i += 1;
      continue;
    }
    if (c === '\\') {
      body.push({ kind: 'bs', text: line.slice(1) });
      i += 1;
      continue;
    }
    break;
  }
  trimBodyTail(body);
  const { o, n, nCtx, nKind } = splitBody(body);
  let noNl = false;
  let lastPlusNoNl = false;
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') {
      noNl = k + 1 < body.length && body[k + 1]!.kind === 'bs';
      break;
    }
  }
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.kind === 'new') {
      lastPlusNoNl = k + 1 < body.length && body[k + 1]!.kind === 'bs';
      break;
    }
  }
  hunks.push({ a, o, n, nCtx, nKind, noNl, lastPlusNoNl });
  return i;
}

/** Apply one hunk to a file state; d is the drift of this section's hunks so far. */
function applyUniHunk(st: FileState, h: UniHunk, d: number, strict: boolean, path: string): FileState {
  const lines = st.lines;
  if (h.o.length > 0) {
    const found = findOcc(lines, h.o, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    for (const p of found.pos) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const repl = buildNew(h.o, h.n, h.nCtx, lines, best, found.tier);
    const toEnd = best + h.o.length === lines.length;
    return {
      lines: [...lines.slice(0, best), ...repl, ...lines.slice(best + h.o.length)],
      br: st.br,
      finalBreak: toEnd ? !h.noNl : st.finalBreak,
    };
  }
  const at = Math.max(0, Math.min(h.a + d, lines.length));
  const repl = buildNew(h.o, h.n, h.nCtx, lines, at, 0);
  return {
    lines: [...lines.slice(0, at), ...repl, ...lines.slice(at)],
    br: st.br,
    finalBreak: at === lines.length ? !h.noNl : st.finalBreak,
  };
}

/** Section 6: one section of a unified diff is one edit. */
interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: UniHunk[];
}

function uniSectionEdit(sec: UniSection, strict: boolean, moves: Array<[string, string]>): Edit {
  return (tree) => {
    const { oldPath, newPath } = sec;
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (sec.create) {
      if (newPath === null) throw new Fail('unsafe', '');
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (let k = 0; k < h.n.length; k++) if (h.nKind[k] === 'new') plus.push(h.n[k]!);
      }
      let noNl = false;
      for (let i = sec.hunks.length - 1; i >= 0; i--) {
        const h = sec.hunks[i]!;
        if (h.n.some((_, k) => h.nKind[k] === 'new')) {
          noNl = h.lastPlusNoNl;
          break;
        }
      }
      tree.now.set(newPath, serializeFile({ lines: plus, br: '\n', finalBreak: plus.length > 0 && !noNl }));
      return;
    }
    if (sec.del) {
      if (oldPath === null) throw new Fail('unsafe', '');
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath === null || newPath === null) throw new Fail('unsafe', oldPath ?? newPath ?? '');
    const isMove = oldPath !== newPath;
    const text = tree.get(oldPath);
    if (text === null) throw new Fail('missing', oldPath);
    if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    let st = parseFile(text);
    let d = 0;
    for (const h of sec.hunks) {
      st = applyUniHunk(st, h, d, strict, oldPath);
      d += h.n.length - h.o.length;
    }
    const out = serializeFile(st);
    if (isMove) {
      tree.now.set(newPath, out);
      tree.now.set(oldPath, null);
      moves.push([oldPath, newPath]);
    } else {
      tree.now.set(oldPath, out);
    }
  };
}

/** The path after `--- ` or `+++ `: up to the first tab, spaces off, a/ or b/ off. */
function parseUniPath(line: string): string {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** A `diff --git a/<X> b/<Y>` line, or a parse error at its line when it is not one. */
function parseDiffGit(line: string, lineNo: number): { x: string; y: string } {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${lineNo}`);
  const sep = rest.indexOf(' b/');
  if (sep < 0) throw new Exit2(`error: parse ${lineNo}`);
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') throw new Exit2(`error: parse ${lineNo}`);
  return { x, y };
}

/** One section: header lines, then hunks, until the next section or the patch ends. */
function parseUniSection(lines: string[], start: number, diffX: string | null, diffY: string | null, edits: Edit[], strict: boolean, moves: Array<[string, string]>): number {
  const n = lines.length;
  let oldPath: string | null = diffX;
  let newPath: string | null = diffY;
  let hasPair = false;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let create = false;
  let del = false;
  const hunks: UniHunk[] = [];
  let header = true;
  let i = start;
  const finish = (): number => {
    if (!hasPair) {
      if (renameFrom !== null) oldPath = renameFrom === '/dev/null' ? null : renameFrom;
      if (renameTo !== null) newPath = renameTo === '/dev/null' ? null : renameTo;
    }
    edits.push(uniSectionEdit({ oldPath, newPath, create, del, hunks }, strict, moves));
    return i;
  };
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) return finish();
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (header && !hasPair) {
        oldPath = parseUniPath(line);
        newPath = parseUniPath(lines[i + 1]!);
        if (oldPath === '/dev/null') oldPath = null;
        if (newPath === '/dev/null') newPath = null;
        hasPair = true;
        i += 2;
        continue;
      }
      return finish();
    }
    if (header) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      const m = HUNK_RE.exec(line);
      if (m !== null) {
        header = false;
        i = parseUniHunk(lines, i, m, hunks);
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      if (line.startsWith('rename from ')) {
        renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        create = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        del = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    const m = HUNK_RE.exec(line);
    if (m !== null) {
      i = parseUniHunk(lines, i, m, hunks);
      continue;
    }
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
  }
  return finish();
}

function unifiedEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const { x, y } = parseDiffGit(line, i + 1);
      i = parseUniSection(lines, i + 1, x, y, edits, strict, moves);
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      i = parseUniSection(lines, i, null, null, edits, strict, moves);
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return edits;
}

/** Section 7: one SEARCH/REPLACE block is one edit. */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, serializeFile({ lines: newLines, br: '\n', finalBreak: newLines.length > 0 }));
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const st = parseFile(text);
    const found = findOcc(st.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const repl = buildNew(oldLines, newLines, newLines.map(() => -1), st.lines, pos, found.tier);
    tree.now.set(path, serializeFile({ lines: [...st.lines.slice(0, pos), ...repl, ...st.lines.slice(pos + oldLines.length)], br: st.br, finalBreak: st.finalBreak }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let j = -1;
    for (let k = s + 1; k < n; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        j = k;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (j < 0) throw new Exit2(`error: parse ${s + 1}`);
    let r = -1;
    for (let k = j + 1; k < n; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        r = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (r < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let k = s - 1; k > prevReplace; k--) {
      const t = lines[k]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(srEdit(path, lines.slice(s + 1, j), lines.slice(j + 1, r), strict));
    prevPath = path;
    prevReplace = r;
    i = r + 1;
  }
  return edits;
}

/** Section 8: one V4A chunk. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: string[];
  nCtx: number[];
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, serializeFile({ lines: fileLines, br: '\n', finalBreak: fileLines.length > 0 }));
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean, moves: Array<[string, string]>): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let st = parseFile(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findSingle(st.lines, ch.anchor, strict, cursor);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? st.lines.length : cursor;
        st = { lines: [...st.lines.slice(0, at), ...ch.n, ...st.lines.slice(at)], br: st.br, finalBreak: st.finalBreak };
        cursor = at + ch.n.length;
        continue;
      }
      const found = findOcc(st.lines, ch.o, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      let pos: number | null = null;
      for (const p of found.pos) {
        if (ch.eof && p + ch.o.length !== st.lines.length) continue;
        pos = p;
        break;
      }
      if (pos === null) throw new Fail('no-match', path);
      const repl = buildNew(ch.o, ch.n, ch.nCtx, st.lines, pos, found.tier);
      st = { lines: [...st.lines.slice(0, pos), ...repl, ...st.lines.slice(pos + ch.o.length)], br: st.br, finalBreak: st.finalBreak };
      cursor = pos + repl.length;
    }
    const out = serializeFile(st);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean, moves: Array<[string, string]>): Edit[] {
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
  const isSectionStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i += 1;
      const fileLines: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('+')) {
          fileLines.push(l.slice(1));
          i += 1;
          continue;
        }
        if (l === '') {
          fileLines.push('');
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push(v4aAddEdit(path, fileLines));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (blank(l)) {
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLineNo = i + 1;
      i += 1;
      while (i < last && blank(lines[i]!)) i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: VChunk[] = [];
      let cur: { anchor: string | null; eof: boolean; body: BodyLine[] } | null = null;
      let firstChunk = true;
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          trimBodyTail(cur.body);
          const { o, n, nCtx } = splitBody(cur.body);
          chunks.push({ anchor: cur.anchor, eof: true, o, n, nCtx });
          cur = null;
          firstChunk = false;
          i += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          if (cur !== null) {
            const { o, n, nCtx } = splitBody(cur.body);
            chunks.push({ anchor: cur.anchor, eof: false, o, n, nCtx });
            cur = null;
          }
          cur = { anchor: l.slice(2).trim(), eof: false, body: [] };
          firstChunk = false;
          i += 1;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, eof: false, body: [] };
          }
          const kind = l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new';
          cur.body.push({ kind, text: l.slice(1) });
          i += 1;
          continue;
        }
        if (l === '') {
          if (cur !== null) {
            cur.body.push({ kind: 'ctx', text: '' });
            i += 1;
            continue;
          }
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (cur !== null) {
        trimBodyTail(cur.body);
        const { o, n, nCtx } = splitBody(cur.body);
        chunks.push({ anchor: cur.anchor, eof: false, o, n, nCtx });
        cur = null;
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict, moves));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
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
  const moves: Array<[string, string]> = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
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
  const covered = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      covered.add(oldP);
      covered.add(newP);
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const now = tree.now.get(p)!;
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
