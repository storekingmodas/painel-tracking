import { SalesService } from '../sales.service';

/**
 * Kiwify: cada produto do carrinho chega num webhook próprio. groupWithBuyerOrder
 * junta as compras da mesma pessoa em 15 min num pedido só — a primeira é a
 * principal, as outras viram bump.
 */
describe('SalesService.groupWithBuyerOrder', () => {
  type Row = Record<string, any>;

  function build(sale: Row, rows: Row[], integrations: Row[] = [{ id: 'int-kw' }]) {
    const updates: { id: string; values: Row }[] = [];
    const from = (table: string) => {
      const b: any = { _update: null as Row | null };
      for (const m of ['select', 'in', 'gte', 'lte']) b[m] = () => b;
      b.eq = (col: string, val: any) => {
        if (b._update && col === 'id') updates.push({ id: val, values: b._update });
        return b;
      };
      b.update = (values: Row) => {
        b._update = values;
        return b;
      };
      b.maybeSingle = async () => ({ data: sale });
      b.then = (ok: any) =>
        Promise.resolve(
          table === 'checkout_integrations' ? { data: integrations, error: null } : { data: rows, error: null },
        ).then(ok);
      return b;
    };
    const svc = new SalesService({ getClient: () => ({ from }) } as any, {} as any, {} as any, {} as any);
    return { svc, updates };
  }

  const base = { workspace_id: 'ws', customer_email: 'a@b.com', status: 'approved' };

  it('a primeira compra é a principal e as seguintes da mesma pessoa viram bump do mesmo pedido', async () => {
    const rows = [
      { id: 'bump', external_id: 'K-2', sold_at: '2026-10-11T14:10:00Z', created_at: '2026-10-11T14:10:55Z', order_external_id: null, is_order_bump: false },
      { id: 'main', external_id: 'K-1', sold_at: '2026-10-11T14:10:00Z', created_at: '2026-10-11T14:10:51Z', order_external_id: null, is_order_bump: false },
      { id: 'bump2', external_id: 'K-3', sold_at: '2026-10-11T14:12:00Z', created_at: '2026-10-11T14:12:03Z', order_external_id: null, is_order_bump: false },
    ];
    const { svc, updates } = build({ id: 'bump2', ...base, sold_at: '2026-10-11T14:12:00Z' }, rows);

    await svc.groupWithBuyerOrder('bump2');

    expect(updates).toEqual(
      expect.arrayContaining([
        { id: 'main', values: { order_external_id: 'K-1', is_order_bump: false } },
        { id: 'bump', values: { order_external_id: 'K-1', is_order_bump: true } },
        { id: 'bump2', values: { order_external_id: 'K-1', is_order_bump: true } },
      ]),
    );
    expect(updates).toHaveLength(3);
  });

  it('compra fora da janela de 15 min da primeira é um pedido próprio', async () => {
    const rows = [
      { id: 'cedo', external_id: 'K-1', sold_at: '2026-10-11T14:00:00Z', created_at: '2026-10-11T14:00:10Z', order_external_id: 'K-1', is_order_bump: false },
      { id: 'nova', external_id: 'K-9', sold_at: '2026-10-11T14:16:00Z', created_at: '2026-10-11T14:16:10Z', order_external_id: null, is_order_bump: false },
    ];
    const { svc, updates } = build({ id: 'nova', ...base, sold_at: '2026-10-11T14:16:00Z' }, rows);

    await svc.groupWithBuyerOrder('nova');

    expect(updates).toEqual([]);
  });

  it('chamar de novo com o grupo já certo não grava nada', async () => {
    const rows = [
      { id: 'main', external_id: 'K-1', sold_at: '2026-10-11T14:10:00Z', created_at: '2026-10-11T14:10:51Z', order_external_id: 'K-1', is_order_bump: false },
      { id: 'bump', external_id: 'K-2', sold_at: '2026-10-11T14:10:00Z', created_at: '2026-10-11T14:10:55Z', order_external_id: 'K-1', is_order_bump: true },
    ];
    const { svc, updates } = build({ id: 'bump', ...base, sold_at: '2026-10-11T14:10:00Z' }, rows);

    await svc.groupWithBuyerOrder('bump');

    expect(updates).toEqual([]);
  });

  it('sem e-mail, venda não aprovada ou área sem Kiwify: não mexe em nada', async () => {
    const cases: [Row, Row[]][] = [
      [{ id: 's', ...base, customer_email: null, sold_at: '2026-10-11T14:10:00Z' }, [{ id: 'int-kw' }]],
      [{ id: 's', ...base, status: 'refunded', sold_at: '2026-10-11T14:10:00Z' }, [{ id: 'int-kw' }]],
      [{ id: 's', ...base, sold_at: '2026-10-11T14:10:00Z' }, []],
    ];
    for (const [sale, integrations] of cases) {
      const { svc, updates } = build(sale, [{ id: 's', external_id: 'X', sold_at: '2026-10-11T14:10:00Z', created_at: '2026-10-11T14:10:00Z' }], integrations);
      await svc.groupWithBuyerOrder('s');
      expect(updates).toEqual([]);
    }
  });
});
