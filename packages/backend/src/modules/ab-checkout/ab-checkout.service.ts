import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { SupabaseService } from '../../shared/services/supabase.service';
import {
  buildTargetUrl,
  CONTROL_PARAMS,
  pickPlatform,
  Platform,
  readVariantCookie,
  segmentOf,
  sessionFromParams,
  signTest,
  signVariantCookie,
  verifyTest,
} from './ab-core';
import { buildReport, SaleRow } from './ab-report';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CACHE_MS = 30_000;
const TEST_LINK_MS = 24 * 3600_000;

export interface AbExperiment {
  id: string;
  user_id: string;
  workspace_id: string;
  slug: string;
  name: string;
  status: 'draft' | 'active' | 'paused' | 'ended';
  forced_platform: Platform | null;
  hotmart_url: string | null;
  kiwify_url: string | null;
  split_hotmart: number;
  default_platform: Platform;
  activated_at: string | null;
  budget_cap: number | null;
  evaluation_end: string | null;
}

export interface RedirectInput {
  query: Record<string, string>;
  cookies: Record<string, string>;
  country: string | null;
}

export interface RedirectResult {
  location: string;
  /** Cookie da variante (valor assinado) para gravar no domínio raiz. */
  variantCookie?: { name: string; value: string };
}

/**
 * Redirecionador do teste A/B de checkout.
 *
 * O visitante chega do botão da página com o código da visita (sck=stl_…)
 * que o rastreio pôs no link. A plataforma é decidida pelo VISITANTE (achado
 * pela visita, no servidor — não depende de cookie entre domínios), gravada
 * antes do redirecionamento e mantida para sempre naquele experimento.
 */
@Injectable()
export class AbCheckoutService {
  private readonly logger = new Logger(AbCheckoutService.name);
  private readonly cache = new Map<string, { exp: AbExperiment | null; at: number }>();

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  private secret(): string {
    const s = this.config.get<string>('ENCRYPTION_KEY') || this.config.get<string>('CRON_SECRET');
    if (!s) throw new Error('ENCRYPTION_KEY ausente');
    return `ab|${s}`;
  }

  // ---------------------------------------------------------------------
  // Redirecionamento (público)
  // ---------------------------------------------------------------------

  private async experimentBySlug(slug: string, allowStale = false): Promise<AbExperiment | null> {
    const hit = this.cache.get(slug);
    if (hit && (allowStale || Date.now() - hit.at < CACHE_MS)) return hit.exp;
    const { data, error } = await this.supabase
      .getClient()
      .from('ab_experiments')
      .select('*')
      .eq('slug', slug)
      .maybeSingle();
    if (error) throw new Error(error.message);
    this.cache.set(slug, { exp: (data as AbExperiment) ?? null, at: Date.now() });
    return (data as AbExperiment) ?? null;
  }

  private urlFor(exp: AbExperiment, platform: Platform): string | null {
    return platform === 'hotmart' ? exp.hotmart_url : exp.kiwify_url;
  }

  private async log(experimentId: string | null, kind: string, extra: Record<string, unknown> = {}) {
    try {
      const { visitor_id, session_id, platform, ...detail } = extra as any;
      await this.supabase.getClient().from('ab_events').insert({
        experiment_id: experimentId,
        kind,
        visitor_id: visitor_id ?? null,
        session_id: session_id ?? null,
        platform: platform ?? null,
        detail,
      });
    } catch (err: any) {
      this.logger.error(`[ab] registro de ${kind} falhou: ${err?.message}`);
    }
  }

  async redirect(input: RedirectInput): Promise<RedirectResult> {
    const slug = String(input.query.produto ?? '').toLowerCase().trim();
    const cookieName = `_stl_ab_${slug.replace(/[^a-z0-9-]/g, '')}`;
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.query)) {
      if (!CONTROL_PARAMS.has(k) && typeof v === 'string') params[k] = v.slice(0, 500);
    }

    let exp: AbExperiment | null = null;
    try {
      exp = await this.experimentBySlug(slug);
    } catch (err: any) {
      // Banco fora: o último experimento lido nesta instância ainda serve.
      this.logger.error(`[ab] experimento ${slug}: ${err?.message}`);
      exp = await this.experimentBySlug(slug, true).catch(() => null);
    }
    if (!exp) throw new NotFoundException('Experimento nao encontrado');

    const secret = this.secret();
    const cookiePlatform = readVariantCookie(secret, slug, input.cookies[cookieName]);

    try {
      return await this.decide(exp, params, input, secret, cookieName, cookiePlatform);
    } catch (err: any) {
      // Link de teste que falhou não segue: a compra sairia sem a marca.
      if (input.query.forcar) {
        await this.log(exp.id, 'falha_teste', { erro: String(err?.message ?? err).slice(0, 300) });
        throw err;
      }
      // Falha no meio do caminho. Nunca troca a variante em silêncio: quem já
      // tem plataforma (cookie assinado) vai para ela; quem não tem vai para a
      // padrão e sai da comparação. Tudo registrado.
      const platform = cookiePlatform ?? exp.default_platform;
      const target = this.urlFor(exp, platform) ?? this.urlFor(exp, exp.default_platform)!;
      this.logger.error(`[ab] falha no redirecionamento (${slug}): ${err?.message}`);
      await this.log(exp.id, cookiePlatform ? 'falha_com_cookie' : 'falha_sem_atribuicao', {
        platform,
        erro: String(err?.message ?? err).slice(0, 300),
      });
      return { location: buildTargetUrl(target, platform, params) };
    }
  }

  private async decide(
    exp: AbExperiment,
    params: Record<string, string>,
    input: RedirectInput,
    secret: string,
    cookieName: string,
    cookiePlatform: Platform | null,
  ): Promise<RedirectResult> {
    const client = this.supabase.getClient();

    // Link de teste: visita própria, isolada de qualquer visitante real. O
    // código novo vai ao checkout no sck e volta no webhook, então o pedido
    // já chega marcado como teste — antes do pagamento, sem Purchase.
    const early = verifyTest(secret, exp.slug, input.query.forcar, input.query.validade, input.query.assinatura, Date.now());
    if (early.platform) {
      const target = this.urlFor(exp, early.platform);
      if (!target) throw new Error(`URL da ${early.platform} nao cadastrada`);
      const testSid = randomUUID();
      const testParams = { ...params, sck: `stl_${testSid}` };
      const now = new Date().toISOString();
      const { error } = await client.from('ab_assignments').insert({
        experiment_id: exp.id,
        visitor_id: `teste:${testSid}`,
        session_id: testSid,
        platform: early.platform,
        eligible: false,
        segment: 'organico',
        country: (input.country || '').toUpperCase() || null,
        is_test: true,
        source: 'teste',
        first_seen_at: now,
        last_redirect_at: now,
      });
      // Sem o registro, o pedido não seria reconhecido como teste: melhor
      // não seguir do que gerar uma compra de teste que vai ao pixel.
      if (error) throw new Error(`registro do teste falhou: ${error.message}`);
      await this.log(exp.id, 'teste', { visitor_id: `teste:${testSid}`, session_id: testSid, platform: early.platform });
      return { location: buildTargetUrl(target, early.platform, testParams) };
    }

    const sid = sessionFromParams(params);
    const { data: session } = sid
      ? await client
          .from('tracking_sessions')
          .select('visitor_id, country, fbc, utm_source, utm_medium, utm_campaign, utm_content, utm_term')
          .eq('workspace_id', exp.workspace_id)
          .eq('session_id', sid)
          .maybeSingle()
      : { data: null as any };

    const cookieVid = UUID.test(input.cookies._stl_vid ?? '') ? input.cookies._stl_vid : null;
    const visitorId: string = session?.visitor_id || cookieVid || `anon:${randomUUID()}`;
    const country = (session?.country || input.country || '').toUpperCase() || null;

    const test = verifyTest(secret, exp.slug, input.query.forcar, input.query.validade, input.query.assinatura, Date.now());
    if (test.invalid) {
      await this.log(exp.id, 'forcar_invalido', { visitor_id: visitorId, session_id: sid, forcar: input.query.forcar });
    }

    const { data: existing } = await client
      .from('ab_assignments')
      .select('id, platform, eligible, is_test, source, redirect_count')
      .eq('experiment_id', exp.id)
      .eq('visitor_id', visitorId)
      .maybeSingle();

    let platform: Platform;
    let source: string;
    let eligible = false;
    let isTest = false;

    if (test.platform) {
      platform = test.platform;
      source = 'teste';
      isTest = true;
    } else if (exp.status === 'draft') {
      platform = exp.default_platform;
      source = 'rascunho';
    } else if (exp.status !== 'active') {
      platform = exp.forced_platform ?? exp.default_platform;
      source = '100%';
    } else if (existing && !existing.is_test) {
      platform = existing.platform as Platform;
      source = existing.source;
      eligible = existing.eligible;
    } else if (cookiePlatform) {
      // A atribuição está no cookie assinado, mas não no banco (visitante sem
      // visita reconhecida, ou o registro anterior falhou): mantém.
      platform = cookiePlatform;
      source = 'cookie';
      eligible = country === 'BR';
    } else if (country && country !== 'BR') {
      // Regra de elegibilidade: o teste é só Brasil.
      platform = exp.default_platform;
      source = 'fora_da_regra';
    } else {
      platform = pickPlatform(exp.split_hotmart, Math.random());
      source = 'sorteio';
      eligible = true;
    }

    const segment = segmentOf(params, session?.fbc);
    const now = new Date().toISOString();
    const row = {
      experiment_id: exp.id,
      visitor_id: visitorId,
      session_id: sid,
      platform,
      eligible,
      segment,
      country,
      is_test: isTest,
      source,
      utm_source: params.utm_source ?? session?.utm_source ?? null,
      utm_medium: params.utm_medium ?? session?.utm_medium ?? null,
      utm_campaign: params.utm_campaign ?? session?.utm_campaign ?? null,
      utm_content: params.utm_content ?? session?.utm_content ?? null,
      utm_term: params.utm_term ?? session?.utm_term ?? null,
      ad_id: /^\d{6,25}$/.test(params.ad_id ?? '') ? params.ad_id : null,
      last_redirect_at: now,
    };

    // Registrar ANTES de redirecionar. Se gravar falhar, o catch de redirect()
    // segue sem trocar a variante e registra a falha.
    if (existing) {
      // A plataforma de quem já foi sorteado nunca muda; só um link de teste
      // (ou um registro que era de teste) regrava a linha inteira.
      const { error } = await client
        .from('ab_assignments')
        .update({
          ...(test.platform || existing.is_test ? row : {}),
          ...(sid ? { session_id: sid } : {}),
          last_redirect_at: now,
          redirect_count: (existing.redirect_count ?? 1) + 1,
        })
        .eq('id', existing.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await client.from('ab_assignments').insert({ ...row, first_seen_at: now });
      if (error) {
        if (!/duplicate|unique/i.test(error.message)) throw new Error(error.message);
        // Dois cliques ao mesmo tempo: vale o que o outro gravou.
        const { data: winner } = await client
          .from('ab_assignments')
          .select('platform')
          .eq('experiment_id', exp.id)
          .eq('visitor_id', visitorId)
          .maybeSingle();
        if (winner?.platform && !isTest) platform = winner.platform as Platform;
      }
    }

    const target = this.urlFor(exp, platform);
    if (!target) throw new Error(`URL da ${platform} nao cadastrada`);

    await this.log(exp.id, 'redirect', { visitor_id: visitorId, session_id: sid, platform, source, eligible, segment });

    return {
      location: buildTargetUrl(target, platform, params),
      variantCookie: exp.status === 'active' && !isTest ? { name: cookieName, value: signVariantCookie(secret, exp.slug, platform) } : undefined,
    };
  }

  // ---------------------------------------------------------------------
  // Administração (tela Teste A/B)
  // ---------------------------------------------------------------------

  private async owned(userId: string, id: string): Promise<AbExperiment> {
    const { data } = await this.supabase
      .getClient()
      .from('ab_experiments')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle();
    if (!data) throw new NotFoundException('Experimento nao encontrado');
    return data as AbExperiment;
  }

  async list(userId: string) {
    const { data, error } = await this.supabase
      .getClient()
      .from('ab_experiments')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async save(userId: string, body: Partial<AbExperiment> & { id?: string }) {
    const client = this.supabase.getClient();
    if (body.workspace_id) {
      const { data: ws } = await client.from('workspaces').select('id').eq('id', body.workspace_id).eq('user_id', userId).maybeSingle();
      if (!ws) throw new BadRequestException('Area invalida');
    }
    const fields = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.slug !== undefined ? { slug: body.slug.toLowerCase() } : {}),
      ...(body.workspace_id !== undefined ? { workspace_id: body.workspace_id } : {}),
      ...(body.hotmart_url !== undefined ? { hotmart_url: body.hotmart_url || null } : {}),
      ...(body.kiwify_url !== undefined ? { kiwify_url: body.kiwify_url || null } : {}),
      ...(body.split_hotmart !== undefined ? { split_hotmart: body.split_hotmart } : {}),
      ...(body.default_platform !== undefined ? { default_platform: body.default_platform } : {}),
      ...(body.budget_cap !== undefined ? { budget_cap: body.budget_cap } : {}),
      ...(body.evaluation_end !== undefined ? { evaluation_end: body.evaluation_end || null } : {}),
      updated_at: new Date().toISOString(),
    };
    const res = body.id
      ? await client.from('ab_experiments').update(fields).eq('id', body.id).eq('user_id', userId).select('*').single()
      : await client.from('ab_experiments').insert({ ...fields, user_id: userId }).select('*').single();
    if (res.error) throw new BadRequestException(res.error.message);
    this.cache.clear();
    return res.data;
  }

  /**
   * Ativar, pausar (100% numa plataforma) ou encerrar. A primeira ativação
   * marca activated_at: a comparação só conta o que vier depois.
   */
  async setStatus(userId: string, id: string, status: AbExperiment['status'], forced: Platform | null) {
    const exp = await this.owned(userId, id);
    if (status === 'active' && (!exp.hotmart_url || !exp.kiwify_url)) {
      throw new BadRequestException('Cadastre os links das duas plataformas antes de ativar');
    }
    if ((status === 'paused' || status === 'ended') && !forced) {
      throw new BadRequestException('Escolha para qual plataforma vai 100% do trafego');
    }
    const { data, error } = await this.supabase
      .getClient()
      .from('ab_experiments')
      .update({
        status,
        forced_platform: status === 'active' ? null : forced,
        activated_at: status === 'active' && !exp.activated_at ? new Date().toISOString() : exp.activated_at,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    this.cache.clear();
    await this.log(id, 'status', { status, forced });
    return data;
  }

  /** Link de teste assinado, válido por 24 h, que força uma plataforma. */
  async testLink(userId: string, id: string, platform: Platform, baseUrl: string) {
    const exp = await this.owned(userId, id);
    const exp_ms = Date.now() + TEST_LINK_MS;
    const sig = signTest(this.secret(), exp.slug, platform, exp_ms);
    const url = new URL(`${baseUrl}/api/checkout-ab`);
    url.searchParams.set('produto', exp.slug);
    url.searchParams.set('forcar', platform);
    url.searchParams.set('validade', String(exp_ms));
    url.searchParams.set('assinatura', sig);
    return { url: url.toString(), expires_at: new Date(exp_ms).toISOString() };
  }

  /** Marca (ou desmarca) um pedido como compra de teste, pelo número. */
  async markTest(userId: string, order: string, isTest: boolean) {
    const o = order.trim();
    if (!o) throw new BadRequestException('Informe o numero do pedido');
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('sales')
      .update({ is_test: isTest })
      .eq('user_id', userId)
      .or(`external_id.eq.${o.replace(/[,()]/g, '')},order_external_id.eq.${o.replace(/[,()]/g, '')}`)
      .select('id, external_id, order_external_id');
    if (error) throw new Error(error.message);
    // Os bumps do mesmo pedido vão junto.
    const orderKeys = [...new Set((data ?? []).map((s: any) => s.order_external_id || s.external_id).filter(Boolean))];
    let bumps = 0;
    if (orderKeys.length) {
      const { data: more } = await client
        .from('sales')
        .update({ is_test: isTest })
        .eq('user_id', userId)
        .in('order_external_id', orderKeys)
        .select('id');
      bumps = (more ?? []).filter((m: any) => !(data ?? []).some((d: any) => d.id === m.id)).length;
    }
    return { updated: (data ?? []).length + bumps };
  }

  /**
   * Relatório: só o que veio DEPOIS da ativação, só visitantes elegíveis
   * (Brasil, sorteados), sem links e compras de teste.
   */
  async report(userId: string, id: string) {
    const exp = await this.owned(userId, id);
    const client = this.supabase.getClient();
    const counts = { encaminhamentos: 0, fora_da_comparacao: 0, falhas: 0, forcar_invalido: 0 };
    if (!exp.activated_at) {
      return { experiment: exp, started: false, counts, arms: [], verdict: null };
    }

    const assignments: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await client
        .from('ab_assignments')
        .select('visitor_id, session_id, platform, segment, first_seen_at, eligible, is_test, redirect_count')
        .eq('experiment_id', id)
        .gte('first_seen_at', exp.activated_at)
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      assignments.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    const eligible = assignments.filter((a) => a.eligible && !a.is_test);
    counts.encaminhamentos = assignments.reduce((n, a) => n + (a.redirect_count ?? 1), 0);
    counts.fora_da_comparacao = assignments.length - eligible.length;

    const sales: SaleRow[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await client
        .from('sales')
        .select(
          'id, external_id, order_external_id, is_order_bump, is_test, visitor_id, session_id, metadata, status, amount, gross_amount, fee_amount, net_amount, refunded_amount, sold_at, checkout_integrations(platform)',
        )
        .eq('user_id', userId)
        .eq('workspace_id', exp.workspace_id)
        .gte('sold_at', exp.activated_at)
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      for (const s of (data ?? []) as any[]) {
        sales.push({
          ...s,
          sck: s.metadata?.sck ?? null,
          platform: s.checkout_integrations?.platform ?? null,
        });
      }
      if (!data || data.length < 1000) break;
    }

    // Pedido com qualquer linha de teste sai inteiro (o bump pode ter chegado
    // sem a marca).
    const keyOf = (s: SaleRow) => s.order_external_id || s.external_id || s.id;
    const testOrders = new Set(sales.filter((s: any) => s.is_test).map(keyOf));
    const realSales = sales.filter((s) => !testOrders.has(keyOf(s)));

    const { data: evs } = await client
      .from('ab_events')
      .select('kind')
      .eq('experiment_id', id)
      .in('kind', ['falha_com_cookie', 'falha_sem_atribuicao', 'forcar_invalido'])
      .gte('created_at', exp.activated_at);
    for (const e of evs ?? []) {
      if (e.kind === 'forcar_invalido') counts.forcar_invalido++;
      else counts.falhas++;
    }

    return { experiment: exp, started: true, counts, ...buildReport(eligible, realSales) };
  }

  /**
   * Pedidos de teste do experimento, linha a linha, para a validação:
   * plataforma sorteada × efetiva, bumps, bruto/taxa/líquido, reembolso e se
   * algum Purchase saiu (não deve).
   */
  async testSales(userId: string, id: string) {
    await this.owned(userId, id);
    const client = this.supabase.getClient();
    const cols =
      'id, external_id, order_external_id, is_order_bump, is_test, status, product_name, amount, gross_amount, fee_amount, net_amount, refunded_amount, sold_at, ab_assigned_platform, session_id, metadata, workspace_id, checkout_integrations(platform)';
    const { data: tagged, error } = await client
      .from('sales')
      .select(cols)
      .eq('user_id', userId)
      .eq('ab_experiment_id', id)
      .eq('is_test', true)
      .order('sold_at', { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    const keys = [...new Set((tagged ?? []).map((s: any) => s.order_external_id || s.external_id).filter(Boolean))];
    const { data: siblings } = keys.length
      ? await client.from('sales').select(cols).eq('user_id', userId).in('order_external_id', keys)
      : { data: [] as any[] };
    const all = new Map<string, any>();
    for (const s of [...(tagged ?? []), ...(siblings ?? [])]) all.set(s.id, s);

    const ids = [...all.keys()];
    const { data: capi } = ids.length
      ? await client.from('capi_events').select('sale_id, event_name, status').in('sale_id', ids).eq('event_name', 'Purchase')
      : { data: [] as any[] };

    return [...all.values()]
      .sort((a, b) => String(b.sold_at).localeCompare(String(a.sold_at)))
      .map((s) => ({
        id: s.id,
        external_id: s.external_id,
        order: s.order_external_id || s.external_id,
        is_order_bump: !!s.is_order_bump,
        is_test: !!s.is_test,
        status: s.status,
        product_name: s.product_name,
        assigned_platform: s.ab_assigned_platform,
        effective_platform: s.checkout_integrations?.platform ?? null,
        amount: s.amount,
        gross_amount: s.gross_amount,
        fee_amount: s.fee_amount,
        net_amount: s.net_amount,
        refunded_amount: s.refunded_amount,
        sold_at: s.sold_at,
        linked_to_visit: !!(s.session_id || s.metadata?.sck),
        purchase_sent: (capi ?? []).some((c: any) => c.sale_id === s.id && c.status === 'sent'),
      }));
  }

  async events(userId: string, id: string) {
    await this.owned(userId, id);
    const { data } = await this.supabase
      .getClient()
      .from('ab_events')
      .select('kind, platform, detail, created_at')
      .eq('experiment_id', id)
      .neq('kind', 'redirect')
      .order('created_at', { ascending: false })
      .limit(50);
    return data ?? [];
  }
}
