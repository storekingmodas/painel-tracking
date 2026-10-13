import { SalesService, productKeys } from '../sales.service';

/**
 * Com o webhook da conta inteira, a área da venda (e o pixel do Purchase) sai
 * da visita, depois da tabela de produtos, e por fim da área "Sem área".
 */
describe('SalesService.resolveArea', () => {
  const USER = 'u1';
  const PSICO = '11111111-1111-4111-8111-111111111111';
  const NUTRI = '22222222-2222-4222-8222-222222222222';
  const SEM = '33333333-3333-4333-8333-333333333333';
  const SID = 'cfe19a70-6837-474d-a264-dd394c12225a';

  type Tables = Record<string, any>;

  /** from(tabela) devolve o que estiver em `tables`; insert registra. */
  function build(tables: Tables) {
    const inserts: { table: string; row: any }[] = [];
    const from = (table: string) => {
      const b: any = {};
      for (const m of ['select', 'eq', 'in', 'limit', 'order']) b[m] = () => b;
      b.insert = (row: any) => { inserts.push({ table, row }); b._inserted = row; return b; };
      b.single = async () => ({ data: b._inserted ? { id: SEM } : tables[table], error: null });
      b.maybeSingle = async () => ({ data: Array.isArray(tables[table]) ? tables[table][0] ?? null : tables[table] ?? null, error: null });
      b.then = (ok: any) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(ok);
      return b;
    };
    const svc = new SalesService({ getClient: () => ({ from }) } as any, {} as any, {} as any, {} as any);
    return { svc, inserts };
  }

  const sale = (extra: Record<string, any> = {}) => ({
    user_id: USER, workspace_id: PSICO, checkout_integration_id: 'int-conta', product_name: 'Reels Nutri', metadata: { product_id: 'P9' }, ...extra,
  });

  it('a visita manda: a sessao do stl_ define a area', async () => {
    const { svc } = build({
      tracking_sessions: [{ workspace_id: NUTRI }],
      workspaces: [{ id: NUTRI }],
    });
    const area = await svc.resolveArea(sale({ metadata: { sck: `stl_${SID}`, product_id: 'P9' } }), null);
    expect(area).toBe(NUTRI);
  });

  it('sem visita, vale a tabela de produtos', async () => {
    const { svc } = build({
      tracking_sessions: [],
      checkout_integrations: { platform: 'kiwify', all_products: true },
      product_areas: [{ workspace_id: NUTRI, product_key: 'id:P9' }],
    });
    expect(await svc.resolveArea(sale(), null)).toBe(NUTRI);
  });

  it('conta inteira sem visita e sem produto ligado: vai para "Sem area" (sem pixel)', async () => {
    const { svc } = build({
      tracking_sessions: [],
      checkout_integrations: { platform: 'kiwify', all_products: true },
      product_areas: [],
      workspaces: [{ id: SEM }],
    });
    expect(await svc.resolveArea(sale(), null)).toBe(SEM);
  });

  it('webhook de uma area so (o modelo antigo) e sem visita: fica a area da integracao', async () => {
    const { svc } = build({
      tracking_sessions: [],
      checkout_integrations: { platform: 'kiwify', all_products: false },
      product_areas: [],
    });
    expect(await svc.resolveArea(sale(), null)).toBeNull();
  });

  it('sessao de outra usuaria nao conta', async () => {
    const { svc } = build({
      tracking_sessions: [{ workspace_id: NUTRI }],
      workspaces: [],
      checkout_integrations: { platform: 'kiwify', all_products: false },
      product_areas: [],
    });
    expect(await svc.resolveArea(sale({ metadata: { sck: `stl_${SID}` } }), null)).toBeNull();
  });

  it('banco sem a tabela nova (erro) cai no comportamento antigo', async () => {
    const svc = new SalesService({ getClient: () => { throw new Error('relation does not exist'); } } as any, {} as any, {} as any, {} as any);
    expect(await svc.resolveArea(sale(), null)).toBeNull();
  });

  it('productKeys: id da plataforma primeiro, nome depois', () => {
    expect(productKeys({ metadata: { product_id: 123 }, product_name: 'X' })).toEqual(['id:123', 'nome:X']);
    expect(productKeys({ metadata: {}, product_name: 'X' })).toEqual(['nome:X']);
    expect(productKeys({})).toEqual([]);
  });
});
