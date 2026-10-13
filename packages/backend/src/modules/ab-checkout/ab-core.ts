import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Regras puras do teste A/B de checkout: sorteio, link de teste assinado,
 * cookie assinado da variante e o link final de cada plataforma. Sem banco,
 * para os testes cobrirem cada caso.
 */

export type Platform = 'hotmart' | 'kiwify';
export const PLATFORMS: readonly Platform[] = ['hotmart', 'kiwify'];

/** Parâmetros do redirecionador que nunca seguem para o checkout. */
export const CONTROL_PARAMS = new Set(['produto', 'forcar', 'validade', 'assinatura']);

const STL = /stl_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const AD_ID = /^\d{6,25}$/;
const PAID_SOURCES = /^(fb|ig|facebook|instagram|an|msg|meta|messenger)$/i;

/** Sorteio: split = % da Hotmart. rand em [0, 1). */
export function pickPlatform(splitHotmart: number, rand: number): Platform {
  return rand * 100 < splitHotmart ? 'hotmart' : 'kiwify';
}

/** O código da visita (stl_<sessão>) em qualquer parâmetro. */
export function sessionFromParams(params: Record<string, string>): string | null {
  for (const v of Object.values(params)) {
    const m = String(v ?? '').match(STL);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/** Veio de anúncio? Clique do Meta, id do anúncio ou fonte de mídia paga. */
export function segmentOf(params: Record<string, string>, sessionFbc: string | null | undefined): 'pago' | 'organico' {
  if (sessionFbc || params.fbclid || AD_ID.test(params.ad_id ?? '') || PAID_SOURCES.test(params.utm_source ?? '')) {
    return 'pago';
  }
  return 'organico';
}

function hmac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Link de teste: forçar uma plataforma, só com assinatura e prazo. */
export function signTest(secret: string, slug: string, platform: Platform, expiresAtMs: number): string {
  return hmac(secret, `teste|${slug}|${platform}|${expiresAtMs}`);
}

/**
 * Plataforma do link de teste, ou null. `invalid` = alguém mandou `forcar` sem
 * assinatura válida (ou vencida): é registrado e ignorado.
 */
export function verifyTest(
  secret: string,
  slug: string,
  forcar: string | undefined,
  validade: string | undefined,
  assinatura: string | undefined,
  nowMs: number,
): { platform: Platform | null; invalid: boolean } {
  if (!forcar) return { platform: null, invalid: false };
  const platform = PLATFORMS.find((p) => p === forcar.toLowerCase()) ?? null;
  const exp = Number(validade);
  if (!platform || !Number.isFinite(exp) || exp < nowMs || !assinatura) return { platform: null, invalid: true };
  return safeEqual(signTest(secret, slug, platform, exp), assinatura)
    ? { platform, invalid: false }
    : { platform: null, invalid: true };
}

/** Cookie da variante: "<plataforma>.<assinatura>", amarrado ao experimento. */
export function signVariantCookie(secret: string, slug: string, platform: Platform): string {
  return `${platform}.${hmac(secret, `variante|${slug}|${platform}`)}`;
}

export function readVariantCookie(secret: string, slug: string, value: string | undefined): Platform | null {
  if (!value) return null;
  const [p, sig] = value.split('.');
  const platform = PLATFORMS.find((x) => x === p) ?? null;
  if (!platform || !sig) return null;
  return safeEqual(signVariantCookie(secret, slug, platform), value) ? platform : null;
}

/**
 * Pacote de rastreio no formato do painel antigo (tracking_layout):
 * fonte|campanha|id|conjunto|id|anúncio|id|posicionamento. É o que ele lê no
 * src (Hotmart e Kiwify) para os nomes da campanha, do conjunto e do anúncio.
 */
export function trackingPack(p: Record<string, string>): string | null {
  if (!AD_ID.test(p.ad_id ?? '')) return null;
  return [p.utm_source, p.utm_campaign, p.cmp_id, p.utm_medium, p.set_id, p.utm_content, p.ad_id, p.utm_term]
    .map((v) => String(v ?? '').replace(/\|/g, ' '))
    .join('|');
}

/**
 * O link final: a URL cadastrada da plataforma + os parâmetros da visita no
 * formato que cada uma devolve no webhook.
 *
 *   - Todos: sck (o código da visita, que liga a venda à visita) e as UTMs.
 *   - Hotmart: xcod = id do anúncio (é dele que o processador tira o anúncio)
 *     e src = pacote com os nomes.
 *   - Kiwify: utm_content = id do anúncio (o que os dois painéis leem) e src
 *     = pacote.
 *
 * Um parâmetro que já está na URL cadastrada (checkoutMode=10, por exemplo)
 * não é sobrescrito. O destino é sempre a URL cadastrada: nada do link de
 * entrada escolhe para onde ir.
 */
export function buildTargetUrl(base: string, platform: Platform, params: Record<string, string>): string {
  const url = new URL(base);
  const set = (k: string, v: string | null | undefined, override = false) => {
    if (v == null || v === '') return;
    if (!override && url.searchParams.has(k)) return;
    url.searchParams.set(k, String(v).slice(0, 500));
  };

  for (const [k, v] of Object.entries(params)) {
    if (CONTROL_PARAMS.has(k)) continue;
    set(k, v);
  }

  const adId = AD_ID.test(params.ad_id ?? '') ? params.ad_id : null;
  const pack = trackingPack(params);
  if (platform === 'hotmart') {
    set('xcod', adId, true);
    set('src', pack);
  } else {
    set('utm_content', adId, true);
    set('src', pack);
  }
  return url.toString().slice(0, 4000);
}
