-- O simulador da RPLK passou a usar o projeto da Vistoria (tabela empreendimentos copiada para lá).
-- Este projeto fica só com a estante: sai a tabela da RPLK e a conta do Lucas usada pelo simulador.
begin;
drop table public.empreendimentos;
-- Conta da RPLK (não tinha jogos na estante).
delete from auth.users where id = 'e97e5e74-480e-48ee-93f4-2c5c3a8c428f';
commit;
