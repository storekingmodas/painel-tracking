import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { FastifyReply, FastifyRequest } from 'fastify';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { sharedCookieDomain } from '../tracking/tracking-collect.controller';
import { AbCheckoutService } from './ab-checkout.service';
import { PLATFORMS, Platform } from './ab-core';

type Headers = Record<string, string | string[] | undefined>;
const VARIANT_COOKIE_S = 180 * 24 * 3600;

function header(headers: Headers, name: string): string | null {
  const v = headers[name];
  return (Array.isArray(v) ? v[0] : v)?.trim() || null;
}

function parseCookies(raw: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* cookie malformado: ignora */
    }
  }
  return out;
}

function asPlatform(v: unknown): Platform | null {
  return PLATFORMS.find((p) => p === v) ?? null;
}

/**
 * Redirecionador público. O botão da página aponta para
 * https://checkout.<domínio>/api/checkout-ab?produto=<slug>; o rastreio já
 * acrescenta o sck=stl_… e as UTMs. Sempre responde 302 para uma das URLs
 * cadastradas — nunca para um endereço vindo do link.
 */
@SkipThrottle()
@Controller('checkout-ab')
export class AbCheckoutRedirectController {
  constructor(private readonly ab: AbCheckoutService) {}

  @Get()
  async redirect(@Req() req: FastifyRequest, @Res() res: FastifyReply): Promise<void> {
    const headers = req.headers as Headers;
    const query = Object.fromEntries(
      Object.entries((req.query ?? {}) as Record<string, unknown>).map(([k, v]) => [k, Array.isArray(v) ? String(v[0]) : String(v)]),
    );
    res.header('Cache-Control', 'no-store, private');
    res.header('Referrer-Policy', 'no-referrer-when-downgrade');
    try {
      const result = await this.ab.redirect({
        query,
        cookies: parseCookies(header(headers, 'cookie')),
        country: header(headers, 'x-vercel-ip-country'),
      });
      if (result.variantCookie) {
        const host = (header(headers, 'x-forwarded-host') || header(headers, 'host') || '').split(':')[0].toLowerCase();
        const labels = host.split('.');
        const domain = labels.length >= 3 ? sharedCookieDomain(host, labels.slice(1).join('.')) : null;
        res.header(
          'Set-Cookie',
          `${result.variantCookie.name}=${encodeURIComponent(result.variantCookie.value)}; Max-Age=${VARIANT_COOKIE_S}; Path=/; SameSite=Lax; Secure; HttpOnly${domain ? `; Domain=${domain}` : ''}`,
        );
      }
      res.status(302).header('Location', result.location).send();
    } catch (err: any) {
      res.status(err?.status === 404 ? 404 : 500).header('Content-Type', 'text/plain; charset=utf-8').send(
        'Checkout indisponivel no momento. Volte a pagina e tente de novo.',
      );
    }
  }
}

/** Administração do teste, para a tela "Teste A/B". */
@Controller('ab-checkout')
@UseGuards(AuthGuard)
export class AbCheckoutAdminController {
  constructor(private readonly ab: AbCheckoutService) {}

  @Get()
  list(@CurrentUser('id') userId: string) {
    return this.ab.list(userId);
  }

  @Post()
  save(@CurrentUser('id') userId: string, @Body() body: any) {
    return this.ab.save(userId, body ?? {});
  }

  @Post(':id/status')
  setStatus(@CurrentUser('id') userId: string, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: any) {
    const status = body?.status;
    if (!['draft', 'active', 'paused', 'ended'].includes(status)) throw new BadRequestException('Status invalido');
    return this.ab.setStatus(userId, id, status, asPlatform(body?.forced_platform));
  }

  @Post(':id/test-link')
  testLink(@CurrentUser('id') userId: string, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: any, @Req() req: FastifyRequest) {
    const platform = asPlatform(body?.platform);
    if (!platform) throw new BadRequestException('Plataforma invalida');
    const headers = req.headers as Headers;
    const host = header(headers, 'x-forwarded-host') || header(headers, 'host');
    const base = String(body?.base_url || `https://${host}`).replace(/\/+$/, '');
    if (!/^https:\/\/[a-z0-9.-]+$/i.test(base)) throw new BadRequestException('Endereco invalido');
    return this.ab.testLink(userId, id, platform, base);
  }

  @Post('mark-test')
  markTest(@CurrentUser('id') userId: string, @Body() body: any) {
    return this.ab.markTest(userId, String(body?.order ?? ''), body?.is_test !== false);
  }

  @Get(':id/report')
  report(@CurrentUser('id') userId: string, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.ab.report(userId, id);
  }

  @Get(':id/test-sales')
  testSales(@CurrentUser('id') userId: string, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.ab.testSales(userId, id);
  }

  @Get(':id/events')
  events(@CurrentUser('id') userId: string, @Param('id', new ParseUUIDPipe()) id: string, @Query() _q: unknown) {
    return this.ab.events(userId, id);
  }
}
