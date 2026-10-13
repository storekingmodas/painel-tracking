import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../shared/services/supabase.service';
import { toExclusiveEndDate, toStartOfDayUTC } from '../../shared/helpers/date-range';
import { PlanLimitsService, SaleDecision } from '../plan-limits/plan-limits.service';
import { StripeOverageService } from '../stripe/stripe-overage.service';
import { VisitorMatchingService } from '../tracking/visitor-matching.service';
import { webhookContext } from '../../shared/helpers/webhook-context';
import { abTagForSale } from '../ab-checkout/ab-sale-tag';
import { BUYER_GROUPED_PLATFORMS, BUYER_ORDER_WINDOW_MS } from '../../shared/constants/buyer-order';

export interface SalesFilters {
  from?: string;
  to?: string;
  statuses?: string[];
  workspace_id?: string;
  checkout_ids?: string[];
  product_names?: string[];
  campaign_ids?: string[];
  q?: string;
  page?: number;
  page_size?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** Área sem pixel onde ficam as vendas que o painel não soube atribuir. */
export const UNASSIGNED_AREA_NAME = 'Sem área';

/**
 * Chaves do produto da venda para product_areas: o id da plataforma (mais
 * estável) e o nome (o que a usuária reconhece, e o que sobra quando a
 * plataforma não manda id).
 */
export function productKeys(sale: { metadata?: any; product_name?: string | null }): string[] {
  const id = sale.metadata?.product_id;
  return [id != null && id !== '' ? `id:${id}` : null, sale.product_name ? `nome:${sale.product_name}` : null]
    .filter((k): k is string => !!k);
}

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly planLimits: PlanLimitsService,
    private readonly stripeOverage: StripeOverageService,
    private readonly visitorMatching: VisitorMatchingService,
  ) {}

  async upsertFromWebhook(sale: Record<string, any>): Promise<Record<string, any>> {
    // O snippet de rastreio escreve sck=stl_<sessao> no link do checkout.
    // Alguns processors usam o sck como último recurso para achar o ad_id,
    // e sem esta limpeza o id da sessão ia parar em sales.ad_id. O marcador
    // vai para o metadata, que é onde o casamento com a visita o procura —
    // em alguns processors, o ad_id era o único lugar onde ele chegava.
    if (typeof sale.ad_id === 'string' && sale.ad_id.startsWith('stl_')) {
      sale = { ...sale, ad_id: null, metadata: { ...(sale.metadata ?? {}), tracking_ref: sale.ad_id } };
    }

    // O indexador achado no corpo cru do webhook (webhook-context). Cobre as
    // plataformas cujo processor não guarda o parâmetro em lugar nenhum.
    const ctx = webhookContext.getStore();
    if (ctx?.trackingRef && !sale.metadata?.tracking_ref) {
      sale = { ...sale, metadata: { ...(sale.metadata ?? {}), tracking_ref: ctx.trackingRef } };
    }

    // A área de verdade da venda (ver resolveArea). Antes de gravar: é ela que
    // decide o pixel do Purchase e onde a venda aparece no painel.
    const area = await this.resolveArea(sale, ctx?.trackingRef ?? null);
    if (area && area !== sale.workspace_id) sale = { ...sale, workspace_id: area };

    // Teste A/B: venda que voltou do redirecionador leva a plataforma
    // sorteada; a do link de teste já chega marcada como teste (e na área do
    // experimento, porque não passou pela página). Sem match, nada muda.
    const ab = await abTagForSale(() => this.supabase.getClient(), [
      sale.metadata?.sck,
      sale.metadata?.tracking_ref,
      ctx?.trackingRef,
    ]);
    if (ab) {
      sale = {
        ...sale,
        ab_experiment_id: ab.ab_experiment_id,
        ab_assigned_platform: ab.ab_assigned_platform,
        ...(ab.is_test ? { is_test: true, workspace_id: ab.workspace_id } : {}),
      };
    }

    // 1. Status != approved — persist without limit check.
    if (sale.status !== 'approved') {
      const pending = await this.persist(sale);
      await this.visitorMatching.matchSale(pending.id);
      return pending;
    }

    // 2. Idempotency — webhook retry doesn't reprocess.
    const existing = await this.findByExternalId(sale.external_id, sale.user_id);
    if (existing) return existing;

    // 3. PlanLimitsService decision.
    const decision: SaleDecision = await this.planLimits.checkSaleAcceptance(sale.user_id);

    // 5. Persist normal sale.
    const saved = await this.persist(sale);

    // Liga a venda à visita rastreada, se houver. Aguardado, e não
    // fire-and-forget: na Vercel a função congela quando o webhook responde.
    // Nunca lança.
    await this.visitorMatching.matchSale(saved.id);

    // Venda aprovada nova: entra na lista do Purchase da CAPI, enviado quando
    // o webhook terminar (WebhookQueueService). Venda repetida não chega aqui.
    ctx?.approvedSaleIds.push(saved.id);

    // 6. Register overage if paid plan exceeded and dispatch meter event.
    if (decision.overage) {
      try {
        const overageId = await this.insertOverage(saved.id, sale.user_id, decision);
        // Fire-and-forget — reconciliation cron retries on failure
        this.stripeOverage
          .sendMeterEvent({ overageId })
          .catch((err) => this.logger.warn(
            `Meter event delivery failed for overage ${overageId}: ${err.message}. Reconciliation will retry.`,
          ));
      } catch (err) {
        // UNIQUE(sale_id) — if exists, silent ignore.
        if (!(err as any)?.message?.includes('duplicate')) throw err;
      }
    }

    // 7. Invalidate counts.
    await this.planLimits.invalidate(sale.user_id);
    return saved;
  }

  /**
   * Área da venda, quando ela não é simplesmente a da integração.
   *
   * 1. A visita: o código stl_<sessão> que o rastreio pôs no link do checkout
   *    volta no webhook, e a sessão pertence à área da página onde a pessoa
   *    clicou. Cobre quase toda venda que vem de anúncio.
   * 2. product_areas: o produto ligado a uma área na tela Produtos — para a
   *    venda que chega sem visita (link direto do checkout, bio, WhatsApp).
   * 3. Integração da conta inteira (all_products) sem 1 nem 2: a área "Sem
   *    área", que não tem pixel. Mandar para a área da integração seria
   *    chutar o pixel.
   *
   * null = fica a área da integração (o comportamento de sempre). Nunca
   * lança: tabela ou coluna ainda inexistente cai no comportamento antigo.
   */
  async resolveArea(sale: Record<string, any>, trackingRef: string | null): Promise<string | null> {
    try {
      const client = this.supabase.getClient();
      const userId = sale.user_id;
      if (!userId) return null;

      const text = [
        trackingRef,
        JSON.stringify(sale.metadata ?? {}),
        sale.utm_source, sale.utm_medium, sale.utm_campaign, sale.utm_content, sale.utm_term, sale.ad_id,
      ].filter(Boolean).join(' ');
      const sid = text.match(/stl_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1];
      if (sid) {
        const { data: sessions } = await client
          .from('tracking_sessions')
          .select('workspace_id')
          .eq('session_id', sid)
          .limit(5);
        const ids = [...new Set((sessions ?? []).map((s: any) => s.workspace_id))];
        if (ids.length > 0) {
          const { data: owned } = await client.from('workspaces').select('id').eq('user_id', userId).in('id', ids);
          if (owned?.length) return owned[0].id;
        }
      }

      if (!sale.checkout_integration_id) return null;
      const { data: integration, error: intError } = await client
        .from('checkout_integrations')
        .select('platform, all_products')
        .eq('id', sale.checkout_integration_id)
        .maybeSingle();
      if (intError || !integration) return null;

      const keys = productKeys(sale);
      if (keys.length > 0) {
        const { data: maps } = await client
          .from('product_areas')
          .select('workspace_id, product_key')
          .eq('user_id', userId)
          .eq('platform', integration.platform)
          .in('product_key', keys);
        const hit = keys.map((k) => (maps ?? []).find((m: any) => m.product_key === k)).find(Boolean);
        if (hit) return hit.workspace_id;
      }

      if (integration.all_products) return await this.unassignedArea(userId);
      return null;
    } catch (err: any) {
      this.logger.warn(`resolveArea: ${err?.message}`);
      return null;
    }
  }

  /** A área "Sem área" da usuária (sem pixel), criada na primeira vez. */
  async unassignedArea(userId: string): Promise<string | null> {
    const client = this.supabase.getClient();
    const { data: found } = await client
      .from('workspaces')
      .select('id')
      .eq('user_id', userId)
      .eq('name', UNASSIGNED_AREA_NAME)
      .limit(1)
      .maybeSingle();
    if (found) return found.id;
    const { data: created, error } = await client
      .from('workspaces')
      .insert({ user_id: userId, name: UNASSIGNED_AREA_NAME })
      .select('id')
      .single();
    if (error) {
      this.logger.warn(`Criar area "${UNASSIGNED_AREA_NAME}": ${error.message}`);
      return null;
    }
    return created.id;
  }

  /**
   * Junta num pedido só as compras aprovadas da mesma pessoa (e-mail) na
   * mesma área, feitas dentro de BUYER_ORDER_WINDOW_MS da primeira.
   *
   * A primeira (sold_at, depois chegada) é a principal; as outras viram
   * is_order_bump e todas recebem order_external_id = external_id da
   * principal. É a convenção que o resto do painel já usa (a Hubla grava uma
   * linha por produto): as contagens fazem DISTINCT por pedido e somam o
   * valor das linhas, e a CAPI manda um Purchase por pedido com a soma.
   *
   * Recalcula o grupo inteiro a cada chamada, então a ordem de chegada dos
   * webhooks não importa e chamar de novo não muda nada. Nunca lança: a venda
   * já está gravada.
   */
  async groupWithBuyerOrder(saleId: string): Promise<void> {
    try {
      const client = this.supabase.getClient();
      const { data: sale } = await client
        .from('sales')
        .select('id, user_id, workspace_id, customer_email, sold_at, status')
        .eq('id', saleId)
        .maybeSingle();
      if (!sale?.workspace_id || !sale.customer_email || !sale.sold_at || sale.status !== 'approved') return;

      // Integrações da usuária, não da área: com o webhook da conta inteira
      // (all_products) a integração mora numa área e a venda vai para outra.
      const { data: integrations } = await client
        .from('checkout_integrations')
        .select('id')
        .eq('user_id', sale.user_id)
        .in('platform', [...BUYER_GROUPED_PLATFORMS]);
      const integrationIds = (integrations ?? []).map((i) => i.id);
      if (integrationIds.length === 0) return;

      const t = new Date(sale.sold_at).getTime();
      const { data: rows, error } = await client
        .from('sales')
        .select('id, external_id, sold_at, created_at, order_external_id, is_order_bump, is_test')
        .eq('workspace_id', sale.workspace_id)
        .eq('customer_email', sale.customer_email)
        .eq('status', 'approved')
        .in('checkout_integration_id', integrationIds)
        .gte('sold_at', new Date(t - BUYER_ORDER_WINDOW_MS).toISOString())
        .lte('sold_at', new Date(t + BUYER_ORDER_WINDOW_MS).toISOString());
      if (error) throw new Error(error.message);

      const time = (r: { sold_at: string }) => new Date(r.sold_at).getTime();
      const sorted = [...(rows ?? [])].sort(
        (a, b) => time(a) - time(b) || new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );
      const main = sorted[0];
      if (!main) return;
      const group = sorted.filter((r) => time(r) - time(main) <= BUYER_ORDER_WINDOW_MS);
      // A venda nova ficou depois da janela da primeira: é um pedido próprio.
      if (!group.some((r) => r.id === saleId)) return;

      // Pedido de teste do A/B: uma linha marcada marca o pedido inteiro (o
      // bump pode chegar sem o código da visita). Nunca desmarca.
      const groupIsTest = group.some((r: any) => r.is_test);
      for (const row of group) {
        const orderKey = main.external_id;
        const isBump = row.id !== main.id;
        const markTest = groupIsTest && !(row as any).is_test;
        if (row.order_external_id === orderKey && row.is_order_bump === isBump && !markTest) continue;
        await client
          .from('sales')
          .update({ order_external_id: orderKey, is_order_bump: isBump, ...(markTest ? { is_test: true } : {}) })
          .eq('id', row.id);
      }
    } catch (err: any) {
      this.logger.warn(`groupWithBuyerOrder ${saleId}: ${err?.message}`);
    }
  }

  private async findByExternalId(
    externalId: string,
    userId: string,
  ): Promise<Record<string, any> | null> {
    const { data } = await this.supabase.getClient()
      .from('sales')
      .select('id, status')
      .eq('external_id', externalId)
      .eq('user_id', userId)
      .maybeSingle();
    return data ?? null;
  }

  private async persist(
    sale: Record<string, any>,
  ): Promise<Record<string, any>> {
    const { data, error } = await this.supabase.getClient()
      .from('sales')
      .insert(sale)
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    return data;
  }

  private async insertOverage(
    saleId: string,
    userId: string,
    decision: { subscriptionId: string; periodStart: string; periodEnd: string; pricePerSaleCents: number },
  ): Promise<string> {
    const { data, error } = await this.supabase.getClient()
      .from('usage_overage')
      .insert({
        user_id: userId,
        subscription_id: decision.subscriptionId,
        sale_id: saleId,
        period_start: decision.periodStart,
        period_end: decision.periodEnd,
        price_cents: decision.pricePerSaleCents,
      })
      .select('id')
      .single();
    if (error) throw error;
    return data.id;
  }

  /**
   * Batched upsert for imported sales. Always stamps source='import' and
   * blocked_by_limit=false. Uses ON CONFLICT (external_id, workspace_id) DO NOTHING
   * to stay idempotent against concurrent webhook arrivals.
   * Returns the rows actually written (duplicates are absent from the result).
   */
  async upsertManyImported(
    rows: Record<string, any>[],
  ): Promise<Array<{ id: string; external_id: string }>> {
    if (rows.length === 0) return [];
    const CHUNK = 500;
    const stamped = rows.map((r) => ({
      ...r,
      source: 'import',
    }));

    const inserted: Array<{ id: string; external_id: string }> = [];
    for (let i = 0; i < stamped.length; i += CHUNK) {
      const batch = stamped.slice(i, i + CHUNK);
      const { data, error } = await this.supabase
        .getClient()
        .from('sales')
        .upsert(batch, {
          onConflict: 'external_id,workspace_id',
          ignoreDuplicates: true,
        })
        .select('id, external_id');
      if (error) throw new Error(error.message);
      if (data) inserted.push(...data);
    }
    return inserted;
  }

  async getSalesWithDetails(userId: string, filters: SalesFilters) {
    const client = this.supabase.getClient();
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, filters.page_size ?? DEFAULT_PAGE_SIZE));
    const offset = (page - 1) * pageSize;

    let query = client
      .from('sales')
      .select(
        'id, campaign_id, ad_id, external_id, customer_name, customer_email, customer_phone, customer_doc, customer_state, product_name, amount, status, payment_method, checkout_source, utm_source, utm_medium, utm_campaign, utm_content, utm_term, sold_at, created_at, campaigns(name), ad_sets(name), ads(name), checkout_integrations(platform)',
        { count: 'exact' },
      )
      .eq('user_id', userId);

    if (filters.workspace_id) {
      query = query.eq('workspace_id', filters.workspace_id);
    }
    if (filters.from) {
      query = query.gte('sold_at', toStartOfDayUTC(filters.from));
    }
    if (filters.to) {
      query = query.lt('sold_at', toExclusiveEndDate(filters.to));
    }
    if (filters.statuses && filters.statuses.length > 0) {
      query = query.in('status', filters.statuses);
    }
    if (filters.checkout_ids && filters.checkout_ids.length > 0) {
      query = query.in('checkout_integration_id', filters.checkout_ids);
    }
    if (filters.product_names && filters.product_names.length > 0) {
      query = query.in('product_name', filters.product_names);
    }
    if (filters.campaign_ids && filters.campaign_ids.length > 0) {
      query = query.in('campaign_id', filters.campaign_ids);
    }
    if (filters.q) {
      const escaped = filters.q.replace(/[%_,()]/g, '');
      const pattern = `%${escaped}%`;
      query = query.or(
        `customer_email.ilike.${pattern},customer_name.ilike.${pattern},product_name.ilike.${pattern}`,
      );
    }

    query = query.order('sold_at', { ascending: false }).range(offset, offset + pageSize - 1);

    const { data, count, error } = await query;

    if (error) {
      throw new Error(error.message);
    }

    return {
      data: data ?? [],
      total: count ?? 0,
      page,
      page_size: pageSize,
    };
  }

  async getDistinctProductNames(userId: string, workspaceId: string): Promise<string[]> {
    const client = this.supabase.getClient();
    const PAGE = 1000; // PostgREST default cap; iterate until exhausted.
    const set = new Set<string>();
    let from = 0;

    while (from < 50_000) {
      const to = from + PAGE - 1;
      const { data, error } = await client
        .from('sales')
        .select('product_name')
        .eq('user_id', userId)
        .eq('workspace_id', workspaceId)
        .not('product_name', 'is', null)
        .order('product_name', { ascending: true })
        .range(from, to);

      if (error) {
        throw new Error(error.message);
      }

      const rows = data ?? [];
      for (const row of rows) {
        const name = (row as { product_name: string | null }).product_name;
        if (name) set.add(name);
      }

      if (rows.length < PAGE) break;
      from += PAGE;
    }

    return Array.from(set).sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }

  async getSalesSummary(userId: string, filters: SalesFilters) {
    const client = this.supabase.getClient();

    // Prefer the SQL RPC when available (single round-trip aggregation).
    const { data: rpcData, error: rpcError } = await client.rpc('sales_summary', {
      p_user_id: userId,
      p_workspace_id: filters.workspace_id ?? null,
      p_from: filters.from ? toStartOfDayUTC(filters.from) : null,
      p_to: filters.to ? toExclusiveEndDate(filters.to) : null,
      p_statuses: filters.statuses && filters.statuses.length > 0 ? filters.statuses : null,
      p_checkout_ids: filters.checkout_ids && filters.checkout_ids.length > 0 ? filters.checkout_ids : null,
      p_product_names: filters.product_names && filters.product_names.length > 0 ? filters.product_names : null,
      p_campaign_ids: filters.campaign_ids && filters.campaign_ids.length > 0 ? filters.campaign_ids : null,
      p_q: filters.q ?? null,
    });

    if (!rpcError && rpcData) {
      return rpcData;
    }

    // Fallback: aggregate in Node when the RPC migration has not been
    // applied yet. Capped at 10k rows so it works for the seeded test
    // account; long-term the RPC handles unbounded volume.
    this.logger.warn(
      `sales_summary RPC unavailable, falling back to in-memory aggregation: ${rpcError?.message ?? 'no data'}`,
    );
    return this.computeSummaryInMemory(userId, filters);
  }

  private async computeSummaryInMemory(userId: string, filters: SalesFilters) {
    const client = this.supabase.getClient();
    const PAGE = 1000;
    const HARD_CAP = 50_000;
    type JoinName = { name: string | null } | { name: string | null }[] | null;
    type Row = {
      amount: number | string;
      status: string | null;
      product_name: string | null;
      customer_name: string | null;
      customer_state: string | null;
      sold_at: string;
      utm_content: string | null;
      ad_id: string | null;
      ads: JoinName;
      ad_sets: JoinName;
      campaigns: JoinName;
    };
    const rows: Row[] = [];

    for (let from = 0; from < HARD_CAP; from += PAGE) {
      let query = client
        .from('sales')
        .select(
          'amount, status, product_name, customer_name, customer_state, utm_content, ad_id, ad_set_id, campaign_id, sold_at, ads(name), ad_sets(name), campaigns(name)',
        )
        .eq('user_id', userId);

      if (filters.workspace_id) query = query.eq('workspace_id', filters.workspace_id);
      if (filters.from) query = query.gte('sold_at', toStartOfDayUTC(filters.from));
      if (filters.to) query = query.lt('sold_at', toExclusiveEndDate(filters.to));
      if (filters.checkout_ids && filters.checkout_ids.length > 0) {
        query = query.in('checkout_integration_id', filters.checkout_ids);
      }
      if (filters.product_names && filters.product_names.length > 0) {
        query = query.in('product_name', filters.product_names);
      }
      if (filters.campaign_ids && filters.campaign_ids.length > 0) {
        query = query.in('campaign_id', filters.campaign_ids);
      }
      if (filters.q) {
        const escaped = filters.q.replace(/[%_,()]/g, '');
        const pattern = `%${escaped}%`;
        query = query.or(
          `customer_email.ilike.${pattern},customer_name.ilike.${pattern},product_name.ilike.${pattern}`,
        );
      }

      query = query.order('sold_at', { ascending: false }).range(from, from + PAGE - 1);

      const { data, error } = await query;
      if (error) {
        throw new Error(error.message);
      }
      const chunk = (data ?? []) as unknown as Row[];
      rows.push(...chunk);
      if (chunk.length < PAGE) break;
    }

    const pickName = (v: JoinName): string | null => {
      if (!v) return null;
      if (Array.isArray(v)) return v[0]?.name ?? null;
      return v.name ?? null;
    };

    let approvedCount = 0;
    let grossRevenue = 0;
    let refundsCount = 0;
    const productMap = new Map<string, { count: number; revenue: number }>();
    const adMap = new Map<string, { count: number; revenue: number }>();
    const stateMap = new Map<string, number>();
    const refundedSample: Array<{ customer_name: string | null; customer_state: string | null; amount: number }> = [];

    for (const row of rows) {
      const amt = Number(row.amount) || 0;
      if (row.status === 'approved') {
        approvedCount += 1;
        grossRevenue += amt;

        const productKey = row.product_name ?? 'Sem produto';
        const productEntry = productMap.get(productKey) ?? { count: 0, revenue: 0 };
        productEntry.count += 1;
        productEntry.revenue += amt;
        productMap.set(productKey, productEntry);

        const utm = row.utm_content?.trim() || null;
        const adKey = utm || pickName(row.ads) || row.ad_id || 'Sem anúncio';
        const adEntry = adMap.get(adKey) ?? { count: 0, revenue: 0 };
        adEntry.count += 1;
        adEntry.revenue += amt;
        adMap.set(adKey, adEntry);
      } else if (row.status === 'refunded') {
        refundsCount += 1;
        const stateKey = (row.customer_state ?? '').toUpperCase().trim() || 'N/A';
        stateMap.set(stateKey, (stateMap.get(stateKey) ?? 0) + 1);
        if (refundedSample.length < 500) {
          refundedSample.push({
            customer_name: row.customer_name,
            customer_state: row.customer_state,
            amount: amt,
          });
        }
      }
    }

    const totalCount = approvedCount + refundsCount;
    const refundRate = totalCount > 0 ? (refundsCount / totalCount) * 100 : 0;
    const avgTicket = approvedCount > 0 ? grossRevenue / approvedCount : 0;

    const byProduct = Array.from(productMap.entries())
      .map(([product_name, v]) => ({ product_name, count: v.count, revenue: v.revenue }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    const byAd = Array.from(adMap.entries())
      .map(([name, v]) => ({ name, count: v.count, revenue: v.revenue }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const refundsByState = Array.from(stateMap.entries())
      .map(([state, count]) => ({ state, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    return {
      metrics: {
        approved_count: approvedCount,
        gross_revenue: grossRevenue,
        avg_ticket: avgTicket,
        refunds_count: refundsCount,
        refund_rate: refundRate,
      },
      by_product: byProduct,
      by_ad: byAd,
      refunds_by_state: refundsByState,
      refunded_sample: refundedSample,
    };
  }
}
