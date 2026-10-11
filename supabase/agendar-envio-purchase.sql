-- ============================================================
-- Agenda o envio do Purchase da Kiwify, a cada minuto
-- ============================================================
-- A Kiwify manda um webhook por produto (principal e cada bump), sem dizer
-- qual é bump. O painel junta as compras da mesma pessoa em 15 minutos e só
-- manda o Purchase à API de Conversões depois disso, com o pedido inteiro.
-- Quem dispara esse envio é a rota /api/capi/flush-cron — e a Vercel Hobby
-- só agenda cron diário. Então o agendamento fica aqui, no pg_cron do
-- Supabase, chamando a rota pelo pg_net.
--
-- NÃO é migration: depende do domínio e do segredo de cada instalação.
-- Rode uma vez no SQL Editor, trocando os dois valores abaixo:
--   SEU-DOMINIO   → o endereço do painel (ex.: track.seudominio.com.br)
--   SEU-CRON-SECRET → o mesmo valor da variável CRON_SECRET da Vercel
--
-- O segredo vai para o Vault do Supabase (cifrado), não para o texto do job.
-- Rodar de novo atualiza o job (cron.schedule substitui pelo nome).
-- ============================================================

-- 1. Guarda o segredo no Vault (troca, se já existir)
DO $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM vault.secrets WHERE name = 'painel_cron_secret';
  IF v_id IS NULL THEN
    PERFORM vault.create_secret('SEU-CRON-SECRET', 'painel_cron_secret');
  ELSE
    PERFORM vault.update_secret(v_id, 'SEU-CRON-SECRET');
  END IF;
END $$;

-- 2. Agenda a chamada a cada minuto
SELECT cron.schedule(
  'capi-flush-purchases',
  '* * * * *',
  $job$
  SELECT net.http_get(
    url := 'https://SEU-DOMINIO/api/capi/flush-cron',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'painel_cron_secret')
    ),
    timeout_milliseconds := 20000
  );
  $job$
);

-- 3. Conferência: o job existe e está ativo
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'capi-flush-purchases';
