import { describe, expect, it } from 'vitest';
import { formatStreamError, recoverTextFromParserError } from '../src/agent/invoke.js';

const LLAMA_PARSER_ERROR = `Failed to parse input at pos 22: <think>
The user "🐶🐰�🏻" is asking a follow-up question.
</think>

還是在問「為什麼」～但我還是沒看懂你指的是什麼呀 😅`;

describe('llama.cpp parser error recovery', () => {
  it('recovers the completed answer after the thinking block', () => {
    expect(recoverTextFromParserError(LLAMA_PARSER_ERROR)).toBe(
      '還是在問「為什麼」～但我還是沒看懂你指的是什麼呀 😅',
    );
  });

  it('does not recover an unexecuted tool call as answer text', () => {
    expect(
      recoverTextFromParserError(`Failed to parse input at pos 22: <think>bad bytes</think>
<tool_call>
<function=web_search></function>
</tool_call>`),
    ).toBeUndefined();
  });

  it('hides raw parser output when no completed answer can be recovered', () => {
    expect(formatStreamError('Failed to parse input at pos 22: <think>private reasoning')).toBe(
      '模型輸出格式解析失敗，請再試一次。',
    );
  });
});
