// main.ts is mend, the CLI SPEC.md specifies (version 1). It reads AI-written edits in four formats
// (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool calls), finds the lines each edit
// names at the first of three matching tiers, and changes every file or none. Node 22, the standard
// library alone; run it as `node main.ts [options] [PATCH]`.
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

/* ------------------------------------------------------------------ */
/* Files as lines (SPEC.md section 3)                                  */
/* ------------------------------------------------------------------ */

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
  let final = false;
  if (text.endsWith(br)) {
    parts.pop();
    final = true;
  }
  return { lines: parts, br, final };
}

function renderFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}
function rtrimWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/* ------------------------------------------------------------------ */
/* Matching lines (SPEC.md section 5)                                  */
/* ------------------------------------------------------------------ */

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimWs(a) === rtrimWs(b);
  return trimWs(a) === trimWs(b);
}

function tiersFor(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

interface Found {
  tier: number;
  positions: number[];
}

function findOccurrences(lines: string[], o: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  const n = o.length;
  for (let i = from; i + n <= lines.length; i++) {
    if (eofOnly && i + n !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, then 1, then 2; 0 only when strict) with an occurrence at or after `from`. */
function findFirstTier(lines: string[], o: string[], from: number, strict: boolean, eofOnly = false): Found | null {
  for (const t of tiersFor(strict)) {
    const pos = findOccurrences(lines, o, t, from, eofOnly);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** First line at or after `from` equal to a single-line anchor, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  for (const t of tiersFor(strict)) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

/** One line of O (old) or N (new). `ctx` is the index of the context line it is, or -1. */
interface Entry {
  text: string;
  ctx: number;
}

function plainEntries(texts: string[]): Entry[] {
  return texts.map((text) => ({ text, ctx: -1 }));
}

/**
 * The lines of N that replace the matched lines. A context line is written as the file's own
 * matched line; at tier 2 every other line is re-indented from O's first line to the file's.
 */
function buildReplacement(fileLines: string[], pos: number, o: Entry[], n: Entry[], tier: number): string[] {
  const p = leadingWs(o[0]!.text);
  const f = leadingWs(fileLines[pos]!);
  const oCtx = new Map<number, number>();
  o.forEach((e, idx) => {
    if (e.ctx >= 0) oCtx.set(e.ctx, idx);
  });
  return n.map((e) => {
    if (e.ctx >= 0) return fileLines[pos + oCtx.get(e.ctx)!]!;
    if (tier === 2) {
      const t = e.text;
      if (t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) return f + t.slice(p.length);
      return t;
    }
    return e.text;
  });
}

/**
 * Split a hunk/chunk body into its old lines O and new lines N. Context lines (leading space,
 * or empty) are in both, linked by their context index. A `\` line is skipped here; whether one
 * follows the last context or `+` line is reported as `noEol`.
 */
function splitBody(body: string[]): { o: Entry[]; n: Entry[]; noEol: boolean } {
  const o: Entry[] = [];
  const n: Entry[] = [];
  let ctxCount = 0;
  let lastCtxPlus = -1;
  body.forEach((raw, idx) => {
    if (raw === '' || raw[0] === ' ') {
      const text = raw === '' ? '' : raw.slice(1);
      o.push({ text, ctx: ctxCount });
      n.push({ text, ctx: ctxCount });
      ctxCount += 1;
      lastCtxPlus = idx;
    } else if (raw[0] === '-') {
      o.push({ text: raw.slice(1), ctx: -1 });
    } else if (raw[0] === '+') {
      n.push({ text: raw.slice(1), ctx: -1 });
      lastCtxPlus = idx;
    }
  });
  const noEol =
    lastCtxPlus >= 0 && lastCtxPlus + 1 < body.length && body[lastCtxPlus + 1]![0] === '\\';
  return { o, n, noEol };
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  body: string[];
}

interface UnifiedSection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  gitOld: string | undefined;
  gitNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function newSection(): UnifiedSection {
  return {
    pairOld: undefined,
    pairNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    gitOld: undefined,
    gitNew: undefined,
    newFile: false,
    deletedFile: false,
    hunks: [],
  };
}

/** The path after `--- ` / `+++ ` (four characters), up to the first tab, spaces removed. */
function headerPath(line: string): string | null {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/')) rest = rest.slice(2);
  else if (rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

function setPair(sec: UnifiedSection, oldLine: string, newLine: string): void {
  sec.pairOld = headerPath(oldLine);
  sec.pairNew = headerPath(newLine);
}

const DIFF_GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (/^diff --git( |$)/.test(line)) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = m[1];
      cur.gitNew = m[2];
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // A pair belongs to the current section's header only when that header has no pair
      // yet; a further pair starts a new section.
      if (cur !== null && inHeader && cur.pairOld === undefined) {
        setPair(cur, line, lines[i + 1]!);
      } else {
        cur = newSection();
        setPair(cur, line, lines[i + 1]!);
        sections.push(cur);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = HUNK_RE.exec(line);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(hm[1]!, 10);
      const body: string[] = [];
      let j = i + 1;
      while (j < n) {
        const bl = lines[j]!;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push(bl);
          j += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a, body });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((sec) => unifiedEdit(sec, strict));
}

/** Whether a `\` line follows the last `+` line of all hunks (for a created file). */
function lastPlusNoEol(hunks: Hunk[]): boolean {
  for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const body = hunks[hi]!.body;
    for (let k = body.length - 1; k >= 0; k--) {
      if (body[k]![0] === '+') {
        return k + 1 < body.length && body[k + 1]![0] === '\\';
      }
    }
  }
  return false;
}

/** Apply a section's hunks in order to a file model, tracking the line drift `d`. */
function applyUnifiedHunks(model: FileModel, hunks: Hunk[], strict: boolean, failPath: string): void {
  let d = 0;
  for (const h of hunks) {
    const { o, n, noEol } = splitBody(h.body);
    if (o.length === 0) {
      const idx = Math.min(h.a + d, model.lines.length);
      const atEnd = idx === model.lines.length;
      const ins = n.map((e) => e.text);
      model.lines.splice(idx, 0, ...ins);
      if (atEnd) model.final = !noEol;
      d += n.length;
    } else {
      const found = findFirstTier(model.lines, o.map((e) => e.text), 0, strict);
      if (found === null) throw new Fail('no-match', failPath);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const atEnd = best + o.length === model.lines.length;
      const rep = buildReplacement(model.lines, best, o, n, found.tier);
      model.lines.splice(best, o.length, ...rep);
      if (atEnd) model.final = !noEol;
      d += n.length - o.length;
    }
  }
}

function unifiedEdit(sec: UnifiedSection, strict: boolean): Edit {
  return (tree) => {
    const oldPath =
      sec.pairOld !== undefined
        ? sec.pairOld
        : sec.renameFrom !== undefined
          ? sec.renameFrom
          : sec.gitOld;
    const newPath =
      sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew;
    if (oldPath === null && newPath === null) throw new Fail('missing', '/dev/null');
    const isCreate = sec.newFile || oldPath === null;
    const isDelete = sec.deletedFile || newPath === null;
    if (isCreate) {
      const np = newPath as string;
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const raw of h.body) if (raw[0] === '+') plus.push(raw.slice(1));
      }
      const model: FileModel = { lines: plus, br: '\n', final: plus.length > 0 && !lastPlusNoEol(sec.hunks) };
      tree.now.set(np, renderFile(model));
      return;
    }
    if (isDelete) {
      const op = oldPath as string;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldPath as string;
    const np = newPath as string;
    if (op === np) {
      if (!safe(op)) throw new Fail('unsafe', op);
      const cur = tree.get(op);
      if (cur === null) throw new Fail('missing', op);
      const model = parseFile(cur);
      applyUnifiedHunks(model, sec.hunks, strict, op);
      tree.now.set(op, renderFile(model));
      return;
    }
    if (!safe(op)) throw new Fail('unsafe', op);
    if (!safe(np)) throw new Fail('unsafe', np);
    const cur = tree.get(op);
    if (cur === null) throw new Fail('missing', op);
    if (tree.get(np) !== null) throw new Fail('exists', np);
    const model = parseFile(cur);
    applyUnifiedHunks(model, sec.hunks, strict, op);
    tree.now.set(np, renderFile(model));
    tree.now.set(op, null);
    tree.moves.push([op, np]);
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const model = parseFile(cur);
    const found = findFirstTier(model.lines, oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const rep = buildReplacement(
      model.lines,
      found.positions[0]!,
      plainEntries(oldLines),
      plainEntries(newLines),
      found.tier,
    );
    model.lines.splice(found.positions[0]!, oldLines.length, ...rep);
    tree.now.set(path, renderFile(model));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchIdx = i;
      let path: string | null = null;
      for (let j = searchIdx - 1; j > prevEnd; j--) {
        const t = lines[j]!.trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
        path = prevPath;
      }
      let eq = -1;
      for (let j = searchIdx + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
      const oldLines = lines.slice(searchIdx + 1, eq);
      const newLines = lines.slice(eq + 1, rep);
      edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
      prevPath = path;
      prevEnd = rep;
      i = rep + 1;
    } else {
      i += 1;
    }
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

function v4aEdit(
  kind: 'add' | 'delete' | 'update',
  path: string,
  addLines: string[] | null,
  moveTo: string | null,
  chunks: VChunk[],
  strict: boolean,
): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (kind === 'add') {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      const ls = addLines ?? [];
      tree.now.set(path, ls.length === 0 ? '' : `${ls.join('\n')}\n`);
      return;
    }
    if (kind === 'delete') {
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
      return;
    }
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = parseFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const a = findAnchor(model.lines, ch.anchor, cursor, strict);
        if (a === null) throw new Fail('no-match', path);
        cursor = a + 1;
      }
      const { o, n } = splitBody(ch.body);
      if (o.length === 0) {
        const idx = ch.eof ? model.lines.length : cursor;
        const ins = n.map((e) => e.text);
        model.lines.splice(idx, 0, ...ins);
        cursor = idx + ins.length;
      } else {
        const found = findFirstTier(model.lines, o.map((e) => e.text), cursor, strict, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.positions[0]!;
        const rep = buildReplacement(model.lines, pos, o, n, found.tier);
        model.lines.splice(pos, o.length, ...rep);
        cursor = pos + rep.length;
      }
    }
    const out = renderFile(model);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
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
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerNum = i + 1;
    let j = i + 1;
    while (j < last && !isSectionStart(lines[j]!)) j += 1;
    const raw: Array<{ text: string; num: number }> = [];
    for (let k = i + 1; k < j; k++) raw.push({ text: lines[k]!, num: k + 1 });
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
        else if (r.text === '') addLines.push('');
        else throw new Exit2(`error: parse ${r.num}`);
      }
      edits.push(v4aEdit('add', path, addLines, null, [], strict));
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.num}`);
      }
      edits.push(v4aEdit('delete', path, null, null, [], strict));
    } else {
      let idx = 0;
      let moveTo: string | null = null;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice(13).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (let k = idx; k < raw.length; k++) {
        const { text, num } = raw[k]!;
        if (text.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          cur = { anchor: text.slice(2).trim(), body: [], eof: false };
        } else if (text.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${num}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
        } else if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          cur.body.push(text);
        } else {
          throw new Exit2(`error: parse ${num}`);
        }
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerNum}`);
      edits.push(v4aEdit('update', path, null, moveTo, chunks, strict));
    }
    i = j;
  }
  return edits;
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
/* Running (SPEC.md sections 1, 2 and 10)                              */
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
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    if (!consumed.has(p)) rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
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
