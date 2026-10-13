import {
  buildTargetUrl,
  pickPlatform,
  readVariantCookie,
  segmentOf,
  sessionFromParams,
  signTest,
  signVariantCookie,
  verifyTest,
} from '../ab-core';
import { buildReport, wilson, AssignmentRow, SaleRow } from '../ab-report';

const SECRET = 'segredo';
const SID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('ab-core', () => {
  it('sorteia pelo split', () => {
    expect(pickPlatform(50, 0.49)).toBe('hotmart');
    expect(pickPlatform(50, 0.5)).toBe('kiwify');
    expect(pickPlatform(100, 0.999)).toBe('hotmart');
    expect(pickPlatform(0, 0)).toBe('kiwify');
  });

  it('acha o código da visita no sck', () => {
    expect(sessionFromParams({ sck: `stl_${SID}` })).toBe(SID);
    expect(sessionFromParams({ sck: 'outra-coisa' })).toBeNull();
  });

  it('separa pago de orgânico', () => {
    expect(segmentOf({ utm_source: 'FB' }, null)).toBe('pago');
    expect(segmentOf({ ad_id: '120212345678901' }, null)).toBe('pago');
    expect(segmentOf({}, 'fb.1.123.abc')).toBe('pago');
    expect(segmentOf({ utm_source: 'ig_bio' }, null)).toBe('organico');
  });

  it('forcar só vale assinado e no prazo', () => {
    const now = 1_000_000;
    const exp = now + 3600_000;
    const sig = signTest(SECRET, 'nutri', 'kiwify', exp);
    expect(verifyTest(SECRET, 'nutri', 'kiwify', String(exp), sig, now)).toEqual({ platform: 'kiwify', invalid: false });
    expect(verifyTest(SECRET, 'nutri', 'hotmart', String(exp), sig, now).invalid).toBe(true);
    expect(verifyTest(SECRET, 'outro', 'kiwify', String(exp), sig, now).invalid).toBe(true);
    expect(verifyTest(SECRET, 'nutri', 'kiwify', String(exp), sig, exp + 1).invalid).toBe(true);
    expect(verifyTest(SECRET, 'nutri', 'kiwify', undefined, undefined, now).invalid).toBe(true);
    expect(verifyTest(SECRET, 'nutri', undefined, undefined, undefined, now)).toEqual({ platform: null, invalid: false });
  });

  it('cookie da variante não pode ser trocado à mão', () => {
    const c = signVariantCookie(SECRET, 'nutri', 'hotmart');
    expect(readVariantCookie(SECRET, 'nutri', c)).toBe('hotmart');
    expect(readVariantCookie(SECRET, 'nutri', c.replace('hotmart', 'kiwify'))).toBeNull();
    expect(readVariantCookie(SECRET, 'outro', c)).toBeNull();
    expect(readVariantCookie(SECRET, 'nutri', 'kiwify')).toBeNull();
  });

  it('monta o link da Hotmart com xcod e pacote, sem sobrescrever a URL cadastrada', () => {
    const url = new URL(
      buildTargetUrl('https://pay.hotmart.com/W104451275M?checkoutMode=10', 'hotmart', {
        sck: `stl_${SID}`,
        utm_source: 'FB',
        utm_campaign: 'Nutri',
        ad_id: '120212345678901',
        checkoutMode: '2',
        produto: 'nutri',
      }),
    );
    expect(url.origin).toBe('https://pay.hotmart.com');
    expect(url.searchParams.get('checkoutMode')).toBe('10');
    expect(url.searchParams.get('xcod')).toBe('120212345678901');
    expect(url.searchParams.get('sck')).toBe(`stl_${SID}`);
    expect(url.searchParams.get('src')).toContain('|120212345678901|');
    expect(url.searchParams.has('produto')).toBe(false);
  });

  it('na Kiwify o id do anúncio vai no utm_content', () => {
    const url = new URL(buildTargetUrl('https://pay.kiwify.com.br/abc', 'kiwify', { utm_content: 'nome do anuncio', ad_id: '120212345678901' }));
    expect(url.searchParams.get('utm_content')).toBe('120212345678901');
  });
});

describe('ab-report', () => {
  const a = (visitor: string, platform: 'hotmart' | 'kiwify', segment: 'pago' | 'organico' = 'pago'): AssignmentRow => ({
    visitor_id: visitor, session_id: null, platform, segment, first_seen_at: '2026-10-14T10:00:00Z',
  });
  const sale = (over: Partial<SaleRow>): SaleRow => ({
    id: Math.random().toString(), external_id: null, order_external_id: null, is_order_bump: false,
    visitor_id: null, session_id: null, sck: null, platform: null, status: 'approved', amount: 47.9,
    gross_amount: 47.9, fee_amount: 5.73, net_amount: 42.17, refunded_amount: null, sold_at: '2026-10-14T10:05:00Z', ...over,
  });

  it('intervalo de Wilson', () => {
    const w = wilson(5, 100);
    expect(w.value).toBeCloseTo(0.05);
    expect(w.low).toBeGreaterThan(0.02);
    expect(w.high).toBeLessThan(0.12);
  });

  it('conta compradores, bumps, líquido por visitante e reembolso parcial', () => {
    const assignments = [a('v1', 'hotmart'), a('v2', 'hotmart'), a('v3', 'kiwify', 'organico'), a('v4', 'kiwify')];
    const sales = [
      sale({ visitor_id: 'v1', external_id: 'H1', order_external_id: 'H1', platform: 'hotmart' }),
      sale({ visitor_id: 'v1', external_id: 'H2', order_external_id: 'H1', is_order_bump: true, platform: 'hotmart', gross_amount: 21, net_amount: 18, fee_amount: 3 }),
      sale({ visitor_id: 'v3', external_id: 'K1', platform: 'kiwify', status: 'refunded', refunded_amount: 47.9 }),
      // venda na plataforma errada: não conta, é sinalizada
      sale({ visitor_id: 'v4', external_id: 'X1', platform: 'hotmart' }),
      // venda anterior ao encaminhamento
      sale({ visitor_id: 'v2', external_id: 'H9', platform: 'hotmart', sold_at: '2026-10-13T10:00:00Z' }),
    ];
    const { arms, verdict } = buildReport(assignments, sales);
    const [h, k] = arms;
    expect(h.visitors).toBe(2);
    expect(h.buyers).toBe(1);
    expect(h.orders).toBe(1);
    expect(h.ordersWithBump).toBe(1);
    expect(h.net).toBeCloseTo(60.17);
    expect(h.netPerVisitor.value).toBeCloseTo(30.09, 1);
    expect(k.buyers).toBe(1);
    expect(k.refunds).toBe(1);
    expect(k.net).toBe(0);
    expect(k.platformMismatch).toBe(1);
    expect(k.segments.organico.buyers).toBe(1);
    expect(verdict.status).toBe('amostra_insuficiente');
  });
});
