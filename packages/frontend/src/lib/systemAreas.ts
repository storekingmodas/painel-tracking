/**
 * Áreas que o próprio painel cria e mantém — não são nichos da usuária:
 *  - "Sem área": caixa de entrada da venda de produto ainda sem área (nada
 *    vai ao Meta até ela decidir); recriada sozinha pelo webhook.
 *  - "Testes": compras de teste do A/B, fora do faturamento da área real.
 *
 * Ficam fora do seletor do menu (ela pediu: "esconda sem área e teste") e
 * continuam acessíveis pela tela Produtos. Não são apagáveis: têm vendas.
 */
export const SYSTEM_AREA_NAMES = ['Sem área', 'Testes'];

export function isSystemArea(name: string | null | undefined): boolean {
  return !!name && SYSTEM_AREA_NAMES.includes(name);
}

/**
 * As áreas do seletor: só as dela. A área de sistema que estiver ATIVA
 * continua na lista — senão o seletor ficaria em branco enquanto ela olha a
 * "Sem área" aberta pela tela Produtos.
 */
export function selectableAreas<T extends { id: string; name: string }>(areas: T[], activeId: string | null): T[] {
  return areas.filter((a) => !isSystemArea(a.name) || a.id === activeId);
}
