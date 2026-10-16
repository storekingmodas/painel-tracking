import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { AlertTriangle, Package } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { toast } from '@/hooks/use-toast';
import { isSystemArea, SYSTEM_AREA_NAMES } from '@/lib/systemAreas';
import { useWorkspaceContext } from '@/contexts/WorkspaceContext';
import { useNavigate } from 'react-router-dom';

interface ProductRow {
  platform: string;
  product_key: string;
  product_name: string | null;
  workspace_id: string | null;
  sales: number;
  pending: number;
  last_sold_at: string | null;
}

interface ProductAreasResponse {
  areas: { id: string; name: string; has_pixel: boolean }[];
  unassigned_area_id: string | null;
  products: ProductRow[];
}

const PLATFORM_LABEL: Record<string, string> = { kiwify: 'Kiwify', hotmart: 'Hotmart' };

/**
 * Cada produto que já vendeu e a área (o pixel) dele. Com o webhook da conta
 * inteira, a venda que vem de anúncio já cai na área da página onde a pessoa
 * clicou; esta tela cobre a que chega sem visita e tira da área "Sem área" o
 * que ficou esperando.
 */
export default function Products() {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['product-areas'],
    queryFn: () => api.get<ProductAreasResponse>('/product-areas'),
  });

  const assign = async (row: ProductRow, workspaceId: string) => {
    const id = `${row.platform}|${row.product_key}`;
    setSaving(id);
    try {
      const res = await api.post<{ moved: number; sent: number }>('/product-areas', {
        platform: row.platform,
        product_key: row.product_key,
        product_name: row.product_name ?? undefined,
        workspace_id: workspaceId,
      });
      const area = data?.areas.find((a) => a.id === workspaceId)?.name;
      toast({
        title: `Produto ligado à área ${area ?? ''}`,
        description:
          res.moved > 0
            ? `${res.moved} venda(s) saíram de "Sem área"; ${res.sent} enviada(s) ao Meta (as de até 7 dias).`
            : 'As próximas vendas dele sem visita já vão para essa área.',
      });
      await queryClient.invalidateQueries({ queryKey: ['product-areas'] });
      queryClient.invalidateQueries({ queryKey: ['sales'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (e: any) {
      toast({ title: 'Não foi possível salvar', description: e?.message, variant: 'destructive' });
    } finally {
      setSaving(null);
    }
  };

  const pendingTotal = data?.products.reduce((s, p) => s + p.pending, 0) ?? 0;

  // "Sem área" e "Testes" saíram do seletor do menu; daqui ainda se abrem.
  const { workspaces, setActiveWorkspace } = useWorkspaceContext();
  const navigate = useNavigate();
  const systemAreas = SYSTEM_AREA_NAMES.map((n) => workspaces.find((w) => w.name === n)).filter(Boolean) as { id: string; name: string }[];
  const openArea = (id: string) => {
    setActiveWorkspace(id);
    navigate('/sales');
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-sentinel-in">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Produtos</h1>
          <p className="text-sm text-muted-foreground/70 mt-1">
            A área (e o pixel) de cada produto, para as vendas que chegam sem a visita que as trouxe
          </p>
        </div>

        {pendingTotal > 0 && (
          <Card className="border-amber-500/40 bg-amber-500/5">
            <CardContent className="flex items-start gap-3 py-4">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
              <p className="text-sm text-foreground">
                <strong>{pendingTotal} venda(s) em "Sem área".</strong> Elas não foram para nenhum pixel. Escolha a área do
                produto abaixo: as de até 7 dias ainda vão para o Meta, com a data original.
              </p>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Package className="h-4 w-4" /> Produtos vendidos nos últimos 90 dias
            </CardTitle>
            <CardDescription>
              Venda que vem de anúncio vai para a área da página onde a pessoa clicou, sem precisar de nada aqui. A área
              escolhida vale para a venda que chega sem visita (link direto do checkout, bio, WhatsApp).
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
              </div>
            ) : error ? (
              <p className="text-sm text-destructive">Não foi possível carregar: {(error as Error).message}</p>
            ) : !data || data.products.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhuma venda nos últimos 90 dias.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Produto</TableHead>
                      <TableHead>Checkout</TableHead>
                      <TableHead className="text-right">Vendas</TableHead>
                      <TableHead>Última venda</TableHead>
                      <TableHead className="min-w-[200px]">Área</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.products.map((p) => {
                      const id = `${p.platform}|${p.product_key}`;
                      return (
                        <TableRow key={id} className={p.pending > 0 ? 'bg-amber-500/5' : undefined}>
                          <TableCell className="font-medium">
                            {p.product_name ?? p.product_key}
                            {p.pending > 0 && (
                              <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-600 dark:text-amber-400">
                                {p.pending} em Sem área
                              </span>
                            )}
                          </TableCell>
                          <TableCell>{PLATFORM_LABEL[p.platform] ?? p.platform}</TableCell>
                          <TableCell className="text-right tabular-nums">{p.sales}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {p.last_sold_at ? format(new Date(p.last_sold_at), "dd/MM 'às' HH:mm", { locale: ptBR }) : '—'}
                          </TableCell>
                          <TableCell>
                            <Select
                              value={p.workspace_id ?? undefined}
                              onValueChange={(v) => assign(p, v)}
                              disabled={saving === id}
                            >
                              <SelectTrigger className="h-9">
                                <SelectValue placeholder="Escolher área…" />
                              </SelectTrigger>
                              <SelectContent>
                                {data.areas.filter((a) => !isSystemArea(a.name) || a.id === p.workspace_id).map((a) => (
                                  <SelectItem key={a.id} value={a.id}>
                                    {a.name}{a.has_pixel ? '' : ' (sem pixel)'}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {systemAreas.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Áreas do sistema (fora do menu):{' '}
            {systemAreas.map((a, i) => (
              <span key={a.id}>
                {i > 0 && ' · '}
                <button type="button" className="underline hover:text-foreground" onClick={() => openArea(a.id)}>
                  ver vendas em "{a.name}"
                </button>
              </span>
            ))}
            . Para voltar, escolha a área no menu.
          </p>
        )}
      </div>
    </DashboardLayout>
  );
}
