import { campaignMatcher } from '../campaign-filter';

describe('campaignMatcher', () => {
  it('sem filtro, nao filtra nada (null)', () => {
    expect(campaignMatcher(null)).toBeNull();
    expect(campaignMatcher('  , ')).toBeNull();
  });

  it('acha a palavra no nome, sem maiuscula nem acento', () => {
    const m = campaignMatcher('nutri')!;
    expect(m('[CBO] 14/10 REELS NUTRIÇÃO ESPORTIVA')).toBe(true);
    expect(m('[CBO] 24/09 REELS PSICOLOGIA')).toBe(false);
  });

  it('varias palavras: basta uma casar', () => {
    const m = campaignMatcher('PSICOLOGIA, PSICO, TCC')!;
    expect(m('[CBO] 12/10 REELS PSICOLOGIA [PORTUGAL]')).toBe(true);
    expect(m('Pack TCC')).toBe(true);
    expect(m('[CBO] REELS ACADEMIA')).toBe(false);
    expect(m(null)).toBe(false);
  });
});
