# Estante de Conquistas

App pessoal do Lucas para registrar jogos e conquistas (Xbox, PlayStation, Steam, Switch 2, Windows). Um único componente React (`AchievementShelf`) que vira um `index.html` autocontido.

Publicado em: https://v7fwd2ds8z-ai.github.io/estante-de-conquistas/
Repositório: `v7fwd2ds8z-ai/estante-de-conquistas` (usuário do GitHub: `v7fwd2ds8z-ai`)

## Como o Lucas trabalha
- Escreva sempre em português do Brasil, com acentos corretos (inclusive em nomes de arquivos e pastas).
- Prefere fluxos simples; não formalize demais. Ele costuma esclarecer a regra de negócio por conta própria.
- Sempre confira somas de pontos com Python antes de apresentar.
- Ele abre o `index.html` direto no navegador (file://) para ter acesso ao Supabase e ao IGDB, então o build precisa continuar gerando **um único arquivo** `dist/index.html`.

## Comandos
- `npm install` — uma vez
- `npm run dev` — servidor local com recarga automática
- `npm run build` — gera `dist/index.html` (arquivo único, JS e CSS embutidos)
- Deploy: push na `main` dispara `.github/workflows/deploy.yml`, que roda o build e publica `dist/` no GitHub Pages.
  - Requer em Settings → Pages → Source = **GitHub Actions** (uma vez só).

## Estrutura
- `src/App.jsx` — todo o app (componente `AchievementShelf`, helpers, modais)
- `src/main.jsx` — monta o React
- `index.html` — template do Vite (fonte e CSS global)
- `backups/` — JSONs de importação PSN (232 jogos) e Steam (231 jogos), usados com "Restaurar backup" (faz merge)

## Arquitetura
- **Supabase** (`https://ixwxxgrwafglumgelapt.supabase.co`) via `fetch` cru em `/rest/v1/games` e `/auth/v1/token`. Sem SDK.
  - Tabela `games` com colunas snake_case (`completed_at`, `gamerscore_earned`, `gamerscore_total`...). `gameToRow` converte do app para a linha.
  - RLS: leitura e escrita só para usuário autenticado.
  - Sessão em `localStorage` (`estante_conquistas_session`), renovada a cada 30 minutos.
- **IGDB** (capas, metadados, screenshots) pela Edge Function `hyper-api` (Deno), que usa credenciais da Twitch. Chamada em `searchIgdb`.
- Imagens passam pelo proxy `images.weserv.nl` (`displayCoverUrl`).
- O plano gratuito do Supabase pausa após ~7 dias sem uso. O workflow `keep-supabase-awake.yml` faz um ping a cada 3 dias (ver abaixo).

## Segurança — importante
- A chave `anon` pode ficar no código do cliente.
- A chave `service_role` **nunca** vai no código. Só existe nos Secrets do GitHub Actions (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`).
- O mesmo projeto Supabase também atende o simulador de pagamento da RPLK (leitura pública, escrita autenticada). Qualquer conta autenticada nesse projeto consegue escrever nos dois apps. Decisão pendente do Lucas: separar projetos ou restringir a RLS por e-mail/papel.

## Modelo de dados
- Jogo: `id, title, platform, status, notes, cover, completedAt, startedAt, createdAt, updatedAt, achievements[], metadata, gamerscoreEarned, gamerscoreTotal`
- Status: `100`, `zerado`, `jogando`, `backlog`, `historico`
- Plataformas: `switch2, xbox360, xboxone, xboxseries, windows, windowsphone, playstation, steam` (a plataforma `xbox` original foi removida). `XBOX_FAMILY_IDS` e `platformFamily` agrupam as plataformas Xbox no filtro.
- Pontos no modelo Xbox: PSN Bronze 15, Prata 30, Ouro 90, Platina 300; Steam 15 por conquista. Cada DLC do Diablo IV soma 250.
- Importação em massa de conquistas: `Nome; Descrição; Pontos; DLC; Desbloqueada` (os 4 últimos campos são opcionais; o último aceita data ISO ou sim/true/x/1).

## Convenções de código
- Estilos inline no JSX, fundo `#15141B`, texto `#EDEAE0`, destaque rosa/coral. Fontes: Space Grotesk, Inter, JetBrains Mono.
- Ícones: `lucide-react`. Se usar um ícone novo, confira se está no import da linha 2 de `src/App.jsx`.
- Textos da interface em português do Brasil.
- Não reintroduza migrações "de uma vez só" que rodam a cada carregamento (já causaram o problema de sobrescrever o status "jogando"). Para mudanças em massa, faça um script ou botão explícito.

## Commits
- Mensagens curtas, em português, no imperativo ("Adiciona botão de marcar como zerado").
