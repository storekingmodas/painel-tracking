import { Module } from '@nestjs/common';
import { MetaCapiModule } from '../meta-capi/meta-capi.module';
import { ProductAreasController } from './product-areas.controller';
import { ProductAreasService } from './product-areas.service';

@Module({
  imports: [MetaCapiModule],
  controllers: [ProductAreasController],
  providers: [ProductAreasService],
})
export class ProductAreasModule {}
