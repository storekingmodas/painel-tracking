import { Test, TestingModule } from '@nestjs/testing';
import { WebhooksService } from '../webhooks.service';
import { SupabaseService } from '../../../shared/services/supabase.service';

describe('WebhooksService', () => {
  let service: WebhooksService;
  let mockSupabase: any;
  let mockClient: any;

  beforeEach(async () => {
    mockClient = {
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      ilike: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
      update: jest.fn().mockReturnThis(),
    };

    mockSupabase = {
      getClient: jest.fn().mockReturnValue(mockClient),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksService,
        { provide: SupabaseService, useValue: mockSupabase },
      ],
    }).compile();

    service = module.get<WebhooksService>(WebhooksService);
  });

  describe('extractAdId', () => {
    it('pula o posicionamento em texto e fica com o id numerico do utm_content', () => {
      // Venda real da Kiwify: utm_term={{placement}}, utm_content={{ad.id}}.
      expect(
        service.extractAdId({ utm_term: 'Instagram_Stories', utm_content: '120246505866090138', src: 'ig' }),
      ).toBe('120246505866090138');
    });

    it('acha o id dentro de um pacote com pipe', () => {
      expect(service.extractAdId({ utm_content: 'CTV 59|120239247454720535' })).toBe('120239247454720535');
    });

    it('sem nenhum id numerico, devolve null em vez de um texto qualquer', () => {
      expect(service.extractAdId({ utm_term: 'Instagram_Reels', src: 'ig', sck: 'stl_abc' })).toBeNull();
      expect(service.extractAdId({})).toBeNull();
    });
  });

  describe('matchAndUpdateSale', () => {
    it('should be defined', () => {
      expect(service.matchAndUpdateSale).toBeDefined();
    });

    it('should call matchSaleToAds and update sale when match found', async () => {
      jest.spyOn(service, 'matchSaleToAds').mockResolvedValue({
        campaign_id: 'camp-uuid',
        ad_set_id: 'adset-uuid',
        ad_internal_id: 'ad-uuid',
      });

      mockClient.eq.mockReturnValue({ error: null });

      await service.matchAndUpdateSale('sale-123', 'user-456', {
        adId: '120245519580910309',
        utmCampaign: null,
        utmContent: null,
        utmTerm: null,
      });

      expect(service.matchSaleToAds).toHaveBeenCalledWith(
        'user-456',
        '120245519580910309',
        null,
        null,
        null,
        undefined,
        undefined,
      );
    });

    it('should not update sale when no match found', async () => {
      jest.spyOn(service, 'matchSaleToAds').mockResolvedValue({
        campaign_id: null,
        ad_set_id: null,
        ad_internal_id: null,
      });

      await service.matchAndUpdateSale('sale-123', 'user-456', {
        adId: null,
        utmCampaign: null,
        utmContent: null,
        utmTerm: null,
      });

      expect(mockClient.update).not.toHaveBeenCalled();
    });

    it('should not throw when match fails', async () => {
      jest.spyOn(service, 'matchSaleToAds').mockRejectedValue(
        new Error('DB connection failed'),
      );

      await expect(
        service.matchAndUpdateSale('sale-123', 'user-456', {
          adId: '120245519580910309',
          utmCampaign: null,
          utmContent: null,
          utmTerm: null,
        }),
      ).resolves.not.toThrow();
    });
  });
});
