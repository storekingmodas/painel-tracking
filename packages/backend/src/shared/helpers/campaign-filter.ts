/**
 * Filtro de campanhas da área (workspaces.campaign_filter): palavras separadas
 * por vírgula, procuradas no nome da campanha sem diferenciar maiúscula nem
 * acento. Duas áreas na mesma conta de anúncios se separam assim — cada nicho
 * tem a sua nomenclatura ("[CBO] 24/09 REELS PSICOLOGIA", "... NUTRI ...").
 *
 * Devolve null quando não há filtro: a área soma todas as campanhas das contas
 * ligadas nela, como sempre foi.
 */
export function campaignMatcher(filter: string | null | undefined): ((name: string | null | undefined) => boolean) | null {
  const keys = (filter ?? '')
    .split(',')
    .map((k) => normalize(k))
    .filter(Boolean);
  if (keys.length === 0) return null;
  return (name) => {
    const n = normalize(name ?? '');
    return keys.some((k) => n.includes(k));
  };
}

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
}
