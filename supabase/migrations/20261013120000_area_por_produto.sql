-- ============================================================
-- Um webhook por plataforma, a venda vai para a área certa
-- ============================================================
-- Até aqui cada webhook de checkout pertencia a uma área: na Kiwify, que só
-- aceita um produto por webhook, cada nicho exigia um webhook por produto
-- (principal e cada bump), e a Hotmart, com um hottok só por conta, não
-- separava duas áreas.
--
-- Agora uma integração pode valer para a conta inteira (all_products). A área
-- de cada venda sai, nesta ordem: da visita que trouxe a venda (a página onde
-- a pessoa clicou já pertence a uma área), da tabela product_areas, e, sem
-- nenhuma das duas, da área especial "Sem área" — que não tem pixel, então
-- nada sai para o Meta até a usuária ligar o produto a uma área.

ALTER TABLE public.checkout_integrations
  ADD COLUMN IF NOT EXISTS all_products boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.checkout_integrations.all_products IS
'Webhook com todos os produtos da conta. A área da venda vem da visita ou de product_areas, não de workspace_id.';

CREATE TABLE IF NOT EXISTS public.product_areas (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform     text NOT NULL,
  product_key  text NOT NULL,
  product_name text,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform, product_key)
);

COMMENT ON TABLE public.product_areas IS
'Produto do checkout -> área. Usado quando a venda chega sem a visita que a trouxe.';

-- Só o servidor (service_role) lê e escreve; a tela passa pela API.
ALTER TABLE public.product_areas ENABLE ROW LEVEL SECURITY;

-- Conferência
SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'checkout_integrations' AND column_name = 'all_products') AS coluna_all_products,
  (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = 'product_areas' AND rowsecurity) AS tabela_product_areas;
