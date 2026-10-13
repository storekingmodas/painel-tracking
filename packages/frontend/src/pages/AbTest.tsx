import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { AlertTriangle, Copy, FlaskConical } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { toast } from '@/hooks/use-toast';

type Platform = 'hotmart' | 'kiwify';
type Status = 'draft' | 'active' | 'paused' | 'ended';

interface Experiment {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  status: Status;
  forced_platform: Platform | null;
  hotmart_url: string | null;
  kiwify_url: string | null;
  split_hotmart: number;
  default_platform: Platform;
  activated_at: string | null;
  budget_cap: number | null;
  evaluation_end: string | null;
}

interface Interval { value: number; low: number; high: number }
interface Arm {
  platform: Platform;
  visitors: number;
  buyers: number;
  conversion: Interval;
  orders: number;
  ordersWithBump: number;
  bumpRate: number | null;
  gross: number;
  fees: number;
  net: number;
  netEstimated: number;
  avgTicketGross: number | null;
  avgTicketNet: number | null;
  netPerVisitor: Interval;
  refunds: number;
  refundedValue: number;
  platformMismatch: number;
  segments: Record<'pago' | 'organico', { visitors: number; buyers: number; net: number; netPerVisitor: number | null }>;
}
interface Report {
  started: boolean;
  counts: { encaminhamentos: number; fora_da_comparacao: number; falhas: number; forcar_invalido: number };
  arms: Arm[];
  verdict: { status: string; difference: Interval | null; message: string } | null;
}

const LABEL: Record<Platform, string> = { hotmart: 'Hotmart', kiwify: 'Kiwify' };
const STATUS_LABEL: Record<Status, string> = {
  draft: 'Desligado (tudo vai para a plataforma padrão)',
  active: 'Ativo (sorteio)',
  paused: 'Pausado (100% numa plataforma)',
  ended: 'Encerrado',
};
const BASE_KEY = 'ab-redirect-base';

const brl = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const pct = (n: number | null | undefined) => (n == null ? '—' : `${(n * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`);

function readBase(): string {
  try {
    return localStorage.getItem(BASE_KEY) || window.location.origin;
  } catch {
    return window.location.origin;
  }
}

const empty = {
  name: '',
  slug: '',
  workspace_id: '',
  hotmart_url: '',
  kiwify_url: '',
  split_hotmart: 50,
  default_platform: 'hotmart' as Platform,
  budget_cap: '' as string | number,
  evaluation_end: '',
};

/**
 * Teste A/B de checkout: o botão da página aponta para o redirecionador, que
 * sorteia Hotmart ou Kiwify por visitante e mantém a escolha. A comparação
 * conta só o que veio depois da ativação, sem compras de teste.
 */
export default function AbTest() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [base, setBase] = useState(readBase);
  const [testOrder, setTestOrder] = useState('');
  const [testLinks, setTestLinks] = useState<Partial<Record<Platform, string>>>({});

  const { data: experiments, isLoading } = useQuery({
    queryKey: ['ab-experiments'],
    queryFn: () => api.get<Experiment[]>('/ab-checkout'),
  });
  const { data: areas } = useQuery({
    queryKey: ['product-areas'],
    queryFn: () => api.get<{ areas: { id: string; name: string }[] }>('/product-areas'),
  });

  const exp = useMemo(
    () => experiments?.find((e) => e.id === selectedId) ?? (selectedId === 'novo' ? null : experiments?.[0] ?? null),
    [experiments, selectedId],
  );

  useEffect(() => {
    setTestLinks({});
    setForm(
      exp
        ? {
            name: exp.name,
            slug: exp.slug,
            workspace_id: exp.workspace_id,
            hotmart_url: exp.hotmart_url ?? '',
            kiwify_url: exp.kiwify_url ?? '',
            split_hotmart: exp.split_hotmart,
            default_platform: exp.default_platform,
            budget_cap: exp.budget_cap ?? '',
            evaluation_end: exp.evaluation_end ? exp.evaluation_end.slice(0, 10) : '',
          }
        : empty,
    );
  }, [exp]);

  const { data: report } = useQuery({
    queryKey: ['ab-report', exp?.id],
    queryFn: () => api.get<Report>(`/ab-checkout/${exp!.id}/report`),
    enabled: !!exp?.id,
    refetchInterval: 60_000,
  });
  const { data: events } = useQuery({
    queryKey: ['ab-events', exp?.id],
    queryFn: () => api.get<{ kind: string; platform: string | null; detail: any; created_at: string }[]>(`/ab-checkout/${exp!.id}/events`),
    enabled: !!exp?.id,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['ab-experiments'] });
    qc.invalidateQueries({ queryKey: ['ab-report'] });
    qc.invalidateQueries({ queryKey: ['ab-events'] });
  };

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast({ title: ok });
      refresh();
    } catch (e: any) {
      toast({ title: 'Não foi possível', description: e?.message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      const saved = await api.post<Experiment>('/ab-checkout', {
        id: exp?.id,
        ...form,
        split_hotmart: Number(form.split_hotmart),
        budget_cap: form.budget_cap === '' ? null : Number(form.budget_cap),
        evaluation_end: form.evaluation_end || null,
      });
      setSelectedId(saved.id);
    }, 'Salvo');

  const setStatus = (status: Status, forced?: Platform) => {
    if (status === 'active' && !exp?.activated_at &&
      !window.confirm('Ativar o sorteio? A partir de agora metade dos cliques vai para cada checkout, e a comparação começa a contar.')) return;
    run(() => api.post(`/ab-checkout/${exp!.id}/status`, { status, forced_platform: forced }), 'Status alterado');
  };

  const makeTestLink = async (platform: Platform) => {
    try {
      try { localStorage.setItem(BASE_KEY, base); } catch { /* sem storage */ }
      const r = await api.post<{ url: string }>(`/ab-checkout/${exp!.id}/test-link`, { platform, base_url: base });
      setTestLinks((l) => ({ ...l, [platform]: r.url }));
    } catch (e: any) {
      toast({ title: 'Não foi possível gerar', description: e?.message, variant: 'destructive' });
    }
  };

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => toast({ title: 'Copiado' }), () => undefined);
  };

  const buttonUrl = exp ? `${base.replace(/\/+$/, '')}/api/checkout-ab?produto=${exp.slug}` : '';
  const field = (k: keyof typeof empty) => ({
    value: String(form[k] ?? ''),
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value })),
  });

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-sentinel-in">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-foreground">Teste A/B de checkout</h1>
            <p className="text-sm text-muted-foreground/70 mt-1">Hotmart × Kiwify, com o mesmo visitante sempre na mesma plataforma</p>
          </div>
          {experiments && experiments.length > 0 && (
            <div className="flex gap-2">
              <Select value={exp?.id ?? 'novo'} onValueChange={setSelectedId}>
                <SelectTrigger className="h-9 w-[220px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {experiments.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
                  <SelectItem value="novo">+ Novo teste</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><FlaskConical className="h-4 w-4" /> Configuração</CardTitle>
              <CardDescription>
                Os links precisam ter a mesma oferta e os mesmos bumps nas duas plataformas. Trocar um link aqui vale na hora, sem mexer na página.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5"><Label>Nome</Label><Input {...field('name')} placeholder="Nutrição Esportiva" /></div>
              <div className="space-y-1.5"><Label>Código no link (letras minúsculas e hífen)</Label><Input {...field('slug')} placeholder="nutricao-esportiva" /></div>
              <div className="space-y-1.5">
                <Label>Área (pixel)</Label>
                <Select value={form.workspace_id || undefined} onValueChange={(v) => setForm((f) => ({ ...f, workspace_id: v }))}>
                  <SelectTrigger className="h-9"><SelectValue placeholder="Escolher área…" /></SelectTrigger>
                  <SelectContent>{areas?.areas.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Plataforma padrão (desligado, falhas, fora do Brasil)</Label>
                <Select value={form.default_platform} onValueChange={(v) => setForm((f) => ({ ...f, default_platform: v as Platform }))}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="hotmart">Hotmart</SelectItem><SelectItem value="kiwify">Kiwify</SelectItem></SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5"><Label>Link do checkout Hotmart</Label><Input {...field('hotmart_url')} placeholder="https://pay.hotmart.com/…" /></div>
              <div className="space-y-1.5"><Label>Link do checkout Kiwify</Label><Input {...field('kiwify_url')} placeholder="https://pay.kiwify.com.br/…" /></div>
              <div className="space-y-1.5"><Label>% para a Hotmart no sorteio</Label><Input type="number" min={0} max={100} {...field('split_hotmart')} /></div>
              <div className="space-y-1.5"><Label>Teto de investimento do teste (R$, opcional)</Label><Input type="number" min={0} {...field('budget_cap')} /></div>
              <div className="space-y-1.5"><Label>Fim do período de avaliação (opcional)</Label><Input type="date" {...field('evaluation_end')} /></div>
              <div className="flex items-end"><Button onClick={save} disabled={busy}>{exp ? 'Salvar alterações' : 'Criar teste'}</Button></div>
            </CardContent>
          </Card>
        )}

        {exp && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Estado: {STATUS_LABEL[exp.status]}{exp.forced_platform ? ` — ${LABEL[exp.forced_platform]}` : ''}</CardTitle>
              <CardDescription>
                {exp.activated_at
                  ? `Comparação contando desde ${format(new Date(exp.activated_at), "dd/MM 'às' HH:mm", { locale: ptBR })}.`
                  : 'Ainda não foi ativado: nada conta na comparação.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {exp.status !== 'active' && <Button onClick={() => setStatus('active')} disabled={busy}>Ativar sorteio</Button>}
                <Button variant="outline" onClick={() => setStatus('paused', 'hotmart')} disabled={busy}>100% Hotmart</Button>
                <Button variant="outline" onClick={() => setStatus('paused', 'kiwify')} disabled={busy}>100% Kiwify</Button>
              </div>

              <div className="space-y-1.5">
                <Label>Endereço do redirecionador (o subdomínio de rastreio da página)</Label>
                <Input value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://checkout.seudominio.com" />
              </div>
              <div className="space-y-1.5">
                <Label>Link para o botão da página</Label>
                <div className="flex gap-2">
                  <Input readOnly value={buttonUrl} />
                  <Button variant="outline" size="icon" onClick={() => copy(buttonUrl)}><Copy className="h-4 w-4" /></Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Links de teste (forçam uma plataforma, valem 24 h, não entram na comparação)</Label>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => makeTestLink('hotmart')}>Gerar link de teste Hotmart</Button>
                  <Button variant="outline" size="sm" onClick={() => makeTestLink('kiwify')}>Gerar link de teste Kiwify</Button>
                </div>
                {(['hotmart', 'kiwify'] as Platform[]).map((p) =>
                  testLinks[p] ? (
                    <div key={p} className="flex gap-2">
                      <Input readOnly value={testLinks[p]} />
                      <Button variant="outline" size="icon" onClick={() => copy(testLinks[p]!)}><Copy className="h-4 w-4" /></Button>
                    </div>
                  ) : null,
                )}
              </div>

              <div className="space-y-1.5">
                <Label>Marcar compra de teste (número do pedido): sai dos relatórios</Label>
                <div className="flex gap-2">
                  <Input value={testOrder} onChange={(e) => setTestOrder(e.target.value)} placeholder="HP1234567890 ou id da Kiwify" />
                  <Button
                    variant="outline"
                    disabled={busy || !testOrder.trim()}
                    onClick={() => run(async () => {
                      const r = await api.post<{ updated: number }>('/ab-checkout/mark-test', { order: testOrder });
                      if (!r.updated) throw new Error('Nenhuma venda com esse número');
                      setTestOrder('');
                    }, 'Compra marcada como teste')}
                  >
                    Marcar
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {exp && report?.started && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Resultado</CardTitle>
              <CardDescription>
                Só visitantes do Brasil sorteados depois da ativação, sem compras de teste. Entre colchetes, a margem de incerteza (95%).
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {report.verdict && (
                <div className={`rounded-md border p-3 text-sm ${report.verdict.status.endsWith('melhor') ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-amber-500/40 bg-amber-500/5'}`}>
                  {report.verdict.message}
                  {report.verdict.difference && (
                    <div className="mt-1 text-muted-foreground">
                      Kiwify − Hotmart, líquido por visitante: {brl(report.verdict.difference.value)} [{brl(report.verdict.difference.low)} a {brl(report.verdict.difference.high)}]
                    </div>
                  )}
                </div>
              )}

              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead />
                      {report.arms.map((a) => <TableHead key={a.platform} className="text-right">{LABEL[a.platform]}</TableHead>)}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {([
                      ['Visitantes encaminhados', (a: Arm) => a.visitors.toLocaleString('pt-BR')],
                      ['Compradores', (a: Arm) => a.buyers.toLocaleString('pt-BR')],
                      ['Conversão', (a: Arm) => `${pct(a.conversion.value)} [${pct(a.conversion.low)} a ${pct(a.conversion.high)}]`],
                      ['Pedidos com bump', (a: Arm) => `${a.ordersWithBump} de ${a.orders} (${pct(a.bumpRate)})`],
                      ['Ticket médio (bruto)', (a: Arm) => brl(a.avgTicketGross)],
                      ['Faturamento bruto', (a: Arm) => brl(a.gross)],
                      ['Taxas da plataforma', (a: Arm) => brl(a.fees)],
                      ['Líquido', (a: Arm) => brl(a.net)],
                      ['Líquido por visitante', (a: Arm) => `${brl(a.netPerVisitor.value)} [${brl(a.netPerVisitor.low)} a ${brl(a.netPerVisitor.high)}]`],
                      ['Reembolsos', (a: Arm) => `${a.refunds} (${brl(a.refundedValue)})`],
                      ['Pago: visitantes / compradores', (a: Arm) => `${a.segments.pago.visitors} / ${a.segments.pago.buyers}`],
                      ['Pago: líquido por visitante', (a: Arm) => brl(a.segments.pago.netPerVisitor)],
                      ['Orgânico: visitantes / compradores', (a: Arm) => `${a.segments.organico.visitors} / ${a.segments.organico.buyers}`],
                      ['Orgânico: líquido por visitante', (a: Arm) => brl(a.segments.organico.netPerVisitor)],
                    ] as [string, (a: Arm) => string][]).map(([label, fn]) => (
                      <TableRow key={label}>
                        <TableCell className="text-muted-foreground">{label}</TableCell>
                        {report.arms.map((a) => <TableCell key={a.platform} className="text-right tabular-nums">{fn(a)}</TableCell>)}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <p className="text-xs text-muted-foreground">
                {report.counts.encaminhamentos} cliques no total · {report.counts.fora_da_comparacao} visitante(s) fora da comparação (fora do Brasil, teste, rascunho)
                {exp.budget_cap ? ` · teto de investimento ${brl(exp.budget_cap)}` : ''}
                {exp.evaluation_end ? ` · avaliação até ${format(new Date(`${exp.evaluation_end.slice(0, 10)}T12:00:00`), 'dd/MM', { locale: ptBR })}` : ''}
              </p>

              {(report.counts.falhas > 0 || report.counts.forcar_invalido > 0 || report.arms.some((a) => a.platformMismatch > 0 || a.netEstimated > 0)) && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <div className="space-y-1">
                    {report.counts.falhas > 0 && <div>{report.counts.falhas} falha(s) no redirecionamento (a pessoa foi para o checkout mesmo assim, sem trocar de plataforma).</div>}
                    {report.counts.forcar_invalido > 0 && <div>{report.counts.forcar_invalido} tentativa(s) de forçar plataforma sem link válido (ignoradas).</div>}
                    {report.arms.filter((a) => a.platformMismatch > 0).map((a) => (
                      <div key={a.platform}>{a.platformMismatch} venda(s) de visitante da {LABEL[a.platform]} feitas na outra plataforma (fora da conta).</div>
                    ))}
                    {report.arms.filter((a) => a.netEstimated > 0).map((a) => (
                      <div key={`e-${a.platform}`}>{LABEL[a.platform]}: {brl(a.netEstimated)} sem líquido informado, contados pelo bruto.</div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {exp && events && events.length > 0 && (
          <Card>
            <CardHeader><CardTitle className="text-base">Registro (mudanças e falhas)</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-sm">
              {events.map((e, i) => (
                <div key={i} className="flex gap-3">
                  <span className="text-muted-foreground tabular-nums">{format(new Date(e.created_at), 'dd/MM HH:mm', { locale: ptBR })}</span>
                  <span>{e.kind}{e.platform ? ` · ${e.platform}` : ''}{e.detail?.status ? ` · ${e.detail.status}${e.detail.forced ? ` ${e.detail.forced}` : ''}` : ''}{e.detail?.erro ? ` · ${e.detail.erro}` : ''}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
