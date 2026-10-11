/**
 * Janela em que a compra seguinte da mesma pessoa conta como bump/upsell da
 * primeira. A Kiwify cobra cada produto do carrinho em separado e manda um
 * webhook por produto, segundos um do outro, sem dizer qual é o bump.
 */
export const BUYER_ORDER_WINDOW_MS = 15 * 60_000;

/**
 * Plataformas que não marcam o order bump. Nelas o painel agrupa as vendas
 * pelo comprador (SalesService.groupWithBuyerOrder) e o Purchase da CAPI só
 * sai depois da janela (MetaCapiService.flushDeferredPurchases), com o pedido
 * inteiro — mandar na hora levaria só o produto principal, e o Meta não
 * aceita somar depois: um segundo Purchase com o mesmo event_id é descartado.
 */
export const BUYER_GROUPED_PLATFORMS = ['kiwify'] as const;
