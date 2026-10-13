import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../shared/services/supabase.service';
import { MetaCapiService } from '../meta-capi/meta-capi.service';
import { productKeys, UNASSIGNED_AREA_NAME } from '../sales/sales.service';

/** O Meta recusa Purchase com mais de 7 dias (folga de 1 h). */
const CAPI_WINDOW_MS = 7 * 86_400_000 - 3_600_000;
const LOOKBACK_MS = 90 * 86_400_000;

export interface ProductRow {
  platform: string;
  product_key: string;
  product_name: string | null;
  workspace_id: string | null;
  sales: number;
  pending: number;
  last_sold_at: string | null;
}

/**
 * Tela Produtos: cada produto que já vendeu e a área dele.
 *
 * Com o webhook da conta inteira, a venda que chega com a visita já vai para a
 * área da página (SalesService.resolveArea). Esta tabela é para a que chega
 * sem visita — e para tirar da área "Sem área" o que ficou esperando.
 */
@Injectable()
export class ProductAreasService {
  private readonly logger = new Logger(ProductAreasService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly metaCapi: MetaCapiService,
  ) {}

  async list(userId: string) {
    const client = this.supabase.getClient();
    const [{ data: areas, error: aErr }, { data: integrations, error: iErr }, { data: maps, error: mErr }] = await Promise.all([
      client.from('workspaces').select('id, name, meta_pixel_id').eq('user_id', userId).order('created_at'),
      client.from('checkout_integrations').select('id, platform').eq('user_id', userId),
      client.from('product_areas').select('platform, product_key, workspace_id').eq('user_id', userId),
    ]);
    if (aErr) throw new Error(aErr.message);
    if (iErr) throw new Error(iErr.message);
    if (mErr) throw new Error(mErr.message);

    const unassigned = (areas ?? []).find((a: any) => a.name === UNASSIGNED_AREA_NAME) ?? null;
    const platformOf = new Map((integrations ?? []).map((i: any) => [i.id, i.platform as string]));

    const { data: sales, error } = await client
      .from('sales')
      .select('product_name, metadata, workspace_id, sold_at, status, is_order_bump, checkout_integration_id')
      .eq('user_id', userId)
      .gte('sold_at', new Date(Date.now() - LOOKBACK_MS).toISOString())
      .order('sold_at', { ascending: false })
      .limit(5000);
    if (error) throw new Error(error.message);

    const rows = new Map<string, ProductRow & { keys: Set<string> }>();
    for (const s of sales ?? []) {
      const platform = platformOf.get(s.checkout_integration_id);
      const keys = productKeys(s);
      if (!platform || keys.length === 0) continue;
      const id = `${platform}|${keys[0]}`;
      let row = rows.get(id);
      if (!row) {
        row = { platform, product_key: keys[0], product_name: s.product_name ?? null, workspace_id: null, sales: 0, pending: 0, last_sold_at: s.sold_at, keys: new Set() };
        rows.set(id, row);
      }
      keys.forEach((k) => row!.keys.add(k));
      if (s.status === 'approved') row.sales += 1;
      if (unassigned && s.workspace_id === unassigned.id) row.pending += 1;
    }

    for (const row of rows.values()) {
      const hit = (maps ?? []).find((m: any) => m.platform === row.platform && row.keys.has(m.product_key));
      row.workspace_id = hit?.workspace_id ?? null;
    }

    const products = [...rows.values()]
      .map(({ keys: _keys, ...r }) => r)
      .sort((a, b) => b.pending - a.pending || String(b.last_sold_at).localeCompare(String(a.last_sold_at)));

    return {
      areas: (areas ?? [])
        .filter((a: any) => a.name !== UNASSIGNED_AREA_NAME)
        .map((a: any) => ({ id: a.id, name: a.name, has_pixel: !!a.meta_pixel_id })),
      unassigned_area_id: unassigned?.id ?? null,
      products,
    };
  }

  /**
   * Liga o produto a uma área. As vendas dele paradas em "Sem área" mudam de
   * área (com os bumps do mesmo pedido), e as aprovadas de até 7 dias saem
   * para a CAPI com a data original. As que já estavam numa área ficam onde
   * estão: trocar o produto de área não reescreve o passado.
   */
  async assign(userId: string, input: { platform: string; product_key: string; product_name?: string | null; workspace_id: string }) {
    const client = this.supabase.getClient();

    const { data: area } = await client
      .from('workspaces')
      .select('id, name')
      .eq('id', input.workspace_id)
      .eq('user_id', userId)
      .maybeSingle();
    if (!area) throw new NotFoundException('Area nao encontrada');
    if (area.name === UNASSIGNED_AREA_NAME) throw new BadRequestException(`Escolha uma area diferente de "${UNASSIGNED_AREA_NAME}"`);

    const { data: integrations } = await client
      .from('checkout_integrations')
      .select('id')
      .eq('user_id', userId)
      .eq('platform', input.platform);
    const integrationIds = (integrations ?? []).map((i: any) => i.id);
    if (integrationIds.length === 0) throw new BadRequestException('Plataforma sem integracao');

    const { error: upErr } = await client.from('product_areas').upsert(
      {
        user_id: userId,
        platform: input.platform,
        product_key: input.product_key,
        product_name: input.product_name ?? null,
        workspace_id: input.workspace_id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,platform,product_key' },
    );
    if (upErr) throw new Error(upErr.message);

    const { data: unassigned } = await client
      .from('workspaces')
      .select('id')
      .eq('user_id', userId)
      .eq('name', UNASSIGNED_AREA_NAME)
      .maybeSingle();
    if (!unassigned) return { moved: 0, sent: 0 };

    const { data: waiting, error: wErr } = await client
      .from('sales')
      .select('id, product_name, metadata, order_external_id, external_id')
      .eq('user_id', userId)
      .eq('workspace_id', unassigned.id)
      .in('checkout_integration_id', integrationIds)
      .limit(2000);
    if (wErr) throw new Error(wErr.message);

    const own = (waiting ?? []).filter((s: any) => productKeys(s).includes(input.product_key));
    if (own.length === 0) return { moved: 0, sent: 0 };

    // O pedido inteiro muda junto: bump de outro produto não fica para trás.
    const orders = new Set(own.map((s: any) => s.order_external_id || s.external_id));
    const { data: sameOrder } = await client
      .from('sales')
      .select('id')
      .eq('user_id', userId)
      .eq('workspace_id', unassigned.id)
      .in('order_external_id', [...orders]);
    const ids = [...new Set([...own.map((s: any) => s.id), ...(sameOrder ?? []).map((s: any) => s.id)])];

    const { error: mvErr } = await client.from('sales').update({ workspace_id: input.workspace_id }).in('id', ids);
    if (mvErr) throw new Error(mvErr.message);

    const { data: moved } = await client
      .from('sales')
      .select('id, status, sold_at')
      .in('id', ids);
    const toSend = (moved ?? [])
      .filter((s: any) => s.status === 'approved' && Date.now() - new Date(s.sold_at).getTime() < CAPI_WINDOW_MS)
      .map((s: any) => s.id);
    if (toSend.length > 0) await this.metaCapi.sendPurchases(toSend);

    this.logger.log(`Produto ${input.platform}/${input.product_key} -> area ${input.workspace_id}: ${ids.length} vendas movidas, ${toSend.length} na janela da CAPI`);
    return { moved: ids.length, sent: toSend.length };
  }
}
