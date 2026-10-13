import { SupabaseClient } from '@supabase/supabase-js';

const STL = /stl_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export interface AbSaleTag {
  ab_experiment_id: string;
  /** A plataforma SORTEADA. A efetiva é a da integração que mandou a venda. */
  ab_assigned_platform: string;
  is_test: boolean;
  workspace_id: string;
}

/** O código da visita (stl_<sessão>) em qualquer referência da venda. */
export function sessionOfRefs(refs: Array<string | null | undefined>): string | null {
  for (const r of refs) {
    const m = String(r ?? '').match(STL);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/**
 * Liga a venda ao encaminhamento do A/B pelo código da visita que o
 * redirecionador mandou ao checkout e que volta no webhook. O link de teste
 * cria um código próprio, então o pedido chega já marcado como teste — antes
 * de qualquer Purchase. Nunca lança: sem tabela ou sem match, null.
 */
export async function abTagForSale(
  getClient: () => SupabaseClient,
  refs: Array<string | null | undefined>,
): Promise<AbSaleTag | null> {
  const sid = sessionOfRefs(refs);
  if (!sid) return null;
  try {
    const { data } = await getClient()
      .from('ab_assignments')
      .select('experiment_id, platform, is_test, last_redirect_at, ab_experiments(workspace_id)')
      .eq('session_id', sid)
      .order('last_redirect_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return null;
    const ws = (data as any).ab_experiments?.workspace_id;
    if (!ws) return null;
    return {
      ab_experiment_id: data.experiment_id,
      ab_assigned_platform: data.platform,
      is_test: !!data.is_test,
      workspace_id: ws,
    };
  } catch {
    return null;
  }
}
