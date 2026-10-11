/**
 * Split a (possibly still streaming) Markdown reply into what Discord can show
 * as text and the blocks it cannot: GFM tables, display math and mermaid
 * diagrams. Those are rendered to images and posted where they stand in the
 * reply, so the text around them keeps flowing into ordinary messages.
 *
 * Everything here is pure and works on a growing string: a block counts as
 * `done` only once something after it proves it ended (or the reply is
 * complete), so a half-written table is never photographed.
 */

export type BlockKind = 'table' | 'math' | 'mermaid';

export type Segment =
  | { type: 'text'; text: string }
  | { type: 'block'; kind: BlockKind; source: string; done: boolean };

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const TABLE_ROW = /^\s*\|/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export function segmentReply(text: string, complete: boolean): Segment[] {
  const lines = text.split('\n');
  const starts: number[] = [];
  for (let i = 0, at = 0; i < lines.length; at += lines[i].length + 1, i++) starts.push(at);
  const last = lines.length - 1;
  // A line is settled once a newline follows it, or the reply is over.
  const settled = (i: number) => i < last || complete;

  const segments: Segment[] = [];
  let cursor = 0;
  const pushBlock = (kind: BlockKind, from: number, to: number, done: boolean) => {
    const start = starts[from];
    const end = starts[to] + lines[to].length;
    if (start > cursor) segments.push({ type: 'text', text: text.slice(cursor, start) });
    segments.push({ type: 'block', kind, source: text.slice(start, end), done });
    // Swallow the newline that ends the block; spacing is the messages' job.
    cursor = Math.min(text.length, end + 1);
  };

  let fence: string | null = null;
  for (let i = 0; i <= last; i++) {
    const line = lines[i];
    if (fence) {
      const close = FENCE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length && !close[2].trim())
        fence = null;
      continue;
    }

    const open = FENCE.exec(line);
    if (open) {
      if (/^\s*mermaid\b/i.test(open[2])) {
        let j = i + 1;
        let closed = -1;
        for (; j <= last; j++) {
          const close = FENCE.exec(lines[j]);
          if (
            close &&
            close[1][0] === open[1][0] &&
            close[1].length >= open[1].length &&
            !close[2].trim()
          ) {
            closed = j;
            break;
          }
        }
        const done = closed >= 0 && settled(closed);
        pushBlock('mermaid', i, closed >= 0 ? closed : last, done);
        if (closed < 0) break;
        i = closed;
        continue;
      }
      fence = open[1];
      continue;
    }

    const trimmed = line.trim();
    if (trimmed.startsWith('$$') || trimmed.startsWith('\\[')) {
      const closer = trimmed.startsWith('$$') ? '$$' : '\\]';
      const single = trimmed.length > 2 * closer.length && trimmed.endsWith(closer);
      let closed = single ? i : -1;
      for (let j = i + 1; closed < 0 && j <= last; j++)
        if (lines[j].trim().endsWith(closer)) closed = j;
      const done = closed >= 0 && settled(closed);
      pushBlock('math', i, closed >= 0 ? closed : last, done);
      if (closed < 0) break;
      i = closed;
      continue;
    }

    if (TABLE_ROW.test(line)) {
      let j = i;
      while (j <= last && TABLE_ROW.test(lines[j])) j++;
      const end = j - 1;
      const isTable = end > i && TABLE_SEPARATOR.test(lines[i + 1]) && lines[i + 1].includes('-');
      // Still at the tail: more rows (or the separator) may yet arrive.
      const open = !complete && (j > last || (j === last && lines[last] === ''));
      // A header row (and maybe a half-typed separator) at the tail may still
      // turn out to be a table: hold it behind the placeholder until it does.
      const maybe = open && (end === i || (end === i + 1 && end === last));
      if (isTable || maybe) {
        pushBlock('table', i, end, isTable && !open);
        i = end;
        if (open) break;
        continue;
      }
      i = end;
    }
  }
  if (cursor < text.length) segments.push({ type: 'text', text: text.slice(cursor) });
  // A tail block that was cut short leaves nothing after it to emit.
  return segments.filter((s) => s.type === 'block' || s.text.length);
}

export interface Cut {
  /** Where in `text` the block stood. Everything before it is already final. */
  at: number;
  kind: BlockKind;
  source: string;
}

export interface DiscordView {
  /** What the Discord messages show, with every finished block removed. */
  text: string;
  /** Finished blocks, in order, each to be posted as an image at `at`. */
  cuts: Cut[];
}

const PLACEHOLDER: Record<BlockKind, string> = {
  table: '⏳ 表格生成中…',
  math: '⏳ 公式生成中…',
  mermaid: '⏳ 流程圖生成中…',
};

/**
 * The reply as Discord should show it: text with inline math made readable,
 * a placeholder where a block is still being written, and nothing where a
 * finished block will stand as an image. The text before each cut never
 * changes once the cut exists, so message offsets stay valid.
 */
export function discordView(reply: string, complete: boolean): DiscordView {
  let text = '';
  const cuts: Cut[] = [];
  if (!complete) {
    // A half-typed fence or $$ line would flash as raw text before it is
    // recognised; hold the partial line back until its newline arrives.
    const tail = reply.slice(reply.lastIndexOf('\n') + 1);
    if (/^ {0,3}(?:`{1,3}|~{1,3}|\$\$?|\\\[?)$|^ {0,3}(?:`{3}|~{3}|\$\$|\\\[)/.test(tail))
      reply = reply.slice(0, reply.length - tail.length);
  }
  const segments = segmentReply(reply, complete);
  segments.forEach((segment, index) => {
    if (segment.type === 'text') {
      let part = inlineMathToUnicode(segment.text);
      if (cuts.length && cuts.at(-1)!.at === text.length) part = part.replace(/^\s+/, '');
      if (segments[index + 1]?.type === 'block') part = part.replace(/\s+$/, '');
      text += part;
      return;
    }
    if (segment.done) {
      cuts.push({ at: text.length, kind: segment.kind, source: segment.source });
      return;
    }
    text += `${text && !text.endsWith('\n') ? '\n\n' : ''}${PLACEHOLDER[segment.kind]}`;
  });
  return { text, cuts };
}

// ── inline math → Unicode ──────────────────────────────────────────────

const SYMBOLS: Record<string, string> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  varepsilon: 'ε',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  vartheta: 'ϑ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  rho: 'ρ',
  sigma: 'σ',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'φ',
  varphi: 'φ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
  times: '×',
  cdot: '·',
  div: '÷',
  pm: '±',
  mp: '∓',
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  ne: '≠',
  neq: '≠',
  approx: '≈',
  equiv: '≡',
  sim: '∼',
  simeq: '≃',
  propto: '∝',
  infty: '∞',
  sum: '∑',
  prod: '∏',
  int: '∫',
  oint: '∮',
  partial: '∂',
  nabla: '∇',
  to: '→',
  rightarrow: '→',
  leftarrow: '←',
  Rightarrow: '⇒',
  Leftarrow: '⇐',
  leftrightarrow: '↔',
  Leftrightarrow: '⇔',
  implies: '⇒',
  iff: '⇔',
  mapsto: '↦',
  in: '∈',
  notin: '∉',
  ni: '∋',
  subset: '⊂',
  subseteq: '⊆',
  supset: '⊃',
  supseteq: '⊇',
  cup: '∪',
  cap: '∩',
  forall: '∀',
  exists: '∃',
  emptyset: '∅',
  varnothing: '∅',
  ldots: '…',
  cdots: '⋯',
  dots: '…',
  circ: '∘',
  degree: '°',
  angle: '∠',
  perp: '⊥',
  parallel: '∥',
  neg: '¬',
  lnot: '¬',
  land: '∧',
  wedge: '∧',
  lor: '∨',
  vee: '∨',
  oplus: '⊕',
  otimes: '⊗',
  star: '⋆',
  ast: '∗',
  prime: '′',
  hbar: 'ℏ',
  ell: 'ℓ',
  Re: 'ℜ',
  Im: 'ℑ',
  aleph: 'ℵ',
  lfloor: '⌊',
  rfloor: '⌋',
  lceil: '⌈',
  rceil: '⌉',
  langle: '⟨',
  rangle: '⟩',
  mid: '∣',
  vert: '|',
  Vert: '‖',
  ll: '≪',
  gg: '≫',
  cong: '≅',
  triangle: '△',
  log: 'log',
  ln: 'ln',
  exp: 'exp',
  sin: 'sin',
  cos: 'cos',
  tan: 'tan',
  lim: 'lim',
  max: 'max',
  min: 'min',
  det: 'det',
  gcd: 'gcd',
  mod: 'mod',
  bmod: 'mod',
  percent: '%',
};
const BLACKBOARD: Record<string, string> = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', P: 'ℙ' };
const SUP: Record<string, string> = Object.fromEntries(
  [...'0123456789+-=()niabcdefghjklmoprstuvwxyzT'].map((c, k) => [
    c,
    [...'⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱᵃᵇᶜᵈᵉᶠᵍʰʲᵏˡᵐᵒᵖʳˢᵗᵘᵛʷˣʸᶻᵀ'][k],
  ]),
);
const SUB: Record<string, string> = Object.fromEntries(
  [...'0123456789+-=()aehijklmnoprstuvx'].map((c, k) => [
    c,
    [...'₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ'][k],
  ]),
);

/** Read one TeX argument at `i`: a {group} or a single (possibly \command) token. */
function readArg(s: string, i: number): [string, number] | null {
  while (s[i] === ' ') i++;
  if (s[i] === '{') {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}' && --depth === 0) return [s.slice(i + 1, j), j + 1];
    }
    return null;
  }
  if (s[i] === '\\') {
    const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i));
    return m ? [m[0], i + m[0].length] : null;
  }
  return i < s.length ? [s[i], i + 1] : null;
}

const wrap = (s: string) => (/^(?:\\[A-Za-z]+|[\p{L}\p{N}.′√]+|\(.*\))$/u.test(s) ? s : `(${s})`);

/** Best-effort TeX → plain Unicode. Returns null when the result would mislead. */
export function texToUnicode(tex: string): string | null {
  let s = tex;
  for (let guard = 0; guard < 20; guard++) {
    const before = s;
    s = s.replace(
      /\\(?:text|mathrm|mathit|mathbf|operatorname|textbf|textit|mbox)\s*\{([^{}]*)\}/g,
      '$1',
    );
    s = s.replace(/\\mathbb\s*\{?([A-Z])\}?/g, (_m, c) => BLACKBOARD[c] ?? c);
    s = s.replace(/\\[dt]?frac\s*/g, '\\frac');
    // Plain symbols first, so \frac{\sqrt{\pi}}{2} wraps "√π", not raw TeX.
    s = s.replace(/\\([A-Za-z]+)(?![A-Za-z])/g, (m, name) => SYMBOLS[name] ?? m);
    const sqrt = s.indexOf('\\sqrt');
    if (sqrt >= 0) {
      const a = readArg(s, sqrt + 5);
      if (!a) return null;
      s = `${s.slice(0, sqrt)}√${wrap(a[0])}${s.slice(a[1])}`;
    }
    const frac = s.indexOf('\\frac');
    if (frac >= 0) {
      const a = readArg(s, frac + 5);
      const b = a && readArg(s, a[1]);
      if (!a || !b) return null;
      s = `${s.slice(0, frac)}${wrap(a[0])}/${wrap(b[0])}${s.slice(b[1])}`;
    }
    if (s === before) break;
  }
  s = s
    .replace(/\\left|\\right|\\big|\\Big|\\bigg|\\Bigg|\\displaystyle/g, '')
    .replace(/\\[,;:! ]|\\quad|\\qquad|~/g, ' ')
    .replace(/\\([{}%$&#_])/g, '$1')
    .replace(/\\([A-Za-z]+)/g, (m, name) => SYMBOLS[name] ?? m);
  if (/\\/.test(s)) return null;

  // Scripts: ^x, ^{...}, _x, _{...}
  let out = '';
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === '^' || c === '_') {
      const arg = readArg(s, i + 1);
      if (!arg) return null;
      const table = c === '^' ? SUP : SUB;
      const chars = [...arg[0].replace(/\s+/g, '')];
      out += chars.every((ch) => table[ch])
        ? chars.map((ch) => table[ch]).join('')
        : c === '^'
          ? `^${wrap(arg[0])}`
          : `_${wrap(arg[0])}`;
      i = arg[1];
      continue;
    }
    out += c;
    i++;
  }
  out = out
    .replace(/[{}]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return out || null;
}

const CODE_OR_MATH =
  /(```[\s\S]*?(?:```|$)|`[^`\n]*`)|\$(?![\s$])([^$\n]*?[^\s\\$])\$(?![\d$])|\\\((.+?)\\\)/g;

/** Rewrite $…$ and \(…\) outside code; what cannot be converted becomes `code`. */
export function inlineMathToUnicode(text: string): string {
  return text.replace(CODE_OR_MATH, (match, code, dollar, paren) => {
    if (code) return code;
    const tex = dollar ?? paren;
    // "$5 and $10" is money, not math.
    if (dollar && !/[\\^_=a-zA-Z{}]/.test(tex)) return match;
    return texToUnicode(tex) ?? `\`${tex}\``;
  });
}
