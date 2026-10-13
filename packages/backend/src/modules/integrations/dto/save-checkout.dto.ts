import { IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';

export class SaveCheckoutDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsString()
  platform!: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  webhook_url?: string;

  @IsOptional()
  @IsString()
  webhook_secret?: string;

  @IsOptional()
  @IsUUID()
  workspace_id?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @IsOptional()
  @IsBoolean()
  use_commission_value?: boolean;

  /** Webhook com todos os produtos da conta; a venda vai para a área certa. */
  @IsOptional()
  @IsBoolean()
  all_products?: boolean;
}
