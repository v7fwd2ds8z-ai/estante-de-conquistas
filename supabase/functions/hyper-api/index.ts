// Supabase Edge Function publicada como "hyper-api" (busca de capas e metadados no IGDB).
// Deploy: supabase functions deploy hyper-api
// (ou no Dashboard -> Edge Functions -> hyper-api -> Code, colando este arquivo)
//
// Segredos necessários (Project Settings -> Edge Functions -> Manage secrets):
//   IGDB_CLIENT_ID
//   IGDB_CLIENT_SECRET
//
// Chamada esperada pelo app (POST):
//   { "title": "Hollow Knight", "limit": 10, "offset": 0 }
//   limit (1 a 50, padrão 10) e offset (padrão 0) são opcionais; "Buscar mais" no app
//   pede a página seguinte aumentando o offset.
//
// Resposta:
//   { "matches": [ { "id": 123, "name": "...", "releaseYear": 2017, "cover": "...",
//                     "screenshots": [...], "artwork": "...", "genres": [...],
//                     "developer": "...", "publisher": "...", "rating": 90.1,
//                     "summary": "...", "platforms": [...] } ] }

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const LIMITE_PADRAO = 10;
const LIMITE_MAXIMO = 50;

// Tipos de jogo do IGDB que contam como "o jogo": principal, expansão independente,
// remake, remaster, versão expandida e port. Ficam de fora DLC, bundle, mod, episódio,
// temporada, pack e update, que enchiam a busca de jogos como Batman: Arkham Knight.
const TIPOS_DE_JOGO = "(0,4,8,9,10,11)";

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getTwitchToken(clientId: string, clientSecret: string): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token;
  }
  const res = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
    { method: "POST" }
  );
  if (!res.ok) {
    const errBody = await res.text();
    const debug = {
      clientIdLength: clientId.length,
      clientIdHasWhitespace: clientId !== clientId.trim(),
      clientIdTrimmedLength: clientId.trim().length,
      clientSecretLength: clientSecret.length,
      clientSecretHasWhitespace: clientSecret !== clientSecret.trim(),
      clientSecretTrimmedLength: clientSecret.trim().length,
    };
    throw new Error(`Falha ao autenticar na Twitch (${res.status}): ${errBody} | debug: ${JSON.stringify(debug)}`);
  }
  const data = await res.json();
  cachedToken = { token: data.access_token, expiresAt: now + data.expires_in * 1000 };
  return cachedToken.token;
}

function igdbImageUrl(imageId: string, size = "t_cover_big"): string {
  return `https://images.igdb.com/igdb/image/upload/${size}/${imageId}.jpg`;
}

const inteiroEntre = (valor: unknown, min: number, max: number, padrao: number) => {
  const n = Math.floor(Number(valor));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : padrao;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const clientIdRaw = Deno.env.get("IGDB_CLIENT_ID");
    const clientSecretRaw = Deno.env.get("IGDB_CLIENT_SECRET");
    if (!clientIdRaw || !clientSecretRaw) {
      return new Response(JSON.stringify({ error: "Credenciais do IGDB não configuradas no servidor." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const clientId = clientIdRaw.trim();
    const clientSecret = clientSecretRaw.trim();

    const body = await req.json();
    const title = body?.title;
    if (!title || typeof title !== "string" || !title.trim()) {
      return new Response(JSON.stringify({ error: "Título é obrigatório." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const limit = inteiroEntre(body.limit, 1, LIMITE_MAXIMO, LIMITE_PADRAO);
    const offset = inteiroEntre(body.offset, 0, 5000, 0);

    const token = await getTwitchToken(clientId, clientSecret);
    const headers = {
      "Client-ID": clientId,
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/plain",
    };

    // IGDB usa uma query estilo "Apicalypse", não REST tradicional; traz tudo numa chamada.
    const buscar = async (soJogos: boolean) => {
      const query = `
        search "${title.replace(/"/g, '\\"')}";
        fields name, first_release_date, genres.name, involved_companies.company.name,
          involved_companies.developer, involved_companies.publisher,
          rating, summary, platforms.name, cover.image_id, screenshots.image_id, artworks.image_id;
        ${soJogos ? `where game_type = ${TIPOS_DE_JOGO};` : ""}
        limit ${limit};
        offset ${offset};
      `;
      const res = await fetch("https://api.igdb.com/v4/games", { method: "POST", headers, body: query });
      if (!res.ok) throw new Error(`IGDB retornou erro: ${res.status} ${await res.text()}`);
      return await res.json();
    };

    let games: any[];
    try {
      games = await buscar(true);
      // Nada entre os jogos principais na primeira página: a pessoa pode estar procurando
      // uma DLC de propósito, então devolve a busca sem filtro.
      if ((!games || games.length === 0) && offset === 0) games = await buscar(false);
    } catch (e) {
      return new Response(JSON.stringify({ error: String((e as Error).message || e) }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const matches = (games || []).map((g: any) => {
      const developer = (g.involved_companies || []).find((c: any) => c.developer)?.company?.name || "";
      const publisher = (g.involved_companies || []).find((c: any) => c.publisher)?.company?.name || "";
      return {
        id: g.id,
        name: g.name,
        releaseYear: g.first_release_date ? new Date(g.first_release_date * 1000).getFullYear() : null,
        genres: (g.genres || []).map((x: any) => x.name),
        developer,
        publisher,
        rating: typeof g.rating === "number" ? Math.round(g.rating * 10) / 10 : null,
        summary: g.summary || "",
        platforms: (g.platforms || []).map((x: any) => x.name),
        cover: g.cover?.image_id ? igdbImageUrl(g.cover.image_id, "t_cover_big") : "",
        artwork: g.artworks?.[0]?.image_id ? igdbImageUrl(g.artworks[0].image_id, "t_1080p") : "",
        screenshots: (g.screenshots || []).slice(0, 8).map((s: any) => igdbImageUrl(s.image_id, "t_screenshot_big")),
      };
    });

    return new Response(JSON.stringify({ matches }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
