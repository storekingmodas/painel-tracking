/**
 * Janela em que a compra seguinte da mesma pessoa conta como bump/upsell da
 * primeira. A Kiwify cobra cada produto do carrinho em separado e manda um
 * webhook por produto, segundos um do outro, sem dizer qual é o bump.
 */
export const BUYER_ORDER_WINDOW_MS = 15 * 60_000;

/**
 * Plataformas que não marcam o order bump. Nelas o painel agrupa as vendas
 * pelo comprador (SalesService.groupWithBuyerOrder).
 */
export const BUYER_GROUPED_PLATFORMS = ['kiwify'] as const;

/**
 * Plataformas em que o bump chega num webhook próprio, depois (ou antes) da
 * compra principal. O Purchase da CAPI só sai depois da janela
 * (MetaCapiService.flushDeferredPurchases), com o pedido inteiro — mandar na
 * hora levaria só o produto principal, e o Meta não aceita somar depois: um
 * segundo Purchase com o mesmo event_id é descartado.
 *
 * A Hotmart identifica o bump (order_bump.parent_purchase_transaction) e o
 * pedido sai certo pelo próprio processor; a Kiwify depende do agrupamento
 * pelo comprador. Nas duas, o envio espera.
 */
export const DEFERRED_PURCHASE_PLATFORMS = ['kiwify', 'hotmart'] as const;
