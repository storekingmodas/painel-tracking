import { HotmartProcessor } from '../hotmart.processor';

/**
 * O hottok é um só por conta Hotmart. Com duas áreas (dois pixels) na mesma
 * conta, o ?area= do endereço do webhook é o que separa as vendas.
 */
describe('HotmartProcessor: area pelo endereco do webhook', () => {
  const AREA = 'ffe93d2a-3ac5-4017-a0d4-7bd860ab38c4';
  const body = {
    event: 'PURCHASE_APPROVED',
    data: { purchase: { transaction: 'HP123', price: { value: 47.9 } }, buyer: { email: 'cliente@exemplo.com' } },
  };

  function build() {
    const filtros: [string, unknown][] = [];
    const builder: any = {};
    for (const m of ['select', 'order', 'limit']) builder[m] = () => builder;
    builder.eq = (col: string, val: unknown) => {
      filtros.push([col, val]);
      return builder;
    };
    builder.maybeSingle = async () => ({ data: null, error: null });
    const processor = new HotmartProcessor(
      { getClient: () => ({ from: () => builder }) } as any,
      {} as any,
      { logError: jest.fn(), logTestIgnored: jest.fn() } as any,
      {} as any,
    );
    return { processor, filtros };
  }

  it('com ?area=, procura a integracao so naquela area', async () => {
    const { processor, filtros } = build();
    const res = await processor.process(body, 'hottok', {}, { area: AREA });
    expect(filtros).toContainEqual(['workspace_id', AREA]);
    expect(filtros).toContainEqual(['webhook_secret', 'hottok']);
    expect(res.status).toBe(401); // nenhuma integracao no mock
  });

  it('sem ?area=, mantem o comportamento antigo (so o hottok)', async () => {
    const { processor, filtros } = build();
    await processor.process(body, 'hottok', {}, {});
    expect(filtros.find(([c]) => c === 'workspace_id')).toBeUndefined();
  });

  it('area que nao e um id valido e recusada', async () => {
    const { processor } = build();
    const res = await processor.process(body, 'hottok', {}, { area: 'psicologia' });
    expect(res.status).toBe(400);
  });
});
