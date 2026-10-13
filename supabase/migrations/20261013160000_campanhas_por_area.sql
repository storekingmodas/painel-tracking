-- ============================================================
-- Campanhas de cada área, pelo nome
-- ============================================================
-- Duas áreas (dois pixels) podem rodar na mesma conta de anúncios. O gasto
-- vinha da conta inteira para a área onde ela estava ligada, e o ROAS de um
-- nicho somava o gasto do outro.
--
-- campaign_filter: palavras separadas por vírgula ("PSICOLOGIA", "NUTRI").
-- Preenchido, a área usa as contas de anúncio ativas de qualquer área da
-- usuária e soma só as campanhas cujo nome contém alguma das palavras
-- (sem diferenciar maiúscula nem acento). Vazio, tudo como antes.
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS campaign_filter text;

COMMENT ON COLUMN public.workspaces.campaign_filter IS
'Palavras (separadas por vírgula) do nome das campanhas desta área. Vazio = todas as campanhas das contas ligadas na área.';

-- Conferência
SELECT count(*) AS coluna_campaign_filter
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'workspaces' AND column_name = 'campaign_filter';
