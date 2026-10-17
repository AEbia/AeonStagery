import { describe, expect, it } from 'vitest';
import { normalizeCapabilityQuery } from '../services/project-agent/ProjectAgentCapabilityQueries';

describe('capability text matching', () => {
  it.each([
    ['', 'mygo/anon/idle', '', true],
    ['ANGRY', 'mygo/anon/angry01', '', true],
    ['生气', 'mygo/anon/angry01', '很生气', true],
    ['smile', 'mygo/anon/angry01', '', false],
    ['mygo/anon/*', 'mygo/anon/angry01', '', true],
    ['mygo/anon/*', 'mygo/taki/angry01', '', false],
    ['MYGO/ANON/*ANGRY*_LIVE_01', 'mygo/anon/mtn_angry01_C_live_01', '', true],
    ['mygo/anon/*angry*_live_01', 'mygo/anon/mtn_angry01_C_live_01_mask', '', false],
    ['mygo/anon/*angry*_live_01', 'mygo/anon/mtn_angry01_C_casual_01', '', false],
    ['anon/*', 'mygo/anon/idle', '', false],
    ['*angry*', 'mygo/anon/idle', 'angry', false],
    ['mygo/*live_01', 'mygo/anon/subdir/mtn_angry_live_01', '', true],
    ['mygo/anon/exp_?', 'mygo/anon/exp_笑', '', true],
    ['mygo/anon/exp_?', 'mygo/anon/exp_😀', '', true],
    ['mygo/anon/exp_?', 'mygo/anon/exp_笑笑', '', false],
    ['mygo/anon/(a+b).[1]*', 'mygo/anon/(a+b).[1]live', '', true],
    ['mygo/anon/(a+b).[1]*', 'mygo/anon/abX1live', '', false],
    ['*', '*literal', '', true],
    ['**a*b**c', 'aaabbbbbc', '', true],
    ['*a*b*c', 'aaabbbbbd', '', false],
    ['a*', 'a', '', true],
    ['?', '', '', false],
    ['?', '\n', '', true],
  ])('matches %j against %j (description %j): %j', (text, key, description, expected) => {
    const query = normalizeCapabilityQuery({ text });
    expect(query.ok).toBe(true);
    if (query.ok) expect(query.matches({ key, description })).toBe(expected);
  });
});
