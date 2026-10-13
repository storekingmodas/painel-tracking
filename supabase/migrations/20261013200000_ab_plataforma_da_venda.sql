-- ============================================================
-- A/B: plataforma sorteada × plataforma efetiva da venda
-- ============================================================
-- A efetiva já está na venda (a integração que mandou o webhook). Aqui fica
-- a SORTEADA, gravada quando o webhook chega com o código da visita que o
-- redirecionador mandou ao checkout. Venda cruzada (sorteada numa, comprada
-- na outra) fica nos dados como veio — o relatório mostra, não descarta.
--
-- Só acrescenta colunas vazias. Nenhum dado existente muda.

ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS ab_experiment_id uuid
  REFERENCES public.ab_experiments(id) ON DELETE SET NULL;
ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS ab_assigned_platform text
  CHECK (ab_assigned_platform IS NULL OR ab_assigned_platform IN ('hotmart', 'kiwify'));

CREATE INDEX IF NOT EXISTS idx_sales_ab_experiment
  ON public.sales (ab_experiment_id) WHERE ab_experiment_id IS NOT NULL;

-- Conferência: 2 colunas novas e nenhuma venda ligada ainda.
SELECT
  (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sales'
     AND column_name IN ('ab_experiment_id', 'ab_assigned_platform')) AS colunas_novas,
  (SELECT count(*) FROM public.sales WHERE ab_experiment_id IS NOT NULL) AS vendas_ligadas;
