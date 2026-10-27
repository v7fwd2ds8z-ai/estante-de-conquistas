// Edge Function "steam-sync": lê a biblioteca e as conquistas de um perfil da Steam.
// A chave da Steam fica só no secret STEAM_API_KEY do Supabase (nunca no app).
// A função não grava nada no banco: devolve os dados e o app faz o merge e salva
// com a sessão do próprio usuário, então o RLS continua valendo.
//
// Ações (POST com JSON):
//   { action: "owned", profile }            -> { steamid, personaName, games: [...] }
//   { action: "achievements", steamid, appids: [até 20] } -> { apps: [...] }

const STEAM_API = "https://api.steampowered.com";
const MAX_APPIDS_PER_CALL = 20;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const steamGet = async (path: string, params: Record<string, string>) => {
  const url = new URL(`${STEAM_API}/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url);
  // GetPlayerAchievements devolve 400/403 com corpo JSON útil ("no stats", perfil privado),
  // então lemos o corpo mesmo quando não é 2xx.
  let data: any = null;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }
  return { status: res.status, data };
};

// Aceita SteamID64, link /profiles/<id>, link /id/<nome> ou só o nome personalizado.
const resolveSteamId = async (key: string, profile: string) => {
  const raw = profile.trim().replace(/\/+$/, "");
  if (/^\d{17}$/.test(raw)) return raw;
  const byId = raw.match(/\/profiles\/(\d{17})/);
  if (byId) return byId[1];
  const byVanity = raw.match(/\/id\/([^/?#]+)/);
  const vanity = byVanity ? byVanity[1] : raw;
  const { data } = await steamGet("ISteamUser/ResolveVanityURL/v1/", { key, vanityurl: vanity });
  if (data?.response?.success === 1) return data.response.steamid as string;
  return null;
};

const handleOwned = async (key: string, profile: string) => {
  if (!profile) return json({ error: "Informe o link ou o ID do perfil da Steam." }, 400);
  const steamid = await resolveSteamId(key, profile);
  if (!steamid) return json({ error: "Não encontrei esse perfil na Steam. Confira o link." }, 404);

  const [summary, owned] = await Promise.all([
    steamGet("ISteamUser/GetPlayerSummaries/v2/", { key, steamids: steamid }),
    steamGet("IPlayerService/GetOwnedGames/v1/", {
      key,
      steamid,
      include_appinfo: "1",
      include_played_free_games: "1",
      skip_unvetted_apps: "0",
    }),
  ]);

  const player = summary.data?.response?.players?.[0];
  const games = owned.data?.response?.games;
  if (!Array.isArray(games)) {
    // Perfil existe, mas "Detalhes do jogo" não está público: a Steam devolve response vazio.
    return json(
      {
        error:
          "A Steam não mostrou os jogos desse perfil. Em Steam → Perfil → Editar perfil → Privacidade, deixe \"Perfil\" e \"Detalhes do jogo\" como Público.",
      },
      403,
    );
  }

  return json({
    steamid,
    personaName: player?.personaname || "",
    games: games.map((g: any) => ({
      appid: g.appid,
      name: g.name,
      playtimeMinutes: g.playtime_forever || 0,
      lastPlayed: g.rtime_last_played || 0,
      hasStats: !!g.has_community_visible_stats,
    })),
  });
};

const fetchAppAchievements = async (key: string, steamid: string, appid: number) => {
  const [player, schema, global] = await Promise.all([
    steamGet("ISteamUserStats/GetPlayerAchievements/v1/", { key, steamid, appid: String(appid), l: "brazilian" }),
    steamGet("ISteamUserStats/GetSchemaForGame/v2/", { key, appid: String(appid), l: "brazilian" }),
    steamGet("ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/", { gameid: String(appid) }),
  ]);

  const stats = player.data?.playerstats;
  if (!stats?.success) {
    // "Requested app has no stats" = jogo sem conquistas; não é erro de verdade.
    const msg = stats?.error || `HTTP ${player.status}`;
    const noStats = /no stats/i.test(msg);
    return { appid, ok: noStats, achievements: [], error: noStats ? "" : msg };
  }

  const schemaByApi = new Map<string, any>();
  (schema.data?.game?.availableGameStats?.achievements || []).forEach((a: any) => schemaByApi.set(a.name, a));
  const percentByApi = new Map<string, number>();
  (global.data?.achievementpercentages?.achievements || []).forEach((a: any) =>
    percentByApi.set(a.name, Number(a.percent)),
  );

  const achievements = (stats.achievements || []).map((a: any) => {
    const s = schemaByApi.get(a.apiname);
    const percent = percentByApi.get(a.apiname);
    return {
      apiname: a.apiname,
      name: a.name || s?.displayName || a.apiname,
      description: a.description || s?.description || "",
      achieved: a.achieved === 1,
      unlocktime: a.unlocktime || 0,
      icon: s?.icon || "",
      percent: Number.isFinite(percent) ? Math.round((percent as number) * 10) / 10 : null,
    };
  });
  return { appid, ok: true, achievements, error: "" };
};

const handleAchievements = async (key: string, steamid: string, appids: number[]) => {
  if (!/^\d{17}$/.test(steamid || "")) return json({ error: "steamid inválido." }, 400);
  if (!Array.isArray(appids) || appids.length === 0) return json({ apps: [] });
  if (appids.length > MAX_APPIDS_PER_CALL) {
    return json({ error: `Mande no máximo ${MAX_APPIDS_PER_CALL} jogos por chamada.` }, 400);
  }
  const apps = await Promise.all(
    appids.map((appid) =>
      fetchAppAchievements(key, steamid, Number(appid)).catch((e) => ({
        appid,
        ok: false,
        achievements: [],
        error: String(e?.message || e),
      })),
    ),
  );
  return json({ apps });
};

// O "Verify JWT" do Supabase também deixa passar a chave anon (que é pública, está no app).
// Pra só quem está logado gastar a chave da Steam, confere o token no Auth.
const isLoggedUser = async (req: Request) => {
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, {
    headers: { Authorization: auth, apikey: Deno.env.get("SUPABASE_ANON_KEY") || "" },
  });
  return res.ok;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);
  if (!(await isLoggedUser(req))) return json({ error: "Sessão expirada. Entre de novo no app." }, 401);

  const key = Deno.env.get("STEAM_API_KEY");
  if (!key) return json({ error: "STEAM_API_KEY não configurada no Supabase." }, 500);

  let body: any;
  try {
    body = await req.json();
  } catch (_) {
    return json({ error: "Corpo da requisição não é JSON." }, 400);
  }

  try {
    if (body.action === "owned") return await handleOwned(key, String(body.profile || ""));
    if (body.action === "achievements") return await handleAchievements(key, String(body.steamid || ""), body.appids);
    return json({ error: "Ação desconhecida." }, 400);
  } catch (e) {
    return json({ error: `Falha ao falar com a Steam: ${(e as Error).message}` }, 502);
  }
});
