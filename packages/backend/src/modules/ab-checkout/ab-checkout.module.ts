import { Module } from '@nestjs/common';
import { AbCheckoutAdminController, AbCheckoutRedirectController } from './ab-checkout.controller';
import { AbCheckoutService } from './ab-checkout.service';

/**
 * Teste A/B de checkout (Hotmart × Kiwify): o redirecionador público e a
 * tela de administração. Não mexe no rastreio — só lê a visita que ele gravou.
 */
@Module({
  controllers: [AbCheckoutRedirectController, AbCheckoutAdminController],
  providers: [AbCheckoutService],
})
export class AbCheckoutModule {}
