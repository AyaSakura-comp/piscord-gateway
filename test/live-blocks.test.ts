import { describe, expect, it } from 'vitest';
import {
  discordView,
  inlineMathToUnicode,
  segmentReply,
  texToUnicode,
} from '../src/live-page/blocks.js';

const REPLY = [
  '比較如下：',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '公式 $(1+r)^n$：',
  '',
  '$$',
  'x^2',
  '$$',
  '',
  '```mermaid',
  'graph TD',
  'A-->B',
  '```',
  '結尾',
].join('\n');

describe('segmentReply', () => {
  it('finds tables, display math and mermaid, leaving the rest as text', () => {
    const kinds = segmentReply(REPLY, true)
      .filter((s) => s.type === 'block' || s.text.trim())
      .map((s) => (s.type === 'text' ? 'text' : s.kind));
    expect(kinds).toEqual(['text', 'table', 'text', 'math', 'mermaid', 'text']);
  });

  it('leaves ordinary code fences alone, including pipes and $$ inside them', () => {
    const text = '```python\n| a | b |\n|---|---|\n$$\n```\nafter';
    expect(segmentReply(text, true)).toEqual([{ type: 'text', text }]);
  });

  it('does not treat stray pipes as a table', () => {
    const text = '| not a table\nplain line\n';
    expect(segmentReply(text, false).every((s) => s.type === 'text')).toBe(true);
  });
});

describe('discordView while streaming', () => {
  const at = (n: number) => discordView(REPLY.slice(0, n), false);

  it('holds a table behind a placeholder until a line after it proves it ended', () => {
    const tableEnd = REPLY.indexOf('| 1 | 2 |') + '| 1 | 2 |'.length;
    expect(at(tableEnd).text).toBe('比較如下：\n\n⏳ 表格生成中…');
    expect(at(tableEnd).cuts).toEqual([]);
    // One more row could still arrive after a bare newline.
    expect(at(tableEnd + 1).cuts).toEqual([]);
    const after = at(tableEnd + 3);
    expect(after.cuts.map((c) => c.kind)).toEqual(['table']);
    expect(after.cuts[0].source).toBe('| a | b |\n|---|---|\n| 1 | 2 |');
  });

  it('never changes the text before a cut once the cut exists', () => {
    const final = discordView(REPLY, true);
    for (let n = 1; n <= REPLY.length; n++) {
      const view = at(n);
      for (const cut of view.cuts) {
        expect(view.text.slice(0, cut.at)).toBe(final.text.slice(0, cut.at));
      }
    }
  });

  it('never shows a half-typed fence or $$ line as raw text', () => {
    for (let n = 1; n <= REPLY.length; n++) {
      const { text } = at(n);
      expect(text).not.toMatch(/```|\$\$|^\|/m);
    }
  });

  it('closes a block left at the very end when the reply completes', () => {
    const text = 'intro\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    expect(discordView(text, false).cuts).toEqual([]);
    expect(discordView(text, true).cuts.map((c) => c.kind)).toEqual(['table']);
    expect(discordView(text, true).text).toBe('intro');
  });

  it('cuts consecutive blocks at the same offset, in order', () => {
    const final = discordView(REPLY, true);
    expect(final.cuts.map((c) => c.kind)).toEqual(['table', 'math', 'mermaid']);
    expect(final.cuts[1].at).toBe(final.cuts[2].at);
    expect(final.text).toBe('比較如下：公式 (1+r)ⁿ：結尾');
  });
});

describe('inline math', () => {
  it('turns common TeX into readable Unicode', () => {
    expect(texToUnicode('(1+r)^n')).toBe('(1+r)ⁿ');
    expect(texToUnicode('\\alpha_i \\le \\beta')).toBe('αᵢ ≤ β');
    expect(texToUnicode('\\frac{\\sqrt{\\pi}}{2}')).toBe('√π/2');
    expect(texToUnicode('x \\in \\mathbb{R}')).toBe('x ∈ ℝ');
  });

  it('keeps what it cannot convert as code instead of mangling it', () => {
    expect(inlineMathToUnicode('$\\begin{pmatrix}a\\end{pmatrix}$')).toBe(
      '`\\begin{pmatrix}a\\end{pmatrix}`',
    );
  });

  it('leaves money and code spans alone', () => {
    expect(inlineMathToUnicode('costs $5 to $10')).toBe('costs $5 to $10');
    expect(inlineMathToUnicode('run `echo $x$` now')).toBe('run `echo $x$` now');
    expect(inlineMathToUnicode('$x^2$ and \\(y_1\\)')).toBe('x² and y₁');
  });
});
