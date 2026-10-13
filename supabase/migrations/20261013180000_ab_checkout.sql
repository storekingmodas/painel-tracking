-- ============================================================
-- Teste A/B de checkout (Hotmart × Kiwify)
-- ============================================================
-- O botão da página aponta para checkout.<domínio>/api/checkout-ab?produto=X.
-- O endpoint sorteia a plataforma (fixa por visitante), registra ANTES de
-- redirecionar e monta o link no formato de cada checkout. A venda volta pelo
-- webhook com o código da visita (sck) e se liga à variante pelo visitante.
--
-- Nada aqui altera o rastreio existente. As colunas novas em sales ficam
-- vazias nas vendas antigas: o relatório do experimento só lê vendas de
-- depois da ativação.

-- 1. Experimentos -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ab_experiments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id    uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  slug            text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,60}$'),
  name            text NOT NULL,
  -- draft: ainda não vale (vai para a plataforma padrão, fora da comparação)
  -- active: sorteia; paused: 100% em forced_platform; ended: idem, encerrado
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'ended')),
  forced_platform text CHECK (forced_platform IN ('hotmart', 'kiwify')),
  hotmart_url     text CHECK (hotmart_url IS NULL OR hotmart_url ~ '^https://pay\.hotmart\.com/'),
  kiwify_url      text CHECK (kiwify_url IS NULL OR kiwify_url ~ '^https://pay\.kiwify\.com\.br/'),
  -- % para a Hotmart no sorteio (o resto vai para a Kiwify)
  split_hotmart   int NOT NULL DEFAULT 50 CHECK (split_hotmart BETWEEN 0 AND 100),
  default_platform text NOT NULL DEFAULT 'hotmart' CHECK (default_platform IN ('hotmart', 'kiwify')),
  activated_at    timestamptz,
  budget_cap      numeric,
  evaluation_end  date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- 2. Atribuições (um visitante por experimento) -------------------------
CREATE TABLE IF NOT EXISTS public.ab_assignments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id    uuid NOT NULL REFERENCES public.ab_experiments(id) ON DELETE CASCADE,
  visitor_id       text NOT NULL,
  session_id       text,
  platform         text NOT NULL CHECK (platform IN ('hotmart', 'kiwify')),
  -- entra na comparação principal? (falso: rascunho, teste, falha, fora da regra)
  eligible         boolean NOT NULL DEFAULT true,
  segment          text NOT NULL DEFAULT 'organico' CHECK (segment IN ('pago', 'organico')),
  country          text,
  is_test          boolean NOT NULL DEFAULT false,
  -- sorteio | 100% | teste | rascunho | cookie (banco recuperado pelo cookie)
  source           text NOT NULL,
  utm_source       text,
  utm_medium       text,
  utm_campaign     text,
  utm_content      text,
  utm_term         text,
  ad_id            text,
  redirect_count   int NOT NULL DEFAULT 1,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_redirect_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (experiment_id, visitor_id)
);
CREATE INDEX IF NOT EXISTS idx_ab_assignments_visitor ON public.ab_assignments (visitor_id);
CREATE INDEX IF NOT EXISTS idx_ab_assignments_session ON public.ab_assignments (session_id);

-- 3. Ocorrências (redirecionamentos, falhas, tentativas de forçar) -------
CREATE TABLE IF NOT EXISTS public.ab_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid REFERENCES public.ab_experiments(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  visitor_id    text,
  session_id    text,
  platform      text,
  detail        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ab_events_exp ON public.ab_events (experiment_id, created_at DESC);

-- 4. Valores por venda (bruto, taxa, líquido, reembolso) e marca de teste --
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS gross_amount    numeric;
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS fee_amount      numeric;
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS net_amount      numeric;
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS refunded_amount numeric;
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS is_test         boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.sales.gross_amount IS 'Preço da oferta em BRL, sem juros de parcelamento. Vazio nas vendas anteriores a 2026-10-13.';
COMMENT ON COLUMN public.sales.net_amount   IS 'Repasse ao produtor em BRL (Hotmart: comissão PRODUCER; Kiwify: my_commission).';
COMMENT ON COLUMN public.sales.is_test      IS 'Compra de teste do A/B: fora dos relatórios do experimento.';

-- Só o servidor (service_role) lê e escreve; a tela passa pela API.
ALTER TABLE public.ab_experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ab_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ab_events      ENABLE ROW LEVEL SECURITY;
-- Sem policy e sem grant: nem a chave pública (anon) nem usuário logado
-- leem ou gravam direto. Só a service_role do servidor.
REVOKE ALL ON public.ab_experiments, public.ab_assignments, public.ab_events FROM anon, authenticated;

-- Conferência: 3 tabelas protegidas, 5 colunas novas, nenhuma permissão
-- pública e nenhuma venda antiga marcada como teste.
SELECT
  (SELECT count(*) FROM information_schema.role_table_grants WHERE table_schema = 'public'
     AND table_name IN ('ab_experiments', 'ab_assignments', 'ab_events')
     AND grantee IN ('anon', 'authenticated')) AS permissoes_publicas,
  (SELECT count(*) FROM public.sales WHERE is_test) AS vendas_marcadas_teste,
  (SELECT count(*) FROM pg_tables WHERE schemaname = 'public'
     AND tablename IN ('ab_experiments', 'ab_assignments', 'ab_events') AND rowsecurity) AS tabelas_ab,
  (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sales'
     AND column_name IN ('gross_amount', 'fee_amount', 'net_amount', 'refunded_amount', 'is_test')) AS colunas_sales;
