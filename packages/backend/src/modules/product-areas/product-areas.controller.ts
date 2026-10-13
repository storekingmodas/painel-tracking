import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ProductAreasService } from './product-areas.service';

export class AssignProductAreaDto {
  @IsString()
  @MaxLength(40)
  platform!: string;

  /** "id:<id da plataforma>" ou "nome:<nome do produto>" (productKeys). */
  @IsString()
  @MaxLength(300)
  @Matches(/^(id|nome):/)
  product_key!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  product_name?: string;

  @IsUUID()
  workspace_id!: string;
}

@Controller('product-areas')
@UseGuards(AuthGuard)
export class ProductAreasController {
  constructor(private readonly productAreas: ProductAreasService) {}

  @Get()
  list(@CurrentUser('id') userId: string) {
    return this.productAreas.list(userId);
  }

  @Post()
  assign(@CurrentUser('id') userId: string, @Body() body: AssignProductAreaDto) {
    return this.productAreas.assign(userId, body);
  }
}
