import { Platform, PLATFORMS } from './ab-core';

/**
 * Relatório do teste A/B, sem banco: recebe os visitantes encaminhados e as
 * vendas, devolve os números por plataforma.
 *
 * A métrica principal é o LÍQUIDO POR VISITANTE ENCAMINHADO (o que a
 * plataforma repassa, dividido por quem foi mandado para ela, contando os
 * que não compraram como zero). Ela já junta conversão, bumps, preço e taxa
 * num número só. Vencedor só com o intervalo da diferença longe do zero —
 * nunca por contagem de compras.
 */

export interface AssignmentRow {
  visitor_id: string;
  session_id: string | null;
  platform: Platform;
  segment: 'pago' | 'organico';
  first_seen_at: string;
}

export interface SaleRow {
  id: string;
  external_id: string | null;
  order_external_id: string | null;
  is_order_bump: boolean | null;
  visitor_id: string | null;
  session_id: string | null;
  sck: string | null;
  platform: string | null;
  status: string;
  amount: number;
  gross_amount: number | null;
  fee_amount: number | null;
  net_amount: number | null;
  refunded_amount: number | null;
  sold_at: string;
}

export interface Interval {
  value: number;
  low: number;
  high: number;
}

export interface ArmReport {
  platform: Platform;
  visitors: number;
  buyers: number;
  conversion: Interval;
  orders: number;
  ordersWithBump: number;
  bumpRate: number | null;
  bumpItems: number;
  gross: number;
  fees: number;
  net: number;
  netEstimated: number;
  avgTicketGross: number | null;
  avgTicketNet: number | null;
  netPerVisitor: Interval;
  refunds: number;
  refundedValue: number;
  /**
   * Vendas cruzadas: sorteado para esta plataforma, comprou na outra. CONTAM
   * aqui (o efeito de ser mandado para cá inclui quem saiu e comprou lá).
   */
  platformMismatch: number;
  crossNet: number;
  /** Líquido só das compras feitas na própria plataforma sorteada. */
  netSamePlatform: number;
  segments: Record<'pago' | 'organico', { visitors: number; buyers: number; net: number; netPerVisitor: number | null }>;
}

export interface Verdict {
  status: 'sem_dados' | 'amostra_insuficiente' | 'sem_diferenca_clara' | 'hotmart_melhor' | 'kiwify_melhor';
  /** Kiwify − Hotmart, líquido por visitante, com intervalo de 95%. */
  difference: Interval | null;
  message: string;
}

const Z = 1.96;
const PAID = new Set(['approved', 'refunded', 'chargeback']);
/** Abaixo disto, nem intervalo vale a pena mostrar como conclusão. */
export const MIN_BUYERS_PER_ARM = 30;

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** Intervalo de Wilson (95%) para uma proporção. */
export function wilson(successes: number, n: number): Interval {
  if (n <= 0) return { value: 0, low: 0, high: 0 };
  const p = successes / n;
  const z2 = Z * Z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { value: p, low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

/** Média com intervalo de 95% (aproximação normal), e o erro-padrão. */
export function meanInterval(values: number[]): Interval & { se: number } {
  const n = values.length;
  if (n === 0) return { value: 0, low: 0, high: 0, se: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1) : 0;
  const se = Math.sqrt(variance / n);
  return { value: mean, low: mean - Z * se, high: mean + Z * se, se };
}

function sessionOfSck(sck: string | null): string | null {
  const m = String(sck ?? '').match(/stl_([0-9a-f-]{36})/i);
  return m ? m[1].toLowerCase() : null;
}

/** Valores de uma venda: bruto, taxa e líquido, com o que falta estimado. */
function moneyOf(s: SaleRow): { gross: number; fee: number; net: number; estimated: boolean } {
  const gross = Number(s.gross_amount ?? s.amount ?? 0);
  if (s.net_amount != null) {
    const net = Number(s.net_amount);
    return { gross, fee: Number(s.fee_amount ?? gross - net), net, estimated: false };
  }
  // Venda sem líquido gravado (anterior à mudança): conta o bruto, marcado.
  return { gross, fee: 0, net: gross, estimated: true };
}

export interface CrossSale {
  external_id: string | null;
  assigned: Platform;
  effective: string | null;
  status: string;
  gross: number;
  net: number;
  sold_at: string;
}

export function buildReport(
  assignments: AssignmentRow[],
  sales: SaleRow[],
): { arms: ArmReport[]; verdict: Verdict; crossSales: CrossSale[] } {
  const byVisitor = new Map<string, AssignmentRow>();
  const bySession = new Map<string, AssignmentRow>();
  for (const a of assignments) {
    byVisitor.set(a.visitor_id, a);
    if (a.session_id) bySession.set(a.session_id.toLowerCase(), a);
  }

  // Liga cada venda a um visitante encaminhado (visitante → sessão → sck).
  const linked: Array<{ sale: SaleRow; a: AssignmentRow }> = [];
  for (const s of sales) {
    const a =
      (s.visitor_id && byVisitor.get(s.visitor_id)) ||
      (s.session_id && bySession.get(s.session_id.toLowerCase())) ||
      bySession.get(sessionOfSck(s.sck) ?? '') ||
      null;
    if (!a) continue;
    // Venda de antes do primeiro encaminhamento não é efeito do teste.
    if (new Date(s.sold_at).getTime() < new Date(a.first_seen_at).getTime() - 60_000) continue;
    linked.push({ sale: s, a });
  }

  const arms = PLATFORMS.map((platform) => {
    const armAssign = assignments.filter((a) => a.platform === platform);
    const armSales = linked.filter((l) => l.a.platform === platform);
    const isCross = (s: SaleRow) => !!s.platform && s.platform !== platform;
    const mismatch = armSales.filter((l) => isCross(l.sale)).length;
    const valid = armSales;
    let crossNet = 0;
    let netSamePlatform = 0;

    const netByVisitor = new Map<string, number>();
    const buyers = new Set<string>();
    const orders = new Map<string, { bump: boolean }>();
    let gross = 0, fees = 0, net = 0, netEstimated = 0, refunds = 0, refundedValue = 0, bumpItems = 0;

    for (const { sale, a } of valid) {
      if (!PAID.has(sale.status)) continue;
      const key = sale.order_external_id || sale.external_id || sale.id;
      const order = orders.get(key) ?? { bump: false };
      if (sale.is_order_bump) {
        order.bump = true;
        bumpItems++;
      } else {
        buyers.add(a.visitor_id);
      }
      orders.set(key, order);

      const m = moneyOf(sale);
      if (sale.status === 'approved') {
        gross += m.gross;
        fees += m.fee;
        net += m.net;
        if (m.estimated) netEstimated += m.net;
        if (isCross(sale)) crossNet += m.net;
        else netSamePlatform += m.net;
        netByVisitor.set(a.visitor_id, (netByVisitor.get(a.visitor_id) ?? 0) + m.net);
      } else {
        refunds++;
        refundedValue += Number(sale.refunded_amount ?? m.gross);
        // Reembolso parcial: o que sobrou continua sendo receita.
        const kept = sale.refunded_amount != null ? Math.max(0, m.gross - Number(sale.refunded_amount)) : 0;
        if (kept > 0) {
          const keptNet = m.gross > 0 ? (m.net * kept) / m.gross : 0;
          gross += kept;
          net += keptNet;
          netByVisitor.set(a.visitor_id, (netByVisitor.get(a.visitor_id) ?? 0) + keptNet);
        }
      }
    }

    const perVisitor = armAssign.map((a) => netByVisitor.get(a.visitor_id) ?? 0);
    const npv = meanInterval(perVisitor);
    const orderList = [...orders.values()];
    const approvedOrders = new Set(
      valid.filter((l) => l.sale.status === 'approved').map((l) => l.sale.order_external_id || l.sale.external_id || l.sale.id),
    ).size;

    const segments = {} as ArmReport['segments'];
    for (const seg of ['pago', 'organico'] as const) {
      const segAssign = armAssign.filter((a) => a.segment === seg);
      const segNet = segAssign.reduce((acc, a) => acc + (netByVisitor.get(a.visitor_id) ?? 0), 0);
      segments[seg] = {
        visitors: segAssign.length,
        buyers: segAssign.filter((a) => buyers.has(a.visitor_id)).length,
        net: round(segNet),
        netPerVisitor: segAssign.length ? round(segNet / segAssign.length) : null,
      };
    }

    const conv = wilson(buyers.size, armAssign.length);
    const report: ArmReport & { _se: number } = {
      platform,
      visitors: armAssign.length,
      buyers: buyers.size,
      conversion: { value: round(conv.value, 4), low: round(conv.low, 4), high: round(conv.high, 4) },
      orders: orderList.length,
      ordersWithBump: orderList.filter((o) => o.bump).length,
      bumpRate: orderList.length ? round(orderList.filter((o) => o.bump).length / orderList.length, 4) : null,
      bumpItems,
      gross: round(gross),
      fees: round(fees),
      net: round(net),
      netEstimated: round(netEstimated),
      avgTicketGross: approvedOrders ? round(gross / approvedOrders) : null,
      avgTicketNet: approvedOrders ? round(net / approvedOrders) : null,
      netPerVisitor: { value: round(npv.value), low: round(npv.low), high: round(npv.high) },
      refunds,
      refundedValue: round(refundedValue),
      platformMismatch: mismatch,
      crossNet: round(crossNet),
      netSamePlatform: round(netSamePlatform),
      segments,
      _se: npv.se,
    };
    return report;
  });

  const crossSales: CrossSale[] = linked
    .filter((l) => l.sale.platform && l.sale.platform !== l.a.platform)
    .map((l) => {
      const m = moneyOf(l.sale);
      return {
        external_id: l.sale.external_id,
        assigned: l.a.platform,
        effective: l.sale.platform,
        status: l.sale.status,
        gross: round(m.gross),
        net: round(m.net),
        sold_at: l.sale.sold_at,
      };
    });

  const verdict = verdictOf(arms);
  return { arms: arms.map(({ _se, ...rest }) => rest), verdict, crossSales };
}

function verdictOf(arms: Array<ArmReport & { _se: number }>): Verdict {
  const [h, k] = arms;
  if (!h.visitors || !k.visitors) {
    return { status: 'sem_dados', difference: null, message: 'Ainda não há visitantes nas duas plataformas.' };
  }
  const diff = k.netPerVisitor.value - h.netPerVisitor.value;
  const se = Math.sqrt(h._se ** 2 + k._se ** 2);
  const difference = { value: round(diff), low: round(diff - Z * se), high: round(diff + Z * se) };

  if (h.buyers < MIN_BUYERS_PER_ARM || k.buyers < MIN_BUYERS_PER_ARM) {
    return {
      status: 'amostra_insuficiente',
      difference,
      message: `Amostra pequena (${h.buyers} compradores na Hotmart, ${k.buyers} na Kiwify). Os números variam muito de um dia para o outro nesse tamanho: não dá para escolher ainda.`,
    };
  }
  if (difference.low <= 0 && difference.high >= 0) {
    return {
      status: 'sem_diferenca_clara',
      difference,
      message: 'A diferença ainda está dentro da margem de incerteza. Pode ser sorte: continue até o fim do período ou do teto de investimento.',
    };
  }
  return diff > 0
    ? { status: 'kiwify_melhor', difference, message: 'A Kiwify rende mais por visitante, com a margem de incerteza inteira acima de zero.' }
    : { status: 'hotmart_melhor', difference, message: 'A Hotmart rende mais por visitante, com a margem de incerteza inteira acima de zero.' };
}
