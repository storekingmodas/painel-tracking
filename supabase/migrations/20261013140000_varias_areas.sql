-- ============================================================
-- Várias áreas por usuário
-- ============================================================
-- A base (20261002120000) travou o painel em uma área só: tirou o seletor da
-- tela e criou idx_workspaces_one_per_user. O resto do sistema continua por
-- área (vendas, sessões, pixel, token da CAPI, webhooks), e esta instalação
-- precisa de uma área por pixel — um nicho ou uma família de nichos cada.
--
-- O seletor volta ao menu (Sidebar) e a trava sai. A área criada no cadastro
-- (handle_new_user) continua sendo a primeira.
DROP INDEX IF EXISTS public.idx_workspaces_one_per_user;

-- Conferência: 0 = a trava saiu
SELECT count(*) AS trava_uma_area_por_usuario
FROM pg_indexes
WHERE schemaname = 'public' AND indexname = 'idx_workspaces_one_per_user';
