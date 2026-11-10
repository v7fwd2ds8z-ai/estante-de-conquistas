-- Fase 1 das contas: cada jogo passa a ter dono, e só o dono lê e altera.
-- Também restringe a gravação da tabela da RPLK, que divide este projeto com a estante.
begin;

-- 1. Dono dos jogos. Os jogos que já existem são da conta pessoal do Lucas (a da estante).
alter table public.games add column user_id uuid references auth.users (id) on delete cascade;
update public.games set user_id = 'aa0dd106-8cd7-4862-b803-12f38756d251' where user_id is null;
alter table public.games alter column user_id set not null;
alter table public.games alter column user_id set default auth.uid();

-- 2. O id do jogo (ex.: steam_<appid>) só precisa ser único dentro da estante de cada pessoa.
alter table public.games drop constraint games_pkey;
alter table public.games add primary key (user_id, id);

-- 3. RLS: cada um só vê e mexe nos próprios jogos. Sem política para anon, anon não vê nada.
drop policy "Autenticados podem ler jogos" on public.games;
drop policy "Autenticados podem inserir jogos" on public.games;
drop policy "Autenticados podem atualizar jogos" on public.games;
drop policy "Autenticados podem deletar jogos" on public.games;

create policy "Dono lê os próprios jogos" on public.games
  for select to authenticated using (user_id = (select auth.uid()));
create policy "Dono cria os próprios jogos" on public.games
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "Dono altera os próprios jogos" on public.games
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "Dono apaga os próprios jogos" on public.games
  for delete to authenticated using (user_id = (select auth.uid()));

-- 4. RPLK: leitura pública continua; gravar só as duas contas do Lucas.
drop policy "Escrita autenticada" on public.empreendimentos;
drop policy "Atualizacao autenticada" on public.empreendimentos;
drop policy "Remocao autenticada" on public.empreendimentos;

create policy "Lucas cria empreendimentos" on public.empreendimentos
  for insert to authenticated
  with check ((select auth.uid()) in ('e97e5e74-480e-48ee-93f4-2c5c3a8c428f', 'aa0dd106-8cd7-4862-b803-12f38756d251'));
create policy "Lucas altera empreendimentos" on public.empreendimentos
  for update to authenticated
  using ((select auth.uid()) in ('e97e5e74-480e-48ee-93f4-2c5c3a8c428f', 'aa0dd106-8cd7-4862-b803-12f38756d251'))
  with check ((select auth.uid()) in ('e97e5e74-480e-48ee-93f4-2c5c3a8c428f', 'aa0dd106-8cd7-4862-b803-12f38756d251'));
create policy "Lucas apaga empreendimentos" on public.empreendimentos
  for delete to authenticated
  using ((select auth.uid()) in ('e97e5e74-480e-48ee-93f4-2c5c3a8c428f', 'aa0dd106-8cd7-4862-b803-12f38756d251'));

commit;
