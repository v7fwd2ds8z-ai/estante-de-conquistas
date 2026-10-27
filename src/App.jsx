import { useState, useEffect, useMemo, useRef } from "react";
import { Trophy, CheckCircle2, Play, Archive, Plus, X, Pencil, Trash2, Search, Gamepad2, ImageUp, FileUp, Download, Images, Upload, Clock, LogOut, Wrench, ChevronDown, ChevronLeft, ChevronRight, Check, RefreshCw } from "lucide-react";

const SUPABASE_URL = "https://ixwxxgrwafglumgelapt.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4d3h4Z3J3YWZnbHVtZ2VsYXB0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc5MDMwMDksImV4cCI6MjEwMzQ3OTAwOX0.zjjE9RnWUvAkBVPqG1_9rCkoKvsVvubd7VjvhSoOixk";
const IGDB_SEARCH_URL = `${SUPABASE_URL}/functions/v1/hyper-api`;

// Cliente Supabase minimalista via fetch puro — não usamos o SDK oficial (@supabase/supabase-js)
// porque o ambiente de artifact só permite importar de uma lista fixa de bibliotecas, e essa
// não está nela. fetch() puro contra a API REST/Auth do Supabase funciona igual, já que o
// Supabase é feito pra ser chamado direto do navegador (diferente do IGDB, que precisa do proxy).

const SESSION_STORAGE_KEY = "estante_conquistas_session";

const saveSessionToStorage = (session) => {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch (e) {
    // localStorage indisponível (modo privado, etc.) — sessão só dura a aba atual
  }
};

const loadSessionFromStorage = () => {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
};

const clearSessionFromStorage = () => {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch (e) {
    // tudo bem
  }
};

const sbAuthLogin = async (email, password) => {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || "Falha no login");
  return { ...data, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
};

const sbAuthRefresh = async (refreshToken) => {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || "Falha ao renovar sessão");
  return { ...data, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
};

const sbFetchGames = async (accessToken) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/games?select=*`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Falha ao carregar jogos (${res.status})`);
  return res.json();
};

const sbUpsertGames = async (accessToken, rows) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/games`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Falha ao salvar jogos (${res.status}): ${errText}`);
  }
};

const sbDeleteGame = async (accessToken, id) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/games?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Falha ao deletar jogo (${res.status})`);
};

const searchIgdb = async (title) => {
  const res = await fetch(IGDB_SEARCH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `Busca no IGDB falhou (${res.status})`);
  return data.matches || [];
};

// Sincronização com a Steam pela Edge Function "steam-sync" (a chave da Steam fica só no
// Supabase). Diferente do IGDB, aqui vai o token da sessão: só quem está logado usa a chave.
const STEAM_SYNC_URL = `${SUPABASE_URL}/functions/v1/steam-sync`;
const STEAM_PROFILE_STORAGE_KEY = "estante_steam_perfil";
const STEAM_LAST_SYNC_STORAGE_KEY = "estante_steam_ultima_sync";
const STEAM_AUTO_SYNC_MS = 12 * 60 * 60 * 1000;
const STEAM_BATCH_SIZE = 20;
const STEAM_POINTS = 15;
const STEAM_RECENT_DAYS = 30;

const callSteamSync = async (accessToken, payload) => {
  const res = await fetch(STEAM_SYNC_URL, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 404 && !data.error) throw new Error("A função steam-sync ainda não foi publicada no Supabase.");
  if (!res.ok || data.error) throw new Error(data.error || data.message || `Sincronização com a Steam falhou (${res.status})`);
  return data;
};

const steamCoverUrl = (appid) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`;

// Data local (YYYY-MM-DD) a partir do unix time da Steam.
const unixToIsoDate = (t) => {
  if (!t) return "";
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const latestDoneAt = (achievements) =>
  achievements.reduce((max, a) => (a.done && a.doneAt && a.doneAt > max ? a.doneAt : max), "");

// Junta as conquistas da Steam com as que o jogo já tem. Casa pelo apiname da Steam e,
// na primeira vez, pelo nome. Como no mergeAchievements, nunca desmarca uma conquista feita
// e mantém nome/descrição/pontos que já tinham sido digitados à mão.
const mergeSteamAchievements = (current, steamList) => {
  const working = [...current];
  let newlyDone = 0;
  steamList.forEach((s, i) => {
    const doneAt = s.achieved ? unixToIsoDate(s.unlocktime) : "";
    let idx = working.findIndex((a) => a.steamApiName === s.apiname);
    if (idx === -1) idx = working.findIndex((a) => !a.steamApiName && normalizeForMatch(a.name) === normalizeForMatch(s.name));
    if (idx !== -1) {
      const a = working[idx];
      if (s.achieved && !a.done) newlyDone++;
      working[idx] = {
        ...a,
        steamApiName: s.apiname,
        name: a.name || s.name,
        description: a.description || s.description,
        points: Number(a.points) || STEAM_POINTS,
        icon: s.icon || a.icon || "",
        rarity: s.percent ?? a.rarity ?? null,
        done: a.done || s.achieved,
        doneAt: a.doneAt || doneAt,
      };
    } else {
      if (s.achieved) newlyDone++;
      working.push({
        id: `a_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
        steamApiName: s.apiname,
        name: s.name,
        description: s.description || "",
        points: STEAM_POINTS,
        dlc: "",
        icon: s.icon || "",
        rarity: s.percent ?? null,
        done: s.achieved,
        doneAt,
      });
    }
  });
  return { achievements: working, newlyDone };
};

// Cruza a biblioteca da Steam com a estante. Um jogo da estante (plataforma Steam) casa
// pelo appid já vinculado ou, na primeira vez, pelo título. Jogos da Steam que não estão na
// estante só entram se já foram jogados. Só busca conquistas de quem tem estatísticas na
// Steam e foi jogado desde a última sincronização (ou nunca foi sincronizado).
const planSteamSync = (games, owned) => {
  const steamGames = games.filter((g) => g.platform === "steam");
  const byAppid = new Map();
  steamGames.forEach((g) => {
    if (g.metadata?.steam?.appid) byAppid.set(g.metadata.steam.appid, g);
  });
  const usedIds = new Set();
  const items = [];
  owned.forEach((o) => {
    let match = byAppid.get(o.appid);
    if (!match) {
      const norm = normalizeForMatch(o.name);
      match = steamGames.find((g) => !usedIds.has(g.id) && !g.metadata?.steam?.appid && normalizeForMatch(g.title) === norm);
    }
    if (match) usedIds.add(match.id);
    if (!match && o.playtimeMinutes === 0) return;
    const syncedAt = match?.metadata?.steam?.syncedAt || 0;
    const needsAchievements = o.hasStats && (!syncedAt || o.lastPlayed * 1000 > syncedAt);
    items.push({ owned: o, match: match || null, needsAchievements });
  });
  return {
    items,
    matchedCount: items.filter((i) => i.match).length,
    newCount: items.filter((i) => !i.match).length,
  };
};

// Monta os jogos a salvar. Status de jogo existente só muda para "100" quando todas as
// conquistas estão feitas; qualquer outro status escolhido à mão fica como está.
const applySteamSync = (plan, achievementsByAppid, { addNew, now }) => {
  const toSave = [];
  let added = 0;
  let updated = 0;
  let newlyDone = 0;
  plan.items.forEach(({ owned, match }) => {
    if (!match && !addNew) return;
    const steamList = achievementsByAppid.get(owned.appid);
    const base = match || {
      id: `steam_${owned.appid}`,
      title: owned.name,
      platform: "steam",
      status: "historico",
      notes: "",
      cover: steamCoverUrl(owned.appid),
      completedAt: "",
      startedAt: "",
      achievements: [],
      metadata: null,
      createdAt: now,
    };
    const merged = steamList ? mergeSteamAchievements(base.achievements || [], steamList) : { achievements: base.achievements || [], newlyDone: 0 };
    const achievements = merged.achievements;
    const allDone = achievements.length > 0 && achievements.every((a) => a.done);

    let status = base.status;
    let completedAt = base.completedAt;
    if (allDone && status !== "100") {
      status = "100";
      completedAt = completedAt || latestDoneAt(achievements);
    } else if (!match) {
      const recent = owned.lastPlayed && now - owned.lastPlayed * 1000 < STEAM_RECENT_DAYS * 24 * 60 * 60 * 1000;
      status = recent ? "jogando" : "historico";
    }

    const prevSteam = base.metadata?.steam;
    const steam = {
      appid: owned.appid,
      playtimeMinutes: owned.playtimeMinutes,
      lastPlayed: owned.lastPlayed,
      syncedAt: steamList ? now : prevSteam?.syncedAt || 0,
    };
    const changed =
      !match ||
      merged.newlyDone > 0 ||
      achievements.length !== (base.achievements || []).length ||
      JSON.stringify(achievements) !== JSON.stringify(base.achievements || []) ||
      status !== base.status ||
      !prevSteam ||
      prevSteam.playtimeMinutes !== steam.playtimeMinutes ||
      prevSteam.syncedAt !== steam.syncedAt;
    if (!changed) return;

    toSave.push({ ...base, status, completedAt, achievements, metadata: { ...(base.metadata || {}), steam }, updatedAt: now });
    newlyDone += merged.newlyDone;
    if (match) updated++;
    else added++;
  });
  return { toSave, added, updated, newlyDone };
};

// Converte uma linha do banco (snake_case) pro formato que o resto do app já usa (camelCase)
const rowToGame = (row) => ({
  id: row.id,
  title: row.title,
  platform: row.platform,
  status: row.status,
  notes: row.notes || "",
  cover: row.cover || "",
  completedAt: row.completed_at || "",
  startedAt: row.started_at || "",
  gamerscoreEarned: row.gamerscore_earned ?? undefined,
  gamerscoreTotal: row.gamerscore_total ?? undefined,
  achievements: row.achievements || [],
  metadata: row.metadata || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// Converte do formato do app (camelCase) pra linha do banco (snake_case)
const gameToRow = (g) => ({
  id: g.id,
  title: g.title,
  platform: g.platform,
  status: g.status,
  notes: g.notes || "",
  cover: g.cover || "",
  completed_at: g.completedAt || "",
  started_at: g.startedAt || "",
  gamerscore_earned: Number.isFinite(g.gamerscoreEarned) ? g.gamerscoreEarned : null,
  gamerscore_total: Number.isFinite(g.gamerscoreTotal) ? g.gamerscoreTotal : null,
  achievements: g.achievements || [],
  metadata: g.metadata || null,
  created_at: g.createdAt || Date.now(),
  updated_at: g.updatedAt || Date.now(),
});

const PLATFORMS = [
  { id: "switch2", label: "Switch 2", color: "#E4536B" },
  { id: "xbox360", label: "Xbox 360", color: "#7BC47F" },
  { id: "xboxone", label: "Xbox One", color: "#3FA34D" },
  { id: "xboxseries", label: "Xbox Series", color: "#107C10" },
  { id: "windows", label: "Windows", color: "#00A4EF" },
  { id: "windowsphone", label: "Windows Phone", color: "#68217A" },
  { id: "playstation", label: "PlayStation", color: "#4A8FD9" },
  { id: "steam", label: "Steam / PC", color: "#9098A8" },
];

const STATUSES = [
  { id: "100", label: "100%", color: "#D7FF3A", Icon: Trophy },
  { id: "zerado", label: "Zerado", color: "#F2F2EE", Icon: CheckCircle2 },
  { id: "jogando", label: "Jogando", color: "#7FD4FF", Icon: Play },
  { id: "backlog", label: "Backlog", color: "#5A5A60", Icon: Archive },
  { id: "historico", label: "Histórico", color: "#8A8A90", Icon: Clock },
];

const platformOf = (id) => PLATFORMS.find((p) => p.id === id) || PLATFORMS[0];
const statusOf = (id) => STATUSES.find((s) => s.id === id) || STATUSES[3];

// Pra filtro e resumo de pontuação, todas as variantes de Xbox (e Windows/Windows Phone,
// que também contam gamerscore) são agrupadas sob um único "Xbox". Nos cards e detalhe
// de cada jogo, a plataforma específica continua aparecendo normalmente.
const XBOX_FAMILY_IDS = ["xbox", "xbox360", "xboxone", "xboxseries", "windows", "windowsphone"];
const platformFamily = (id) => (XBOX_FAMILY_IDS.includes(id) ? "xbox" : id);
const FILTER_PLATFORMS = [
  { id: "switch2", label: "Switch 2", color: "#E4536B" },
  { id: "xbox", label: "Xbox", color: "#107C10" },
  { id: "playstation", label: "PlayStation", color: "#4A8FD9" },
  { id: "steam", label: "Steam / PC", color: "#9098A8" },
];

// Pontuação de um jogo: usa a lista detalhada de conquistas quando existe;
// senão cai pro gamerscore agregado (comum em jogos importados em massa do Xbox).
const gamePoints = (game) => {
  const achievements = game.achievements || [];
  if (achievements.length > 0) {
    const total = achievements.reduce((s, a) => s + (Number(a.points) || 0), 0);
    const earned = achievements.filter((a) => a.done).reduce((s, a) => s + (Number(a.points) || 0), 0);
    return { earned, total, detailed: true };
  }
  if (Number.isFinite(game.gamerscoreTotal)) {
    return { earned: Number(game.gamerscoreEarned) || 0, total: Number(game.gamerscoreTotal) || 0, detailed: false };
  }
  return { earned: 0, total: 0, detailed: false };
};

// Percentual de conquistas de um jogo (pelos pontos); null quando o jogo não tem conquistas.
const gamePct = (game) => {
  const { earned, total } = gamePoints(game);
  return total > 0 ? Math.floor((earned / total) * 100) : null;
};

const emptyForm = { title: "", platform: "switch2", status: "jogando", notes: "", cover: "", completedAt: "", startedAt: "" };

const isCompletedStatus = (status) => status === "100" || status === "zerado";
const hasStarted = (status) => status !== "backlog";

const formatDate = (isoDate) => {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
};

// Alguns CDNs de capa (ex: images.igdb.com) bloqueiam carregamento vindo de domínios
// desconhecidos (hotlink protection). Pra links http(s) normais, passamos por um proxy
// público de imagens que busca a imagem no servidor de origem e devolve pra gente —
// não é garantido pra todo CDN, mas resolve a maioria dos casos comuns.
const displayCoverUrl = (cover) => {
  if (!cover || typeof cover !== "string") return cover;
  if (!cover.startsWith("http")) return cover; // data:, blob:, vazio etc — usa direto
  const stripped = cover.replace(/^https:\/\//, "ssl:").replace(/^http:\/\//, "");
  return `https://images.weserv.nl/?url=${stripped}`;
};

const normalizeForMatch = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9]+/g, "");

const guessGameMatch = (filename, gamesList) => {
  const norm = normalizeForMatch(filename);
  if (!norm) return null;
  let best = null;
  let bestScore = 0;
  gamesList.forEach((g) => {
    const titleNorm = normalizeForMatch(g.title);
    if (!titleNorm) return;
    let score = 0;
    if (norm.includes(titleNorm) || titleNorm.includes(norm)) {
      score = Math.min(norm.length, titleNorm.length) / Math.max(norm.length, titleNorm.length);
    }
    if (score > bestScore) {
      bestScore = score;
      best = g;
    }
  });
  return bestScore >= 0.4 ? best : null;
};

const identifyGameByImage = async (dataUrl, titles) => {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(dataUrl);
  if (!match || titles.length === 0) return null;
  const [, mediaType, base64Data] = match;
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 200,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
              {
                type: "text",
                text: `Esta imagem é a arte de capa de um videogame. Qual destes títulos corresponde exatamente a essa capa? Responda APENAS com o título exato, copiado literalmente da lista abaixo, sem nenhum texto adicional. Se nenhum título bater com confiança, responda apenas: NENHUM\n\nLista de títulos:\n${titles.join("\n")}`,
              },
            ],
          },
        ],
      }),
    });
    const data = await response.json();
    const text = (data.content || []).map((b) => b.text || "").join("").trim();
    return text || null;
  } catch (e) {
    return null;
  }
};

const mergeAchievements = (current, parsedList) => {
  const working = [...current];
  parsedList.forEach((p, i) => {
    const idx = working.findIndex((a) => normalizeForMatch(a.name) === normalizeForMatch(p.name));
    if (idx !== -1) {
      working[idx] = {
        ...working[idx],
        description: p.description || working[idx].description,
        points: p.points || working[idx].points,
        dlc: p.dlc || working[idx].dlc || "",
        // Só "destranca" a conquista se o import disser que ela foi feita — nunca destranca
        // de volta pra "não feita" uma que já estava marcada como concluída.
        done: working[idx].done || !!p.done,
        doneAt: working[idx].doneAt || (p.done ? p.doneAt || "" : ""),
      };
    } else {
      working.push({
        id: `a_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
        name: p.name,
        description: p.description || "",
        points: Number(p.points) || 0,
        dlc: p.dlc || "",
        done: !!p.done,
        doneAt: p.done ? p.doneAt || "" : "",
      });
    }
  });
  return working;
};

const resizeImageFile = (file, maxDim = 420, quality = 0.78) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Falha ao ler o arquivo"));
    reader.onload = (ev) => {
      const img = new Image();
      img.onerror = () => reject(new Error("Falha ao carregar a imagem"));
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) {
          height = Math.round(height * (maxDim / width));
          width = maxDim;
        } else if (height >= width && height > maxDim) {
          width = Math.round(width * (maxDim / height));
          height = maxDim;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });

const matchPlatform = (raw) => {
  const s = (raw || "").toLowerCase();
  if (s.includes("switch")) return "switch2";
  if (s.includes("xbox")) return "xboxseries";
  if (s.includes("play") || s === "ps" || s.includes("ps4") || s.includes("ps5")) return "playstation";
  if (s.includes("steam") || s.includes("pc")) return "steam";
  return null;
};

const matchStatus = (raw) => {
  const s = (raw || "").toLowerCase();
  if (s.includes("100") || s.includes("platin")) return "100";
  if (s.includes("zerad") || s.includes("complet") || s.includes("finaliz")) return "zerado";
  if (s.includes("jog") || s.includes("andamento")) return "jogando";
  if (s.includes("backlog") || s.includes("pend")) return "backlog";
  return null;
};

const parseBulkText = (text) => {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const parsed = [];
  const errors = [];
  lines.forEach((line, idx) => {
    const parts = line.split(";").map((p) => p.trim());
    const title = parts[0];
    if (!title) {
      errors.push(`Linha ${idx + 1}: sem título, ignorada.`);
      return;
    }
    const platform = matchPlatform(parts[1]);
    const status = matchStatus(parts[2]);
    const completedAt = parts[3] && /^\d{4}-\d{2}-\d{2}$/.test(parts[3]) ? parts[3] : "";
    const notes = parts[4] || "";
    const cover = parts[5] || "";
    parsed.push({ title, platform, status, completedAt, notes, cover });
  });
  return { parsed, errors };
};

export default function AchievementShelf() {
  const [session, setSession] = useState(() => loadSessionFromStorage());
  const [sessionChecking, setSessionChecking] = useState(true);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saveWarning, setSaveWarning] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState("");
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverDragging, setCoverDragging] = useState(false);
  const [coverSearchBusy, setCoverSearchBusy] = useState(false);
  const [coverCandidates, setCoverCandidates] = useState([]);
  const [coverSearchError, setCoverSearchError] = useState("");
  const [showCoverBatch, setShowCoverBatch] = useState(false);
  const [coverQueue, setCoverQueue] = useState([]);
  const [batchDragging, setBatchDragging] = useState(false);
  const [batchApplying, setBatchApplying] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkResult, setBulkResult] = useState(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreResult, setRestoreResult] = useState(null);
  const [detailGameId, setDetailGameId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [achText, setAchText] = useState("");
  const [achError, setAchError] = useState("");
  const [filterPlatform, setFilterPlatform] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [showToolsMenu, setShowToolsMenu] = useState(false);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("recentes"); // recentes | progresso | nome
  const [showAutoCover, setShowAutoCover] = useState(false);
  const [autoCoverBusy, setAutoCoverBusy] = useState(false);
  const [autoCoverDone, setAutoCoverDone] = useState(false);
  const [autoCoverProgress, setAutoCoverProgress] = useState({ current: 0, total: 0, found: 0, notFound: 0 });
  const [showSteam, setShowSteam] = useState(false);
  const [steamProfile, setSteamProfile] = useState(() => {
    try {
      return localStorage.getItem(STEAM_PROFILE_STORAGE_KEY) || "";
    } catch (e) {
      return "";
    }
  });
  const [steamStage, setSteamStage] = useState("idle"); // idle | lendo | previa | sincronizando | pronto
  const [steamOwned, setSteamOwned] = useState(null);
  const [steamAddNew, setSteamAddNew] = useState(true);
  const [steamProgress, setSteamProgress] = useState({ current: 0, total: 0 });
  const [steamResult, setSteamResult] = useState(null);
  const [steamError, setSteamError] = useState("");
  const [steamNotice, setSteamNotice] = useState(null);
  const steamAutoRanRef = useRef(false);

  // Ao abrir a página, confere se a sessão salva ainda é válida (ou renova ela)
  // antes de decidir se mostra a tela de login ou já entra direto.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = loadSessionFromStorage();
      if (!saved) {
        if (!cancelled) setSessionChecking(false);
        return;
      }
      const stillValid = saved.expiresAt && saved.expiresAt - Date.now() > 60_000;
      if (stillValid) {
        if (!cancelled) {
          setSession(saved);
          setSessionChecking(false);
        }
        return;
      }
      try {
        const refreshed = await sbAuthRefresh(saved.refresh_token);
        saveSessionToStorage(refreshed);
        if (!cancelled) setSession(refreshed);
      } catch (e) {
        clearSessionFromStorage();
        if (!cancelled) setSession(null);
      } finally {
        if (!cancelled) setSessionChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Renovação proativa enquanto a aba fica aberta, pra sessão não expirar no meio do uso.
  useEffect(() => {
    if (!session) return;
    const interval = setInterval(async () => {
      try {
        const refreshed = await sbAuthRefresh(session.refresh_token);
        saveSessionToStorage(refreshed);
        setSession(refreshed);
      } catch (e) {
        // se falhar, a próxima chamada à API vai voltar 401 e o usuário loga de novo
      }
    }, 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, [session]);

  useEffect(() => {
    if (sessionChecking || !session) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const rows = await sbFetchGames(session.access_token);
        const loaded = rows.map(rowToGame).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        if (!cancelled) {
          setGames(loaded);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setSaveWarning(true);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, sessionChecking]);

  const saveGames = async (gamesToSave) => {
    // Junta sobre o estado mais recente (e não sobre o `games` deste render), porque a
    // sincronização da Steam salva depois de vários segundos e o usuário pode ter mexido em algo.
    const mergeInto = (prev) => {
      const map = new Map(prev.map((g) => [g.id, g]));
      gamesToSave.forEach((g) => map.set(g.id, g));
      return Array.from(map.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    };

    let ok = true;
    try {
      // Em lotes, pra uma sincronização grande (centenas de jogos com conquistas) não
      // virar uma requisição gigante só.
      const rows = gamesToSave.map(gameToRow);
      for (let i = 0; i < rows.length; i += 50) {
        await sbUpsertGames(session.access_token, rows.slice(i, i + 50));
      }
    } catch (e) {
      console.error("Falha ao salvar no Supabase", e);
      ok = false;
    }

    setGames(mergeInto);
    setSaveWarning(!ok);
    return ok;
  };

  // Busca automática de capa/metadata no IGDB pra jogos que ainda não têm capa —
  // aplica direto a primeira opção retornada pra cada um, sem precisar escolher
  // manualmente jogo por jogo. Processa em sequência (não em paralelo) pra não
  // sobrecarregar a Edge Function/Twitch de uma vez, e salva tudo num upsert só no final.
  const runAutoCoverSearch = async () => {
    const targets = games.filter((g) => !g.cover);
    if (targets.length === 0) return;

    setAutoCoverBusy(true);
    setAutoCoverDone(false);
    setAutoCoverProgress({ current: 0, total: targets.length, found: 0, notFound: 0 });

    const updated = [];
    for (let i = 0; i < targets.length; i++) {
      const g = targets[i];
      try {
        const matches = await searchIgdb(g.title);
        if (matches.length > 0) {
          const match = matches[0];
          updated.push({
            ...g,
            cover: match.cover || g.cover,
            metadata: {
              source: "IGDB",
              sourceUrl: `https://www.igdb.com/games/${match.id}`,
              releaseYear: match.releaseYear,
              genres: match.genres,
              developer: match.developer,
              publisher: match.publisher,
              summary: match.summary,
              rating: match.rating,
              platforms: match.platforms,
              screenshots: match.screenshots,
              artwork: match.artwork,
              steam: g.metadata?.steam,
            },
            updatedAt: Date.now(),
          });
          setAutoCoverProgress((p) => ({ ...p, current: i + 1, found: p.found + 1 }));
        } else {
          setAutoCoverProgress((p) => ({ ...p, current: i + 1, notFound: p.notFound + 1 }));
        }
      } catch (e) {
        setAutoCoverProgress((p) => ({ ...p, current: i + 1, notFound: p.notFound + 1 }));
      }
    }

    if (updated.length > 0) {
      await saveGames(updated);
    }
    setAutoCoverBusy(false);
    setAutoCoverDone(true);
  };

  const closeAutoCover = () => {
    if (autoCoverBusy) return; // não deixa fechar no meio do processamento
    setShowAutoCover(false);
    setAutoCoverDone(false);
    setAutoCoverProgress({ current: 0, total: 0, found: 0, notFound: 0 });
  };

  // Busca as conquistas da Steam em lotes e salva o resultado. Usada pelo modal e pela
  // sincronização automática. Lote que falha não derruba o resto: esses jogos ficam sem
  // syncedAt novo e entram de novo na próxima sincronização.
  const syncSteamAchievements = async (owned, { addNew, onProgress }) => {
    const plan = planSteamSync(games, owned.games);
    const targets = plan.items.filter((i) => i.needsAchievements && (i.match || addNew)).map((i) => i.owned.appid);
    const byAppid = new Map();
    let failed = 0;
    if (onProgress) onProgress(0, targets.length);
    for (let i = 0; i < targets.length; i += STEAM_BATCH_SIZE) {
      const batch = targets.slice(i, i + STEAM_BATCH_SIZE);
      try {
        const data = await callSteamSync(session.access_token, { action: "achievements", steamid: owned.steamid, appids: batch });
        (data.apps || []).forEach((app) => {
          if (app.ok) byAppid.set(app.appid, app.achievements);
          else failed++;
        });
      } catch (e) {
        failed += batch.length;
      }
      if (onProgress) onProgress(Math.min(i + batch.length, targets.length), targets.length);
    }
    const result = applySteamSync(plan, byAppid, { addNew, now: Date.now() });
    const ok = result.toSave.length > 0 ? await saveGames(result.toSave) : true;
    try {
      localStorage.setItem(STEAM_LAST_SYNC_STORAGE_KEY, String(Date.now()));
    } catch (e) {
      // sem localStorage a sincronização automática só roda de novo na próxima abertura
    }
    return { added: result.added, updated: result.updated, newlyDone: result.newlyDone, failed, ok };
  };

  const openSteam = () => {
    setSteamStage("idle");
    setSteamOwned(null);
    setSteamResult(null);
    setSteamError("");
    setShowSteam(true);
  };

  const closeSteam = () => {
    if (steamStage === "lendo" || steamStage === "sincronizando") return; // não deixa fechar no meio
    setShowSteam(false);
  };

  const readSteamLibrary = async () => {
    const profile = steamProfile.trim();
    if (!profile) {
      setSteamError("Cole o link do seu perfil da Steam.");
      return;
    }
    setSteamStage("lendo");
    setSteamError("");
    try {
      const owned = await callSteamSync(session.access_token, { action: "owned", profile });
      try {
        localStorage.setItem(STEAM_PROFILE_STORAGE_KEY, profile);
      } catch (e) {
        // tudo bem, só não lembra o perfil na próxima vez
      }
      setSteamOwned(owned);
      setSteamStage("previa");
    } catch (e) {
      setSteamError(e.message);
      setSteamStage("idle");
    }
  };

  const runSteamSync = async () => {
    setSteamStage("sincronizando");
    const result = await syncSteamAchievements(steamOwned, {
      addNew: steamAddNew,
      onProgress: (current, total) => setSteamProgress({ current, total }),
    });
    setSteamResult(result);
    setSteamStage("pronto");
  };

  // Sincronização automática ao abrir o app: só se já existe um perfil salvo e a última
  // foi há mais de 12h. Atualiza só jogos que já estão na estante (não adiciona novos).
  useEffect(() => {
    if (loading || !session || steamAutoRanRef.current) return;
    steamAutoRanRef.current = true;
    let profile = "";
    let last = 0;
    try {
      profile = localStorage.getItem(STEAM_PROFILE_STORAGE_KEY) || "";
      last = Number(localStorage.getItem(STEAM_LAST_SYNC_STORAGE_KEY)) || 0;
    } catch (e) {
      return;
    }
    if (!profile || Date.now() - last < STEAM_AUTO_SYNC_MS) return;
    (async () => {
      try {
        const owned = await callSteamSync(session.access_token, { action: "owned", profile });
        const result = await syncSteamAchievements(owned, { addNew: false });
        if (result.newlyDone > 0) setSteamNotice(result);
      } catch (e) {
        setSteamNotice({ error: e.message });
      }
    })();
  }, [loading, session]);

  const retrySaveIndex = async () => {
    let ok = true;
    try {
      await sbUpsertGames(session.access_token, games.map(gameToRow));
    } catch (e) {
      ok = false;
    }
    setSaveWarning(!ok);
  };

  const deleteGameStorage = async (id) => {
    const next = games.filter((g) => g.id !== id);
    let ok = true;
    try {
      await sbDeleteGame(session.access_token, id);
    } catch (e) {
      ok = false;
    }
    setGames(next);
    setSaveWarning(!ok);
  };

  const processCoverFile = async (file) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setFormError("Escolhe um arquivo de imagem (jpg, png, etc).");
      return;
    }
    setCoverBusy(true);
    setFormError("");
    try {
      const dataUrl = await resizeImageFile(file);
      setForm((f) => ({ ...f, cover: dataUrl }));
    } catch (err) {
      setFormError("Não consegui processar essa imagem. Tenta outra.");
    } finally {
      setCoverBusy(false);
    }
  };

  const handleCoverFile = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    processCoverFile(file);
  };

  const handleCoverDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setCoverDragging(false);
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    processCoverFile(file);
  };

  const handleSearchCovers = async () => {
    if (!form.title.trim()) {
      setCoverSearchError("Preenche o título do jogo antes de buscar a capa.");
      return;
    }
    setCoverSearchBusy(true);
    setCoverSearchError("");
    setCoverCandidates([]);
    try {
      const matches = await searchIgdb(form.title.trim());
      if (matches.length === 0) {
        setCoverSearchError("Não encontrei esse jogo no IGDB. Tenta colar o link manualmente ou fazer upload.");
      } else {
        setCoverCandidates(matches);
      }
    } catch (e) {
      setCoverSearchError("Não consegui buscar no IGDB agora. Tenta de novo em instantes.");
    } finally {
      setCoverSearchBusy(false);
    }
  };

  const pickIgdbMatch = (match) => {
    setForm((f) => ({
      ...f,
      cover: match.cover || f.cover,
      metadata: {
        source: "IGDB",
        sourceUrl: `https://www.igdb.com/games/${match.id}`,
        releaseYear: match.releaseYear,
        genres: match.genres,
        developer: match.developer,
        publisher: match.publisher,
        summary: match.summary,
        rating: match.rating,
        platforms: match.platforms,
        screenshots: match.screenshots,
        artwork: match.artwork,
      },
    }));
    setCoverCandidates([]);
    setCoverSearchError("");
  };

  const addFilesToBatchQueue = async (fileList) => {
    const files = Array.from(fileList || []).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    const withThumbs = await Promise.all(
      files.map(async (file) => {
        let dataUrl = "";
        try {
          dataUrl = await resizeImageFile(file);
        } catch (e) {
          dataUrl = "";
        }
        const suggested = guessGameMatch(file.name, games);
        return {
          tempId: `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          filename: file.name,
          dataUrl,
          selectedGameId: suggested ? suggested.id : "",
          visionPending: !suggested && !!dataUrl,
        };
      })
    );
    const valid = withThumbs.filter((w) => w.dataUrl);
    setCoverQueue((prev) => [...prev, ...valid]);

    // For items the filename couldn't resolve, ask the vision model to identify the cover.
    const titles = games.map((g) => g.title);
    valid
      .filter((item) => item.visionPending)
      .forEach((item) => {
        identifyGameByImage(item.dataUrl, titles).then((titleGuess) => {
          const matched =
            titleGuess && titleGuess.trim().toUpperCase() !== "NENHUM"
              ? games.find((g) => g.title.trim().toLowerCase() === titleGuess.trim().toLowerCase())
              : null;
          setCoverQueue((prev) =>
            prev.map((q) =>
              q.tempId === item.tempId
                ? { ...q, visionPending: false, selectedGameId: !q.selectedGameId && matched ? matched.id : q.selectedGameId }
                : q
            )
          );
        });
      });
  };

  const handleBatchDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setBatchDragging(false);
    addFilesToBatchQueue(e.dataTransfer.files);
  };

  const handleBatchFilePick = (e) => {
    addFilesToBatchQueue(e.target.files);
    e.target.value = "";
  };

  const setQueueItemGame = (tempId, gameId) => {
    setCoverQueue((prev) => prev.map((q) => (q.tempId === tempId ? { ...q, selectedGameId: gameId } : q)));
  };

  const removeQueueItem = (tempId) => {
    setCoverQueue((prev) => prev.filter((q) => q.tempId !== tempId));
  };

  const applyCoverBatch = async () => {
    const assigned = coverQueue.filter((q) => q.selectedGameId);
    if (assigned.length === 0) return;
    setBatchApplying(true);
    const updatedGames = assigned.map((q) => {
      const game = games.find((g) => g.id === q.selectedGameId);
      return { ...game, cover: q.dataUrl };
    });
    await saveGames(updatedGames);
    setBatchApplying(false);
    setCoverQueue((prev) => prev.filter((q) => !q.selectedGameId));
  };

  const closeCoverBatch = () => {
    setShowCoverBatch(false);
    setCoverQueue([]);
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginBusy(true);
    setLoginError("");
    try {
      const data = await sbAuthLogin(loginEmail.trim(), loginPassword);
      saveSessionToStorage(data);
      setSession(data);
      setLoginPassword("");
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error("Login falhou:", err);
      if (msg === "Invalid login credentials") {
        setLoginError("Email ou senha incorretos.");
      } else if (/failed to fetch|networkerror|load failed/i.test(msg)) {
        setLoginError("Erro de rede ao tentar falar com o Supabase. Confere sua conexão e tenta de novo.");
      } else {
        setLoginError(`Erro: ${msg}`);
      }
    } finally {
      setLoginBusy(false);
    }
  };

  const handleLogout = () => {
    clearSessionFromStorage();
    setSession(null);
    setGames([]);
    setLoginEmail("");
    setLoginPassword("");
  };

  const exportData = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      source: "Estante de Conquistas",
      games,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const dateStr = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `estante-de-conquistas-backup-${dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleRestoreFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    setRestoreBusy(true);
    setRestoreResult(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const gamesToImport = Array.isArray(parsed) ? parsed : parsed.games;
      if (!Array.isArray(gamesToImport) || gamesToImport.length === 0) {
        setRestoreResult({ error: "Esse arquivo não parece um backup válido (esperava uma lista de jogos)." });
        setRestoreBusy(false);
        return;
      }
      const now = Date.now();
      const sanitized = gamesToImport.map((g, i) => ({
        id: g.id || `g_${now}_${i}_${Math.random().toString(36).slice(2, 7)}`,
        title: g.title || "Sem título",
        platform: g.platform || "switch2",
        status: g.status || "backlog",
        notes: g.notes || "",
        cover: g.cover || "",
        completedAt: g.completedAt || "",
        startedAt: g.startedAt || "",
        createdAt: g.createdAt || now,
        updatedAt: g.updatedAt || now,
        achievements: Array.isArray(g.achievements) ? g.achievements : [],
        metadata: g.metadata && typeof g.metadata === "object" ? g.metadata : null,
        gamerscoreEarned: Number.isFinite(g.gamerscoreEarned) ? g.gamerscoreEarned : undefined,
        gamerscoreTotal: Number.isFinite(g.gamerscoreTotal) ? g.gamerscoreTotal : undefined,
      }));
      const ok = await saveGames(sanitized);
      setRestoreResult({ count: sanitized.length, ok });
    } catch (err) {
      setRestoreResult({ error: "Não consegui ler esse arquivo. Confere se é o JSON exportado pelo próprio app." });
    } finally {
      setRestoreBusy(false);
    }
  };

  const openAdd = () => {
    setForm(emptyForm);
    setEditingId(null);
    setFormError("");
    setCoverCandidates([]);
    setCoverSearchError("");
    setShowForm(true);
  };

  const openEdit = (game) => {
    setForm({ title: game.title, platform: game.platform, status: game.status, notes: game.notes || "", cover: game.cover || "", completedAt: game.completedAt || "", startedAt: game.startedAt || "" });
    setEditingId(game.id);
    setFormError("");
    setCoverCandidates([]);
    setCoverSearchError("");
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
    setForm(emptyForm);
    setFormError("");
    setCoverCandidates([]);
    setCoverSearchError("");
  };

  const submitForm = () => {
    if (!form.title.trim()) {
      setFormError("Dá um nome pro jogo antes de salvar.");
      return;
    }
    if (editingId) {
      const existing = games.find((g) => g.id === editingId);
      const updated = { ...existing, ...form, title: form.title.trim(), updatedAt: Date.now() };
      // Trocar a capa pelo IGDB substitui o metadata inteiro; o vínculo com a Steam continua.
      if (form.metadata && existing.metadata?.steam) updated.metadata = { ...form.metadata, steam: existing.metadata.steam };
      saveGames([updated]);
    } else {
      const newGame = {
        id: `g_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        ...form,
        title: form.title.trim(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      saveGames([newGame]);
    }
    closeForm();
  };

  // Guarda sempre a versão mais recente de submitForm, pra o atalho de teclado
  // abaixo nunca chamar uma versão "velha" presa num closure antigo.
  const submitFormRef = useRef(submitForm);
  submitFormRef.current = submitForm;

  // Atalho de Enter que funciona mesmo se o foco do teclado se perder (ex: depois
  // de clicar numa opção do IGDB, o botão clicado some e o foco vai pro <body>,
  // fora do <form> — nesse caso o Enter nativo do formulário não dispara nada).
  useEffect(() => {
    if (!showForm) return;
    const handleKeyDown = (e) => {
      if (e.key !== "Enter") return;
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return;
      e.preventDefault();
      submitFormRef.current();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [showForm]);

  const removeGame = (id) => {
    if (confirmDeleteId === id) {
      deleteGameStorage(id);
      setConfirmDeleteId(null);
    } else {
      setConfirmDeleteId(id);
      setTimeout(() => {
        setConfirmDeleteId((cur) => (cur === id ? null : cur));
      }, 3000);
    }
  };

  // Atalho rápido pra mover um jogo direto pra "Zerado" sem abrir a edição — pensado pro
  // fluxo de ir tirando jogos do Histórico conforme são zerados de fato. Preenche a data
  // de conclusão com hoje só se ainda não tiver uma.
  const markAsZerado = (game) => {
    const todayIso = new Date().toISOString().slice(0, 10);
    saveGames([{ ...game, status: "zerado", completedAt: game.completedAt || todayIso, updatedAt: Date.now() }]);
  };

  const runBulkImport = () => {
    const { parsed, errors } = parseBulkText(bulkText);
    if (parsed.length === 0) {
      setBulkResult({ added: 0, updated: 0, errors: errors.length ? errors : ["Nenhuma linha reconhecida."] });
      return;
    }
    const now = Date.now();
    const norm = (s) => normalizeForMatch(s);
    const working = [...games];
    const changed = [];
    let addedCount = 0;
    let updatedCount = 0;
    parsed.forEach((p) => {
      const existingIdx = working.findIndex((g) => norm(g.title) === norm(p.title));
      if (existingIdx !== -1) {
        const existing = working[existingIdx];
        const updated = {
          ...existing,
          status: p.status || existing.status,
          platform: p.platform || existing.platform,
          completedAt: p.completedAt || existing.completedAt,
          notes: p.notes || existing.notes,
          cover: p.cover || existing.cover,
          updatedAt: now,
        };
        working[existingIdx] = updated;
        changed.push(updated);
        updatedCount++;
      } else {
        const created = {
          id: `g_${now}_${Math.random().toString(36).slice(2, 6)}`,
          title: p.title,
          platform: p.platform || "switch2",
          status: p.status || "zerado",
          completedAt: p.completedAt,
          notes: p.notes,
          cover: p.cover,
          createdAt: now,
          updatedAt: now,
        };
        working.unshift(created);
        changed.push(created);
        addedCount++;
      }
    });
    saveGames(changed);
    setBulkResult({ added: addedCount, updated: updatedCount, errors });
    setBulkText("");
  };

  const closeBulk = () => {
    setShowBulk(false);
    setBulkText("");
    setBulkResult(null);
  };

  const openDetail = (id) => {
    setDetailGameId(id);
    setAchText("");
    setAchError("");
  };

  const closeDetail = () => {
    setDetailGameId(null);
    setAchText("");
    setAchError("");
  };

  // Atalho global de ESC: fecha o modal/janela aberta no momento. Prioridade:
  // formulário de novo/editar jogo (abre por cima do detalhe) > detalhe do jogo > import em lote >
  // lote de capas > busca automática > Steam.
  // Só um desses costuma estar aberto por vez, mas a ordem garante um comportamento
  // previsível caso mais de um esteja (o "mais em cima" fecha primeiro).
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key !== "Escape") return;
      if (showForm) {
        closeForm();
      } else if (detailGameId) {
        closeDetail();
      } else if (showBulk) {
        closeBulk();
      } else if (showCoverBatch) {
        closeCoverBatch();
      } else if (showAutoCover) {
        closeAutoCover();
      } else if (showSteam) {
        closeSteam();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [detailGameId, showForm, showBulk, showCoverBatch, showAutoCover, showSteam, steamStage]);

  const updateGameAchievements = (gameId, updater) => {
    const game = games.find((g) => g.id === gameId);
    if (!game) return;
    const current = game.achievements || [];
    const updated = { ...game, achievements: updater(current), updatedAt: Date.now() };
    saveGames([updated]);
  };

  const addSingleAchievement = (gameId, { name, description, points, dlc }) => {
    const trimmedName = (name || "").trim();
    if (!trimmedName) return;
    updateGameAchievements(gameId, (current) => {
      const idx = current.findIndex((a) => normalizeForMatch(a.name) === normalizeForMatch(trimmedName));
      if (idx !== -1) {
        const next = [...current];
        next[idx] = {
          ...next[idx],
          description: description || next[idx].description,
          points: Number(points) || next[idx].points,
          dlc: dlc || next[idx].dlc || "",
        };
        return next;
      }
      return [
        ...current,
        {
          id: `a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name: trimmedName,
          description: description || "",
          points: Number(points) || 0,
          dlc: dlc || "",
          done: false,
        },
      ];
    });
  };

  const addAchievementsBulk = (gameId) => {
    const lines = achText.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) {
      setAchError("Cola pelo menos uma conquista, uma por linha.");
      return;
    }
    const parsed = lines.map((line) => {
      const parts = line.split(";").map((p) => p.trim());
      const name = parts[0] || line;
      const description = parts[1] || "";
      const points = parts[2] && /^\d+$/.test(parts[2]) ? Number(parts[2]) : 0;
      const dlc = parts[3] || "";
      // 5º campo (opcional): marca a conquista como já desbloqueada. Aceita uma data
      // "AAAA-MM-DD" (usada como doneAt) ou qualquer valor "verdadeiro" tipo sim/true/x/1
      // (nesse caso usa a data de hoje). Vazio ou ausente = não desbloqueada.
      const doneRaw = (parts[4] || "").trim();
      const isIsoDate = /^\d{4}-\d{2}-\d{2}$/.test(doneRaw);
      const isTruthy = /^(sim|true|verdadeiro|x|1|desbloqueada?)$/i.test(doneRaw);
      const done = isIsoDate || isTruthy;
      const doneAt = isIsoDate ? doneRaw : done ? new Date().toISOString().slice(0, 10) : "";
      return { name, description, points, dlc, done, doneAt };
    });
    const game = games.find((g) => g.id === gameId);
    if (!game) return;
    const mergedAchievements = mergeAchievements(game.achievements || [], parsed);
    const allDone = mergedAchievements.length > 0 && mergedAchievements.every((a) => a.done);
    const todayIso = new Date().toISOString().slice(0, 10);
    const updatedGame =
      allDone && game.status !== "100"
        ? { ...game, achievements: mergedAchievements, status: "100", completedAt: game.completedAt || todayIso, updatedAt: Date.now() }
        : { ...game, achievements: mergedAchievements, updatedAt: Date.now() };
    saveGames([updatedGame]);
    setAchText("");
    setAchError("");
  };

  const toggleAchievement = (gameId, achId) => {
    const todayIso = new Date().toISOString().slice(0, 10);
    const game = games.find((g) => g.id === gameId);
    if (!game) return;
    const updatedAchievements = (game.achievements || []).map((a) =>
      a.id === achId ? { ...a, done: !a.done, doneAt: !a.done ? todayIso : "" } : a
    );
    const allDone = updatedAchievements.length > 0 && updatedAchievements.every((a) => a.done);
    const updated = allDone && game.status !== "100"
      ? { ...game, achievements: updatedAchievements, status: "100", completedAt: game.completedAt || todayIso, updatedAt: Date.now() }
      : { ...game, achievements: updatedAchievements, updatedAt: Date.now() };
    saveGames([updated]);
  };

  const removeAchievement = (gameId, achId) => {
    updateGameAchievements(gameId, (current) => current.filter((a) => a.id !== achId));
  };

  const setAllAchievements = (gameId, done) => {
    const todayIso = new Date().toISOString().slice(0, 10);
    const game = games.find((g) => g.id === gameId);
    if (!game || !game.achievements || game.achievements.length === 0) return;
    const updatedAchievements = game.achievements.map((a) => ({
      ...a,
      done,
      doneAt: done ? a.doneAt || todayIso : "",
    }));
    const allDone = done && updatedAchievements.every((a) => a.done);
    const updated = allDone && game.status !== "100"
      ? { ...game, achievements: updatedAchievements, status: "100", completedAt: game.completedAt || todayIso, updatedAt: Date.now() }
      : { ...game, achievements: updatedAchievements, updatedAt: Date.now() };
    saveGames([updated]);
  };

  const deleteAllAchievements = (gameId) => {
    updateGameAchievements(gameId, () => []);
  };

  const filtered = useMemo(() => {
    return games.filter((g) => {
      if (filterPlatform !== "all" && platformFamily(g.platform) !== filterPlatform) return false;
      if (filterStatus !== "all" && g.status !== filterStatus) return false;
      if (search.trim() && !g.title.toLowerCase().includes(search.trim().toLowerCase())) return false;
      return true;
    });
  }, [games, filterPlatform, filterStatus, search]);

  const sorted = useMemo(() => {
    if (sortBy === "nome") return [...filtered].sort((a, b) => a.title.localeCompare(b.title, "pt-BR"));
    if (sortBy === "progresso") return [...filtered].sort((a, b) => (gamePct(b) ?? -1) - (gamePct(a) ?? -1));
    return filtered;
  }, [filtered, sortBy]);

  const counts = useMemo(() => {
    const c = { total: games.length, 100: 0, zerado: 0, jogando: 0, backlog: 0, historico: 0 };
    games.forEach((g) => { c[g.status] = (c[g.status] || 0) + 1; });
    return c;
  }, [games]);

  const pointsStats = useMemo(() => {
    let totalEarned = 0;
    let totalPossible = 0;
    const byPlatform = {};
    games.forEach((g) => {
      const { earned, total: possible } = gamePoints(g);
      if (possible === 0) return;
      totalEarned += earned;
      totalPossible += possible;
      if (!byPlatform[platformFamily(g.platform)]) byPlatform[platformFamily(g.platform)] = { earned: 0, possible: 0 };
      byPlatform[platformFamily(g.platform)].earned += earned;
      byPlatform[platformFamily(g.platform)].possible += possible;
    });
    return { totalEarned, totalPossible, byPlatform };
  }, [games]);

  if (sessionChecking) {
    return (
      <div style={{ fontFamily: "'Archivo', sans-serif", background: "#0E0E10", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "#A2A2A8", fontSize: "13px", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" }}>
        Carregando...
      </div>
    );
  }

  if (!session) {
    return (
      <div style={{ fontFamily: "'Archivo', sans-serif", background: "#0E0E10", minHeight: "100vh", color: "#F2F2EE", display: "flex", alignItems: "center", justifyContent: "center", padding: "32px 16px" }}>
        <style>{PLACAR_CSS}</style>
        <form onSubmit={handleLogin} style={{ width: "100%", maxWidth: "400px", display: "flex", flexDirection: "column", gap: "28px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "14px", paddingBottom: "24px", borderBottom: "1px solid #2A2A2E" }}>
            <span className="placar-marca" style={{ fontSize: "clamp(72px, 22vw, 104px)", lineHeight: 0.85 }}>Estante</span>
            <span style={{ fontSize: "14px", color: "#A2A2A8", lineHeight: 1.5 }}>Seus jogos e conquistas num placar só.</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <label htmlFor="login-email" className="placar-label">E-mail</label>
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              value={loginEmail}
              onChange={(e) => setLoginEmail(e.target.value)}
              required
              className="placar-campo"
              style={{ height: "48px", fontSize: "15px", padding: "0 14px" }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <label htmlFor="login-senha" className="placar-label">Senha</label>
            <input
              id="login-senha"
              type="password"
              autoComplete="current-password"
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              required
              className="placar-campo"
              style={{ height: "48px", fontSize: "15px", padding: "0 14px" }}
            />
          </div>
          {loginError && <p role="alert" style={{ color: "#FF7A5C", fontSize: "13px", margin: 0 }}>{loginError}</p>}
          <button
            type="submit"
            disabled={loginBusy}
            className="placar-btn"
            style={{ height: "52px", justifyContent: "center", border: "none", background: loginBusy ? "#2A2A2E" : "#D7FF3A", color: loginBusy ? "#A2A2A8" : "#0E0E10", cursor: loginBusy ? "default" : "pointer", fontSize: "14px", fontWeight: 800 }}
          >
            {loginBusy ? "Entrando..." : "Entrar"}
          </button>
        </form>
      </div>
    );
  }

  const pctConquistado = pointsStats.totalPossible > 0 ? (pointsStats.totalEarned / pointsStats.totalPossible) * 100 : 0;
  const platformCounts = games.reduce((acc, g) => {
    const fam = platformFamily(g.platform);
    acc[fam] = (acc[fam] || 0) + 1;
    return acc;
  }, {});

  return (
    <div style={{ fontFamily: "'Archivo', sans-serif", background: "#0E0E10", minHeight: "100vh", color: "#F2F2EE" }}>
      <style>{PLACAR_CSS}</style>
      <div className="placar-wrap">

      {restoreResult && (
        <div className="placar-aviso" style={{ borderColor: restoreResult.error ? "#FF5A36" : "#D7FF3A" }}>
          <span style={{ color: restoreResult.error ? "#FFB3A1" : "#EEFF9A" }}>
            {restoreResult.error
              ? restoreResult.error
              : `${restoreResult.count} jogo(s) restaurado(s)${restoreResult.ok ? "" : " — mas algo pode não ter salvo, tenta de novo se sumir"}.`}
          </span>
          <button onClick={() => setRestoreResult(null)} aria-label="Fechar aviso" className="placar-x">
            <X size={16} />
          </button>
        </div>
      )}

      {steamNotice && (
        <div className="placar-aviso" style={{ borderColor: steamNotice.error ? "#FF5A36" : "#D7FF3A" }}>
          <span style={{ color: steamNotice.error ? "#FFB3A1" : "#EEFF9A" }}>
            {steamNotice.error
              ? `Não consegui sincronizar a Steam: ${steamNotice.error}`
              : `Steam sincronizada: ${steamNotice.newlyDone} ${steamNotice.newlyDone === 1 ? "conquista nova" : "conquistas novas"} em ${steamNotice.updated} ${steamNotice.updated === 1 ? "jogo" : "jogos"}.`}
          </span>
          <button onClick={() => setSteamNotice(null)} aria-label="Fechar aviso" className="placar-x">
            <X size={16} />
          </button>
        </div>
      )}

      {saveWarning && (
        <div className="placar-aviso" style={{ borderColor: "#FF5A36" }}>
          <span style={{ color: "#FFB3A1" }}>
            A última alteração pode não ter sido salva de verdade. Não feche esta aba ainda.
          </span>
          <button onClick={retrySaveIndex} className="placar-btn" style={{ background: "#FF5A36", color: "#0E0E10", border: "none", flexShrink: 0 }}>
            Tentar salvar de novo
          </button>
        </div>
      )}

      {/* Cabeçalho */}
      <header className="placar-head">
        <span className="placar-marca">Estante</span>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setShowToolsMenu((s) => !s)}
              className="placar-btn"
              aria-label="Ferramentas"
              style={{ background: showToolsMenu ? "#2A2A2E" : "transparent", color: "#F2F2EE", border: "1px solid #3A3A40" }}
            >
              <Wrench size={16} /> <span className="so-desktop">Ferramentas</span>
            </button>
            {showToolsMenu && (
              <>
                <div onClick={() => setShowToolsMenu(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
                <div className="placar-menu">
                  <button onClick={() => { exportData(); setShowToolsMenu(false); }} disabled={games.length === 0} title="Baixa um arquivo com todos os jogos e capas, útil como backup ou para migrar no futuro">
                    <Download size={15} /> Exportar
                  </button>
                  <label title="Restaura jogos, capas e conquistas a partir de um arquivo de backup exportado anteriormente" style={{ opacity: restoreBusy ? 0.6 : 1, cursor: restoreBusy ? "default" : "pointer" }}>
                    <Upload size={15} /> {restoreBusy ? "restaurando..." : "Restaurar backup"}
                    <input
                      type="file"
                      accept=".json,application/json"
                      onChange={(e) => { handleRestoreFile(e); setShowToolsMenu(false); }}
                      disabled={restoreBusy}
                      style={{ display: "none" }}
                    />
                  </label>
                  <button onClick={() => { setShowBulk(true); setShowToolsMenu(false); }}>
                    <FileUp size={15} /> Importar em lote
                  </button>
                  <button onClick={() => { setShowCoverBatch(true); setShowToolsMenu(false); }} disabled={games.length === 0}>
                    <Images size={15} /> Várias capas
                  </button>
                  <button
                    onClick={() => { setShowAutoCover(true); setShowToolsMenu(false); }}
                    disabled={games.filter((g) => !g.cover).length === 0}
                    title="Busca automaticamente no IGDB e aplica a primeira opção encontrada pra cada jogo sem capa"
                  >
                    <Search size={15} /> Buscar capas automáticas
                  </button>
                </div>
              </>
            )}
          </div>
          <button
            onClick={openSteam}
            className="placar-btn"
            title="Puxa da Steam os jogos e as conquistas desbloqueadas"
            aria-label="Sincronizar Steam"
            style={{ background: "transparent", color: "#F2F2EE", border: "1px solid #3A3A40" }}
          >
            <RefreshCw size={16} /> <span className="so-desktop">Sincronizar</span>
          </button>
          <button onClick={openAdd} className="placar-btn" aria-label="Adicionar jogo" style={{ background: "#D7FF3A", color: "#0E0E10", border: "none" }}>
            <Plus size={16} /> <span className="so-desktop">Adicionar jogo</span>
          </button>
          <button onClick={handleLogout} className="placar-btn" title="Sair" aria-label="Sair" style={{ background: "transparent", color: "#A2A2A8", border: "1px solid #3A3A40", padding: "0 12px" }}>
            <LogOut size={16} />
          </button>
        </div>
      </header>

      {loading ? (
        <div style={{ padding: "90px 0", textAlign: "center", color: "#A2A2A8", fontSize: "13px", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" }}>Carregando estante...</div>
      ) : (
        <>
          {/* Placar */}
          <section className="placar-hero">
            <div>
              <span className="placar-label">Pontos</span>
              <span className="placar-num placar-num-grande">{pointsStats.totalEarned.toLocaleString("pt-BR")}</span>
              <span style={{ fontSize: "13px", color: "#A2A2A8" }}>
                de {pointsStats.totalPossible.toLocaleString("pt-BR")} possíveis
                {FILTER_PLATFORMS.filter((p) => pointsStats.byPlatform[p.id]).map((p) => (
                  <span key={p.id} className="so-desktop"> · {p.label} {pointsStats.byPlatform[p.id].earned.toLocaleString("pt-BR")}</span>
                ))}
              </span>
            </div>
            <div>
              <span className="placar-label">Jogos</span>
              <span className="placar-num">{counts.total}</span>
            </div>
            <div>
              <span className="placar-label">Com 100%</span>
              <span className="placar-num" style={{ color: "#D7FF3A" }}>{counts["100"] || 0}</span>
            </div>
            <div>
              <span className="placar-label">Conquistado</span>
              <span className="placar-num">{pctConquistado.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%</span>
            </div>
          </section>

          {/* Filtros */}
          <div className="placar-chips" style={{ marginBottom: "10px" }}>
            <Chip active={filterPlatform === "all"} onClick={() => setFilterPlatform("all")} label="Todos" count={counts.total} />
            {FILTER_PLATFORMS.map((p) => (
              <Chip key={p.id} active={filterPlatform === p.id} onClick={() => setFilterPlatform(p.id)} label={p.label} count={platformCounts[p.id] || 0} />
            ))}
          </div>
          <div className="placar-filtros">
            <div className="placar-chips">
              <Chip active={filterStatus === "all"} onClick={() => setFilterStatus("all")} label="Todos os status" />
              {STATUSES.map((s) => (
                <Chip key={s.id} active={filterStatus === s.id} onClick={() => setFilterStatus(s.id)} label={s.label} count={counts[s.id] || 0} />
              ))}
            </div>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "#A2A2A8" }}>
                <span className="so-desktop">Ordenar por</span>
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} aria-label="Ordenar por" className="placar-campo" style={{ width: "auto" }}>
                  <option value="recentes">mais recentes</option>
                  <option value="progresso">progresso</option>
                  <option value="nome">nome</option>
                </select>
              </label>
              <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
                <Search size={14} style={{ position: "absolute", left: "12px", top: "50%", transform: "translateY(-50%)", color: "#8A8A90" }} />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar jogo"
                  aria-label="Buscar jogo"
                  className="placar-campo"
                  style={{ paddingLeft: "34px", width: "100%", minWidth: 0 }}
                />
              </div>
            </div>
          </div>

          {/* Grade */}
          {filtered.length === 0 ? (
            <EmptyState hasGames={games.length > 0} onAdd={openAdd} />
          ) : (
            <div className="placar-grade">
              {sorted.map((g) => (
                <GameCard key={g.id} game={g} onEdit={() => openEdit(g)} onDelete={() => removeGame(g.id)} onOpen={() => openDetail(g.id)} onMarkZerado={() => markAsZerado(g)} isConfirmingDelete={confirmDeleteId === g.id} />
              ))}
            </div>
          )}
        </>
      )}


      {/* Bulk import modal */}
      {showBulk && (
        <div onClick={closeBulk} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: "16px" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#16161A", borderRadius: 0, padding: "22px", width: "100%", maxWidth: "440px", border: "1px solid #2A2A2E" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
              <h2 style={{ fontFamily: "'Archivo', sans-serif", fontSize: "17px", margin: 0, fontWeight: 600 }}>
                Importar em lote
              </h2>
              <button onClick={closeBulk} style={{ background: "none", border: "none", color: "#A2A2A8", cursor: "pointer", padding: "2px" }}>
                <X size={18} />
              </button>
            </div>

            <p style={{ fontSize: "12px", color: "#A2A2A8", lineHeight: 1.5, margin: "0 0 10px" }}>
              Um jogo por linha, campos separados por ponto e vírgula:<br />
              <span style={{ color: "#F2F2EE" }}>Título; Plataforma; Status; Data(AAAA-MM-DD); Notas; Link da capa</span><br />
              Só o título é obrigatório. Campos em branco não apagam o que já existe — útil pra atualizar só a capa de jogos que já estão na estante.
            </p>
            <div style={{ background: "#0E0E10", border: "1px solid #2A2A2E", borderRadius: 0, padding: "8px 10px", fontSize: "11px", color: "#8A8A90", marginBottom: "12px", fontFamily: "'Archivo', sans-serif" }}>
              Hollow Knight; Switch 2; 100%; 2025-03-14<br />
              Celeste; Steam; Zerado<br />
              Elden Ring; PlayStation; Zerado; 2024-11-02; DLC incluso; https://exemplo.com/capa.jpg<br />
              Mario Odyssey;;;;;https://exemplo.com/so-a-capa.jpg
            </div>

            <textarea
              value={bulkText}
              onChange={(e) => { setBulkText(e.target.value); setBulkResult(null); }}
              placeholder={"Hollow Knight; Switch 2; 100%; 2025-03-14\nCeleste; Steam; Zerado"}
              rows={7}
              style={{ ...inputStyle, resize: "vertical", fontFamily: "'Archivo', sans-serif", fontSize: "12px", marginBottom: "10px" }}
            />

            {bulkResult && (
              <div style={{ marginBottom: "10px", fontSize: "12px" }}>
                {bulkResult.added > 0 && (
                  <p style={{ color: "#D7FF3A", margin: "0 0 4px" }}>{bulkResult.added} jogo(s) novo(s) adicionado(s).</p>
                )}
                {bulkResult.updated > 0 && (
                  <p style={{ color: "#F2F2EE", margin: "0 0 4px" }}>{bulkResult.updated} jogo(s) já existente(s) atualizado(s) (status/data/notas).</p>
                )}
                {bulkResult.errors.length > 0 && (
                  <ul style={{ color: "#FF7A5C", margin: 0, paddingLeft: "16px" }}>
                    {bulkResult.errors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                )}
              </div>
            )}

            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={closeBulk} style={{ flex: 1, padding: "10px", borderRadius: 0, border: "1px solid #2A2A2E", background: "transparent", color: "#A2A2A8", cursor: "pointer", fontSize: "13px", fontWeight: 500 }}>
                Fechar
              </button>
              <button onClick={runBulkImport} disabled={!bulkText.trim()} style={{ flex: 1, padding: "10px", borderRadius: 0, border: "none", background: bulkText.trim() ? "#D7FF3A" : "#2A2A2E", color: bulkText.trim() ? "#0E0E10" : "#8A8A90", cursor: bulkText.trim() ? "pointer" : "default", fontSize: "13px", fontWeight: 600 }}>
                Importar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Batch cover matching modal */}
      {showCoverBatch && (
        <div onClick={closeCoverBatch} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: "16px" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#16161A", borderRadius: 0, width: "100%", maxWidth: "520px", border: "1px solid #2A2A2E", maxHeight: "85vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "22px 22px 14px", flexShrink: 0 }}>
              <h2 style={{ fontFamily: "'Archivo', sans-serif", fontSize: "17px", margin: 0, fontWeight: 600 }}>Várias capas de uma vez</h2>
              <button onClick={closeCoverBatch} style={{ background: "none", border: "none", color: "#A2A2A8", cursor: "pointer", padding: "2px" }}>
                <X size={18} />
              </button>
            </div>

            <div style={{ padding: "0 22px 22px", overflowY: "auto" }}>
              <div
                onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setBatchDragging(true); }}
                onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setBatchDragging(false); }}
                onDrop={handleBatchDrop}
                style={{
                  border: `1.5px dashed ${batchDragging ? "#D7FF3A" : "#2A2A2E"}`, borderRadius: 0,
                  background: batchDragging ? "#D7FF3A14" : "transparent", padding: "20px 10px", textAlign: "center", transition: "all 0.12s ease", marginBottom: "16px",
                }}
              >
                <p style={{ fontSize: "12px", color: batchDragging ? "#D7FF3A" : "#8A8A90", margin: "0 0 8px" }}>
                  {batchDragging ? "solta aqui" : "arraste várias imagens aqui de uma vez, ou"}
                </p>
                <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "#F2F2EE", border: "1px solid #2A2A2E", borderRadius: 0, padding: "7px 12px", cursor: "pointer", background: "#0E0E10" }}>
                  <ImageUp size={13} />
                  escolher várias do computador
                  <input type="file" accept="image/*" multiple onChange={handleBatchFilePick} style={{ display: "none" }} />
                </label>
              </div>

              {coverQueue.length > 0 && (
                <>
                  <p style={{ fontSize: "12px", color: "#A2A2A8", margin: "0 0 10px" }}>
                    Pra cada imagem, escolhe o jogo correspondente (já tentei adivinhar pelo nome do arquivo, e pela própria imagem quando o nome não ajudou):
                  </p>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "16px" }}>
                    {coverQueue.map((q) => {
                      const pickerOptions = games
                        .filter((g) => !g.cover || g.id === q.selectedGameId)
                        .slice()
                        .sort((a, b) => a.title.localeCompare(b.title, "pt"));
                      return (
                        <div key={q.tempId} style={{ display: "flex", alignItems: "center", gap: "10px", background: "#0E0E10", border: "1px solid #2A2A2E", borderRadius: 0, padding: "8px" }}>
                          <img src={q.dataUrl} alt={q.filename} style={{ width: "36px", height: "48px", objectFit: "cover", borderRadius: 0, flexShrink: 0 }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: "10.5px", color: "#8A8A90", marginBottom: "4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.filename}</div>
                            {q.visionPending ? (
                              <div style={{ fontSize: "11px", color: "#F2F2EE", padding: "6px 0" }}>analisando imagem...</div>
                            ) : (
                              <select
                                value={q.selectedGameId}
                                onChange={(e) => setQueueItemGame(q.tempId, e.target.value)}
                                style={{ width: "100%", background: "#16161A", border: "1px solid #2A2A2E", borderRadius: 0, padding: "6px 8px", fontSize: "12px", color: "#F2F2EE", outline: "none" }}
                              >
                                <option value="">— escolher jogo —</option>
                                {pickerOptions.map((g) => (
                                  <option key={g.id} value={g.id}>{g.title}</option>
                                ))}
                              </select>
                            )}
                          </div>
                          <button onClick={() => removeQueueItem(q.tempId)} style={{ background: "none", border: "none", color: "#8A8A90", cursor: "pointer", padding: "2px", flexShrink: 0 }} aria-label="Remover da fila">
                            <X size={14} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <button
                    onClick={applyCoverBatch}
                    disabled={batchApplying || coverQueue.every((q) => !q.selectedGameId)}
                    style={{ width: "100%", padding: "10px", borderRadius: 0, border: "none", background: "#D7FF3A", color: "#0E0E10", cursor: "pointer", fontSize: "13px", fontWeight: 600, opacity: batchApplying ? 0.6 : 1 }}
                  >
                    {batchApplying ? "aplicando..." : `Aplicar ${coverQueue.filter((q) => q.selectedGameId).length} capa(s)`}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {showAutoCover && (
        <div onClick={closeAutoCover} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: "16px" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#16161A", borderRadius: 0, padding: "22px", width: "100%", maxWidth: "380px", border: "1px solid #2A2A2E" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
              <h2 style={{ fontFamily: "'Archivo', sans-serif", fontSize: "16px", margin: 0, fontWeight: 600 }}>
                Buscar capas automáticas
              </h2>
              {!autoCoverBusy && (
                <button onClick={closeAutoCover} style={{ background: "none", border: "none", color: "#A2A2A8", cursor: "pointer", padding: "2px" }}>
                  <X size={18} />
                </button>
              )}
            </div>

            {!autoCoverBusy && !autoCoverDone && (
              <>
                <p style={{ fontSize: "12.5px", color: "#A2A2A8", lineHeight: 1.5, margin: "0 0 16px" }}>
                  Isso vai buscar no IGDB pelo título de cada um dos <strong style={{ color: "#F2F2EE" }}>{games.filter((g) => !g.cover).length} jogos sem capa</strong> e aplicar automaticamente a primeira opção encontrada (capa + ano, gêneros, desenvolvedora, nota e sinopse). Se alguma vier errada, você pode corrigir manualmente depois editando o jogo.
                </p>
                <button
                  onClick={runAutoCoverSearch}
                  style={{ width: "100%", padding: "10px", borderRadius: 0, border: "none", background: "#D7FF3A", color: "#0E0E10", cursor: "pointer", fontSize: "13px", fontWeight: 600 }}
                >
                  Iniciar busca ({games.filter((g) => !g.cover).length} jogos)
                </button>
              </>
            )}

            {autoCoverBusy && (
              <>
                <p style={{ fontSize: "12.5px", color: "#A2A2A8", margin: "0 0 10px" }}>
                  Buscando... {autoCoverProgress.current}/{autoCoverProgress.total}
                </p>
                <div style={{ height: "6px", background: "#0E0E10", borderRadius: 0, overflow: "hidden", marginBottom: "10px" }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${autoCoverProgress.total > 0 ? (autoCoverProgress.current / autoCoverProgress.total) * 100 : 0}%`,
                      background: "#D7FF3A",
                      borderRadius: 0,
                      transition: "width 0.2s ease",
                    }}
                  />
                </div>
                <p style={{ fontSize: "11px", color: "#8A8A90", margin: 0 }}>
                  {autoCoverProgress.found} encontradas · {autoCoverProgress.notFound} não encontradas
                </p>
              </>
            )}

            {autoCoverDone && (
              <>
                <p style={{ fontSize: "13px", color: "#F2F2EE", margin: "0 0 4px" }}>
                  Busca concluída!
                </p>
                <p style={{ fontSize: "12px", color: "#A2A2A8", margin: "0 0 16px" }}>
                  <strong style={{ color: "#D7FF3A" }}>{autoCoverProgress.found}</strong> capas aplicadas · <strong style={{ color: "#A2A2A8" }}>{autoCoverProgress.notFound}</strong> não encontradas no IGDB
                </p>
                <button
                  onClick={closeAutoCover}
                  style={{ width: "100%", padding: "10px", borderRadius: 0, border: "none", background: "#D7FF3A", color: "#0E0E10", cursor: "pointer", fontSize: "13px", fontWeight: 600 }}
                >
                  Fechar
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {showSteam && (() => {
        const plan = steamOwned ? planSteamSync(games, steamOwned.games) : null;
        const primaryBtn = { width: "100%", padding: "10px", borderRadius: 0, border: "none", background: "#D7FF3A", color: "#0E0E10", cursor: "pointer", fontSize: "13px", fontWeight: 600 };
        return (
          <div onClick={closeSteam} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: "16px" }}>
            <div onClick={(e) => e.stopPropagation()} style={{ background: "#16161A", borderRadius: 0, padding: "22px", width: "100%", maxWidth: "400px", border: "1px solid #2A2A2E" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
                <h2 style={{ fontFamily: "'Archivo', sans-serif", fontSize: "16px", margin: 0, fontWeight: 600 }}>
                  Sincronizar Steam
                </h2>
                {steamStage !== "lendo" && steamStage !== "sincronizando" && (
                  <button onClick={closeSteam} style={{ background: "none", border: "none", color: "#A2A2A8", cursor: "pointer", padding: "2px" }}>
                    <X size={18} />
                  </button>
                )}
              </div>

              {(steamStage === "idle" || steamStage === "lendo") && (
                <>
                  <p style={{ fontSize: "12.5px", color: "#A2A2A8", lineHeight: 1.5, margin: "0 0 12px" }}>
                    Cole o link do seu perfil (ex.: steamcommunity.com/id/seunome). O perfil e os detalhes de jogo precisam estar públicos na Steam.
                  </p>
                  <input
                    value={steamProfile}
                    onChange={(e) => setSteamProfile(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && steamStage === "idle") readSteamLibrary(); }}
                    placeholder="https://steamcommunity.com/id/..."
                    disabled={steamStage === "lendo"}
                    style={{ ...inputStyle, marginBottom: "10px" }}
                  />
                  {steamError && <p style={{ fontSize: "12px", color: "#FFB3A1", margin: "0 0 10px", lineHeight: 1.5 }}>{steamError}</p>}
                  <button onClick={readSteamLibrary} disabled={steamStage === "lendo"} style={{ ...primaryBtn, opacity: steamStage === "lendo" ? 0.6 : 1 }}>
                    {steamStage === "lendo" ? "Lendo a biblioteca..." : "Ler biblioteca"}
                  </button>
                </>
              )}

              {steamStage === "previa" && plan && (
                <>
                  <p style={{ fontSize: "12.5px", color: "#A2A2A8", lineHeight: 1.5, margin: "0 0 12px" }}>
                    {steamOwned.personaName ? <strong style={{ color: "#F2F2EE" }}>{steamOwned.personaName}</strong> : "Perfil"} tem {steamOwned.games.length} jogos na Steam.{" "}
                    <strong style={{ color: "#F2F2EE" }}>{plan.matchedCount}</strong> já estão na estante e vão receber as conquistas.
                  </p>
                  {plan.newCount > 0 && (
                    <label style={{ display: "flex", gap: "8px", alignItems: "flex-start", fontSize: "12.5px", color: "#F2F2EE", marginBottom: "14px", cursor: "pointer", lineHeight: 1.5 }}>
                      <input type="checkbox" checked={steamAddNew} onChange={(e) => setSteamAddNew(e.target.checked)} style={{ marginTop: "3px" }} />
                      <span>Adicionar também os {plan.newCount} jogos já jogados que ainda não estão na estante</span>
                    </label>
                  )}
                  <button onClick={runSteamSync} style={primaryBtn}>
                    Sincronizar
                  </button>
                </>
              )}

              {steamStage === "sincronizando" && (
                <>
                  <p style={{ fontSize: "12.5px", color: "#A2A2A8", margin: "0 0 10px" }}>
                    Buscando conquistas... {steamProgress.current}/{steamProgress.total} jogos
                  </p>
                  <div style={{ height: "6px", background: "#0E0E10", borderRadius: 0, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${steamProgress.total > 0 ? (steamProgress.current / steamProgress.total) * 100 : 0}%`, background: "#D7FF3A", borderRadius: 0, transition: "width 0.2s ease" }} />
                  </div>
                </>
              )}

              {steamStage === "pronto" && steamResult && (
                <>
                  <p style={{ fontSize: "13px", color: "#F2F2EE", margin: "0 0 4px" }}>
                    {steamResult.ok ? "Sincronização concluída!" : "Sincronizei, mas o salvamento falhou."}
                  </p>
                  <p style={{ fontSize: "12px", color: "#A2A2A8", margin: "0 0 16px", lineHeight: 1.6 }}>
                    <strong style={{ color: "#D7FF3A" }}>{steamResult.newlyDone}</strong> conquistas novas · <strong style={{ color: "#F2F2EE" }}>{steamResult.updated}</strong> jogos atualizados · <strong style={{ color: "#F2F2EE" }}>{steamResult.added}</strong> adicionados
                    {steamResult.failed > 0 && <><br />{steamResult.failed} jogos não responderam e entram de novo na próxima sincronização.</>}
                  </p>
                  <button onClick={closeSteam} style={primaryBtn}>
                    Fechar
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {/* Achievement detail modal */}
      {detailGameId && (() => {
        const game = games.find((g) => g.id === detailGameId);
        if (!game) return null;
        return (
          <DetailModal
            game={game}
            onClose={closeDetail}
            onEdit={() => openEdit(game)}
            achText={achText}
            setAchText={setAchText}
            achError={achError}
            onAddBulk={() => addAchievementsBulk(game.id)}
            onToggle={(achId) => toggleAchievement(game.id, achId)}
            onRemove={(achId) => removeAchievement(game.id, achId)}
            onCompleteAll={() => setAllAchievements(game.id, true)}
            onUncompleteAll={() => setAllAchievements(game.id, false)}
            onDeleteAll={() => deleteAllAchievements(game.id)}
            onAddSingle={(data) => addSingleAchievement(game.id, data)}
          />
        );
      })()}

      {/* Form modal */}
      {showForm && (
        <div onClick={closeForm} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: "16px" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#16161A", borderRadius: 0, width: "100%", maxWidth: "380px", border: "1px solid #2A2A2E", maxHeight: "85vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "22px 22px 16px", flexShrink: 0, background: "#16161A", position: "sticky", top: 0, zIndex: 1 }}>
              <h2 style={{ fontFamily: "'Archivo', sans-serif", fontSize: "17px", margin: 0, fontWeight: 600 }}>
                {editingId ? "Editar jogo" : "Novo jogo"}
              </h2>
              <button type="button" onClick={closeForm} style={{ background: "none", border: "none", color: "#A2A2A8", cursor: "pointer", padding: "2px" }}>
                <X size={18} />
              </button>
            </div>
            <form onSubmit={(e) => { e.preventDefault(); submitForm(); }} style={{ padding: "0 22px 22px", overflowY: "auto" }}>

            <Field label="Título">
              <input
                value={form.title}
                onChange={(e) => { setForm({ ...form, title: e.target.value }); setFormError(""); }}
                placeholder="Ex: Hollow Knight: Silksong"
                style={inputStyle}
                autoFocus
              />
            </Field>

            <Field label="Plataforma">
              <select value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })} style={inputStyle}>
                {PLATFORMS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </Field>

            <Field label="Capa e dados (opcional)">
              <button
                type="button"
                onClick={handleSearchCovers}
                disabled={coverSearchBusy || !form.title.trim()}
                title={!form.title.trim() ? "Preenche o título primeiro" : "Busca o jogo no IGDB pra você escolher a versão certa"}
                style={{
                  display: "flex", alignItems: "center", gap: "6px", width: "100%", justifyContent: "center",
                  background: coverSearchBusy ? "#2A2A2E" : "#F2F2EE22", color: coverSearchBusy ? "#8A8A90" : "#F2F2EE",
                  border: `1px solid ${coverSearchBusy ? "#2A2A2E" : "#F2F2EE55"}`, borderRadius: 0, padding: "8px",
                  fontSize: "12px", fontWeight: 600, cursor: coverSearchBusy || !form.title.trim() ? "default" : "pointer", marginBottom: "8px",
                }}
              >
                <Search size={13} /> {coverSearchBusy ? "buscando no IGDB..." : "Buscar no IGDB"}
              </button>
              {coverSearchError && <p style={{ color: "#FF7A5C", fontSize: "11px", margin: "0 0 8px" }}>{coverSearchError}</p>}
              {coverCandidates.length > 0 && (
                <div style={{ marginBottom: "10px" }}>
                  <p style={{ fontSize: "11px", color: "#A2A2A8", margin: "0 0 6px" }}>Escolha a versão correta:</p>
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: "260px", overflowY: "auto" }}>
                    {coverCandidates.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => pickIgdbMatch(m)}
                        style={{ display: "flex", gap: "8px", textAlign: "left", padding: "6px", border: "1px solid #2A2A2E", borderRadius: 0, cursor: "pointer", background: "#0E0E10" }}
                      >
                        <div style={{ width: "42px", height: "56px", flexShrink: 0, borderRadius: 0, overflow: "hidden", background: "#0A0910" }}>
                          {m.cover && (
                            <img
                              src={displayCoverUrl(m.cover)}
                              alt={m.name}
                              onError={(e) => { e.currentTarget.style.display = "none"; }}
                              style={{ width: "100%", height: "100%", objectFit: "cover" }}
                            />
                          )}
                        </div>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: "12px", fontWeight: 600, color: "#F2F2EE", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {m.name} {m.releaseYear ? <span style={{ color: "#8A8A90", fontWeight: 400 }}>({m.releaseYear})</span> : null}
                          </div>
                          <div style={{ fontSize: "10px", color: "#A2A2A8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: "2px" }}>
                            {[m.developer, ...(m.platforms || []).slice(0, 3)].filter(Boolean).join(" · ")}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setCoverCandidates([])}
                    style={{ background: "none", border: "none", color: "#8A8A90", fontSize: "11px", cursor: "pointer", marginTop: "6px", textDecoration: "underline" }}
                  >
                    nenhuma dessas, esconder opções
                  </button>
                </div>
              )}
              <input
                value={form.cover && form.cover.startsWith("data:") ? "" : form.cover}
                onChange={(e) => setForm({ ...form, cover: e.target.value })}
                placeholder="Cole o link de uma imagem..."
                style={inputStyle}
                disabled={form.cover && form.cover.startsWith("data:")}
              />
              <div
                onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setCoverDragging(true); }}
                onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setCoverDragging(false); }}
                onDrop={handleCoverDrop}
                style={{
                  marginTop: "8px", border: `1.5px dashed ${coverDragging ? "#D7FF3A" : "#2A2A2E"}`, borderRadius: 0,
                  background: coverDragging ? "#D7FF3A14" : "transparent", padding: "14px 10px", textAlign: "center", transition: "all 0.12s ease",
                }}
              >
                <p style={{ fontSize: "11px", color: coverDragging ? "#D7FF3A" : "#8A8A90", margin: "0 0 8px" }}>
                  {coverDragging ? "solta aqui" : "arraste uma imagem aqui, ou"}
                </p>
                <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "#F2F2EE", border: "1px solid #2A2A2E", borderRadius: 0, padding: "7px 12px", cursor: "pointer", background: "#0E0E10" }}>
                  <ImageUp size={13} />
                  {coverBusy ? "processando..." : "escolher do computador"}
                  <input type="file" accept="image/*" onChange={handleCoverFile} disabled={coverBusy} style={{ display: "none" }} />
                </label>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "8px" }}>
                {form.cover && (
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, cover: "" })}
                    style={{ background: "none", border: "none", color: "#A2A2A8", fontSize: "12px", cursor: "pointer", textDecoration: "underline" }}
                  >
                    remover capa
                  </button>
                )}
              </div>
              {form.cover && (
                <div style={{ marginTop: "10px", width: "64px", height: "85px", borderRadius: 0, overflow: "hidden", border: "1px solid #2A2A2E" }}>
                  <img src={displayCoverUrl(form.cover)} alt="Prévia da capa" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                </div>
              )}
            </Field>

            <Field label="Status">
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                {STATUSES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setForm({ ...form, status: s.id })}
                    style={{
                      display: "flex", alignItems: "center", gap: "5px", padding: "7px 10px", borderRadius: 0, fontSize: "12px", fontWeight: 600, cursor: "pointer",
                      border: form.status === s.id ? `1px solid ${s.color}` : "1px solid #2A2A2E",
                      background: form.status === s.id ? `${s.color}22` : "transparent",
                      color: form.status === s.id ? s.color : "#A2A2A8",
                    }}
                  >
                    <s.Icon size={13} /> {s.label}
                  </button>
                ))}
              </div>
            </Field>

            {hasStarted(form.status) && (
              <Field label="Data de início">
                <input
                  type="date"
                  value={form.startedAt}
                  onChange={(e) => setForm({ ...form, startedAt: e.target.value })}
                  style={inputStyle}
                />
              </Field>
            )}

            {isCompletedStatus(form.status) && (
              <Field label="Data que zerou / completou">
                <input
                  type="date"
                  value={form.completedAt}
                  onChange={(e) => setForm({ ...form, completedAt: e.target.value })}
                  style={inputStyle}
                />
              </Field>
            )}

            <Field label="Notas (opcional)">
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="DLCs, tempo de jogo, o que faltou pro platina..."
                rows={2}
                style={{ ...inputStyle, resize: "none" }}
              />
            </Field>

            {formError && <p style={{ color: "#FF7A5C", fontSize: "12px", margin: "0 0 12px" }}>{formError}</p>}

            <div style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
              <button type="button" onClick={closeForm} style={{ flex: 1, padding: "10px", borderRadius: 0, border: "1px solid #2A2A2E", background: "transparent", color: "#A2A2A8", cursor: "pointer", fontSize: "13px", fontWeight: 500 }}>
                Cancelar
              </button>
              <button type="submit" style={{ flex: 1, padding: "10px", borderRadius: 0, border: "none", background: "#D7FF3A", color: "#0E0E10", cursor: "pointer", fontSize: "13px", fontWeight: 600 }}>
                {editingId ? "Salvar" : "Adicionar"}
              </button>
            </div>
            </form>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

function Chip({ active, onClick, label, count }) {
  return (
    <button
      type="button"
      className="placar-chip"
      onClick={onClick}
      aria-pressed={active}
      style={{
        background: active ? "#F2F2EE" : "transparent",
        color: active ? "#0E0E10" : "#F2F2EE",
        border: active ? "1px solid #F2F2EE" : "1px solid #3A3A40",
        fontWeight: active ? 700 : 600,
      }}
    >
      {label}
      {count !== undefined && <span style={{ opacity: active ? 0.7 : 0.6 }}> · {count}</span>}
    </button>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: "14px" }}>
      <label style={{ display: "block", fontSize: "12px", color: "#A2A2A8", marginBottom: "6px" }}>{label}</label>
      {children}
    </div>
  );
}

const inputStyle = {
  width: "100%", background: "#0E0E10", border: "1px solid #2A2A2E", borderRadius: 0, padding: "9px 10px", fontSize: "13px", color: "#F2F2EE", outline: "none", boxSizing: "border-box",
};

// Estilos da direção "Placar" que precisam de :hover ou de @media (o resto é inline).
const PLACAR_CSS = `
  .placar-wrap { max-width: 1280px; margin: 0 auto; padding: 40px 48px 64px; }
  .placar-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 32px; }
  .placar-marca { font-weight: 900; font-stretch: 70%; font-size: 34px; letter-spacing: 0.02em; text-transform: uppercase; line-height: 1; }
  .placar-btn { height: 44px; padding: 0 16px; display: inline-flex; align-items: center; gap: 8px; font-family: inherit; font-size: 13px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; cursor: pointer; }
  .placar-btn:hover, .placar-chip:hover { filter: brightness(1.15); }
  .placar-chip { height: 40px; padding: 0 14px; font-family: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
  .placar-chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .placar-filtros { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 28px; }
  .placar-campo { height: 40px; background: #0E0E10; border: 1px solid #3A3A40; color: #F2F2EE; font-family: inherit; font-size: 13px; padding: 0 10px; outline: none; }
  .placar-campo:focus { border-color: #F2F2EE; }
  .placar-menu { position: absolute; top: calc(100% + 6px); right: 0; background: #16161A; border: 1px solid #2A2A2E; padding: 6px; display: flex; flex-direction: column; gap: 2px; z-index: 41; min-width: 220px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
  .placar-menu button, .placar-menu label { display: flex; align-items: center; gap: 10px; background: none; color: #F2F2EE; border: none; padding: 11px 10px; font-family: inherit; font-weight: 600; font-size: 13px; cursor: pointer; text-align: left; }
  .placar-menu button:hover, .placar-menu label:hover { background: #222226; }
  .placar-menu button:disabled { color: #55555C; cursor: default; background: none; }
  .placar-aviso { display: flex; align-items: center; justify-content: space-between; gap: 12px; border: 1px solid; padding: 10px 14px; margin-bottom: 18px; font-size: 13px; }
  .placar-x { background: none; border: none; color: #A2A2A8; cursor: pointer; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .placar-hero { display: grid; grid-template-columns: 1.6fr 1fr 1fr 1fr; border-top: 1px solid #2A2A2E; border-bottom: 1px solid #2A2A2E; margin-bottom: 28px; }
  .placar-hero > div { padding: 24px; border-left: 1px solid #2A2A2E; display: flex; flex-direction: column; justify-content: flex-end; gap: 10px; min-width: 0; }
  .placar-hero > div:first-child { border-left: none; padding-left: 0; }
  .placar-hero > div:last-child { padding-right: 0; }
  .placar-label { font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #A2A2A8; }
  .placar-num { font-weight: 800; font-stretch: 68%; line-height: 0.9; font-size: clamp(40px, 5vw, 64px); }
  .placar-num-grande { font-size: clamp(64px, 8.4vw, 112px); letter-spacing: -0.01em; }
  .placar-grade { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 28px 16px; }
  .cart-card { cursor: pointer; display: flex; flex-direction: column; gap: 10px; position: relative; min-width: 0; }
  .cart-card .cart-capa img { transition: transform 0.2s ease; }
  .cart-card:hover .cart-capa img { transform: scale(1.03); }
  .cart-actions { opacity: 0; transition: opacity 0.15s ease; }
  .cart-card:hover .cart-actions, .cart-card:focus-within .cart-actions { opacity: 1; }
  .detalhe-wrap { max-width: 1180px; margin: 0 auto; padding: 32px 48px 64px; }
  .detalhe-topo { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 28px 40px; align-items: end; padding-bottom: 32px; border-bottom: 1px solid #2A2A2E; margin-bottom: 24px; }
  .detalhe-titulo { margin: 0; font-size: 112px; font-weight: 900; font-stretch: 62%; line-height: 0.85; text-transform: uppercase; letter-spacing: -0.01em; overflow-wrap: anywhere; }
  .detalhe-capa { grid-row: span 2; align-self: start; }
  .detalhe-stats { grid-column: 2; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-top: 1px solid #2A2A2E; }
  .detalhe-stats > div { padding: 18px 20px 0; border-left: 1px solid #2A2A2E; display: flex; flex-direction: column; gap: 8px; }
  .detalhe-stats > div:first-child { border-left: none; padding-left: 0; }
  .detalhe-num { font-size: 48px; white-space: nowrap; }
  .detalhe-num-sub { color: #A2A2A8; font-size: 28px; }
  .detalhe-linha { display: grid; grid-template-columns: 56px minmax(0, 1fr) 260px 64px 44px; gap: 16px; align-items: center; padding: 12px 0; border-bottom: 1px solid #222226; cursor: pointer; }
  .detalhe-linha:hover { background: #141417; }
  input, textarea, select { font-family: 'Archivo', sans-serif; }
  @media (max-width: 720px) {
    .placar-wrap { padding: 20px 16px 48px; }
    .placar-head { margin-bottom: 20px; }
    .placar-marca { font-size: 26px; }
    .placar-btn { padding: 0 12px; }
    .so-desktop { display: none !important; }
    .placar-hero { grid-template-columns: repeat(3, minmax(0, 1fr)); margin-bottom: 20px; }
    .placar-hero > div { padding: 12px; }
    .placar-hero > div:first-child { grid-column: 1 / -1; padding: 0 0 16px; border-bottom: 1px solid #2A2A2E; }
    .placar-hero > div:nth-child(2) { border-left: none; padding-left: 0; }
    .placar-num { font-size: 28px; }
    .placar-num-grande { font-size: 76px; }
    .placar-chips { flex-wrap: nowrap; overflow-x: auto; margin-left: -16px; margin-right: -16px; padding: 0 16px; scrollbar-width: none; }
    .placar-chips::-webkit-scrollbar { display: none; }
    .placar-filtros { flex-direction: column; flex-wrap: nowrap; align-items: stretch; margin-bottom: 20px; }
    .placar-filtros > * { min-width: 0; }
    .placar-grade { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px 10px; }
    .cart-titulo { font-size: 12px !important; }
    .detalhe-wrap { padding: 16px 16px 48px; }
    .detalhe-topo { grid-template-columns: 110px minmax(0, 1fr); gap: 16px; padding-bottom: 20px; }
    .detalhe-titulo { font-size: 48px; }
    .detalhe-capa { grid-row: auto; }
    .detalhe-stats { grid-column: 1 / -1; }
    .detalhe-stats > div { padding: 12px 12px 0; }
    .detalhe-num { font-size: 30px; }
    .detalhe-num-sub { font-size: 18px; }
    .detalhe-linha { grid-template-columns: 40px minmax(0, 1fr) 44px; gap: 12px; }
    .detalhe-linha .detalhe-raridade, .detalhe-linha .detalhe-pontos { display: none !important; }
  }
`;

function GameCard({ game, onEdit, onDelete, onOpen, onMarkZerado, isConfirmingDelete }) {
  const [imgFailed, setImgFailed] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const status = statusOf(game.status);
  const platform = platformOf(game.platform);
  const showCover = game.cover && !imgFailed;
  const points = gamePoints(game);
  const pct = gamePct(game);
  const is100 = game.status === "100" || pct === 100;

  const handleImgError = () => {
    if (retryNonce < 3) {
      // Cold cache no proxy de imagem costuma resolver sozinho em alguns segundos.
      // Tenta de novo com atraso crescente antes de desistir.
      const delay = [600, 1500, 3000][retryNonce] || 3000;
      setTimeout(() => setRetryNonce((n) => n + 1), delay);
    } else {
      setImgFailed(true);
    }
  };

  const handleManualRetry = (e) => {
    e.stopPropagation();
    setImgFailed(false);
    setRetryNonce((n) => n + 1);
  };

  return (
    <article className="cart-card" onClick={onOpen}>
      <div className="cart-capa" style={{ position: "relative", aspectRatio: "2 / 3", background: "#1C1C20", overflow: "hidden", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "8px" }}>
        {showCover ? (
          <img
            key={retryNonce}
            src={
              retryNonce > 0 && game.cover.startsWith("http")
                ? `${displayCoverUrl(game.cover)}&r=${retryNonce}`
                : displayCoverUrl(game.cover)
            }
            alt={`Capa de ${game.title}`}
            onError={handleImgError}
            loading="lazy"
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        ) : (
          <>
            <Gamepad2 size={26} color="#55555C" />
            {game.cover && imgFailed && (
              <>
                <span style={{ fontSize: "11px", color: "#8A8A90", textAlign: "center", padding: "0 10px" }}>a capa não carregou</span>
                <button onClick={handleManualRetry} style={{ fontSize: "11px", fontWeight: 700, color: "#F2F2EE", background: "none", border: "1px solid #3A3A40", padding: "6px 10px", cursor: "pointer" }}>
                  tentar de novo
                </button>
              </>
            )}
          </>
        )}
        {is100 && (
          <span style={{ position: "absolute", top: 0, left: 0, background: "#D7FF3A", color: "#0E0E10", fontSize: "12px", fontWeight: 900, fontStretch: "75%", padding: "5px 8px", letterSpacing: "0.04em" }}>100%</span>
        )}
        <div className="cart-actions" style={{ position: "absolute", top: "6px", right: "6px", display: "flex", gap: "4px", opacity: isConfirmingDelete ? 1 : undefined }}>
          {game.status === "historico" && (
            <button
              onClick={(e) => { e.stopPropagation(); onMarkZerado(); }}
              style={{ ...iconBtnStyle, background: "#F2F2EE", borderColor: "#F2F2EE", color: "#0E0E10" }}
              aria-label="Marcar como zerado"
              title="Marcar como zerado"
            >
              <CheckCircle2 size={14} />
            </button>
          )}
          <button onClick={(e) => { e.stopPropagation(); onEdit(); }} style={iconBtnStyle} aria-label="Editar" title="Editar"><Pencil size={14} /></button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            style={isConfirmingDelete ? { ...iconBtnStyle, background: "#FF5A36", borderColor: "#FF5A36", color: "#0E0E10" } : iconBtnStyle}
            aria-label={isConfirmingDelete ? "Clique de novo para confirmar" : "Remover"}
            title={isConfirmingDelete ? "Clique de novo pra confirmar" : "Remover"}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      <div style={{ height: "3px", background: "#2A2A2E" }}>
        <div style={{ width: `${pct ?? 0}%`, height: "100%", background: is100 ? "#D7FF3A" : "#F2F2EE" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px" }}>
        <span className="cart-titulo" style={{ fontSize: "14px", fontWeight: 700, fontStretch: "85%", lineHeight: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={game.title}>
          {game.title}
        </span>
        {pct !== null && (
          <span style={{ fontSize: "13px", fontWeight: 700, color: is100 ? "#D7FF3A" : "#F2F2EE", flexShrink: 0 }}>{pct}%</span>
        )}
      </div>
      <span className="so-desktop" style={{ fontSize: "12px", color: "#A2A2A8", marginTop: "-6px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {platform.label}
        {" · "}
        {points.total > 0 ? `${points.earned.toLocaleString("pt-BR")} pts` : <span style={{ color: status.color }}>{status.label}</span>}
      </span>
    </article>
  );
}

const RARA_PCT = 5;

const formatPct = (n) => `${Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;

function DetailModal({ game, onClose, onEdit, achText, setAchText, achError, onAddBulk, onToggle, onRemove, onCompleteAll, onUncompleteAll, onDeleteAll, onAddSingle }) {
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [singleName, setSingleName] = useState("");
  const [singleDesc, setSingleDesc] = useState("");
  const [singlePoints, setSinglePoints] = useState("");
  const [singleDlc, setSingleDlc] = useState("");
  const [lightboxIndex, setLightboxIndex] = useState(null);
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const [ordem, setOrdem] = useState("jogo"); // jogo | raras | data
  const [gerenciar, setGerenciar] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const platform = platformOf(game.platform);
  const status = statusOf(game.status);
  const achievements = game.achievements || [];
  const dlcOptions = [...new Set(achievements.map((a) => a.dlc).filter(Boolean))];
  const done = achievements.filter((a) => a.done).length;
  const aggPoints = gamePoints(game);
  const pct = gamePct(game);
  const is100 = game.status === "100" || pct === 100;
  const temRaridade = achievements.some((a) => typeof a.rarity === "number");
  const rarasFeitas = achievements.filter((a) => a.done && typeof a.rarity === "number" && a.rarity < RARA_PCT).length;

  const submitSingle = () => {
    if (!singleName.trim()) return;
    onAddSingle({ name: singleName, description: singleDesc, points: singlePoints, dlc: singleDlc });
    setSingleName("");
    setSingleDesc("");
    setSinglePoints("");
    setSingleDlc("");
  };

  // Se o lightbox de screenshot estiver aberto, ESC fecha só ele — e impede
  // (via stopImmediatePropagation) que o mesmo ESC também feche o detalhe
  // por trás, já que os dois listeners ficam no document.
  useEffect(() => {
    if (lightboxIndex === null) return;
    const handleEscape = (e) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      setLightboxIndex(null);
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [lightboxIndex]);

  // "Ordem do jogo" agrupa por DLC (jogo base primeiro); as outras ordens são uma lista só.
  const grupos = (() => {
    if (ordem === "raras") {
      const lista = [...achievements].sort((a, b) => (a.rarity ?? 101) - (b.rarity ?? 101));
      return [{ key: "", items: lista }];
    }
    if (ordem === "data") {
      const lista = [...achievements].sort((a, b) => {
        if (a.done !== b.done) return a.done ? -1 : 1;
        return (b.doneAt || "").localeCompare(a.doneAt || "");
      });
      return [{ key: "", items: lista }];
    }
    const order = [];
    const map = {};
    achievements.forEach((a) => {
      const key = a.dlc || "";
      if (!map[key]) {
        map[key] = [];
        order.push(key);
      }
      map[key].push(a);
    });
    order.sort((x, y) => (x === "" ? -1 : y === "" ? 1 : 0));
    return order.map((key) => ({ key, items: map[key] }));
  })();

  const ordemBtn = (id, label) => (
    <Chip key={id} active={ordem === id} onClick={() => setOrdem(id)} label={label} />
  );

  return (
    <div role="dialog" aria-modal="true" aria-label={game.title} style={{ position: "fixed", inset: 0, background: "#0E0E10", zIndex: 45, overflowY: "auto", color: "#F2F2EE", fontFamily: "'Archivo', sans-serif" }}>
      <div className="detalhe-wrap">
        <header className="placar-head">
          <button onClick={onClose} className="placar-btn" style={{ background: "none", border: "none", color: "#A2A2A8", padding: 0 }}>
            <ChevronLeft size={18} /> Biblioteca
          </button>
          <span className="placar-marca so-desktop" style={{ fontSize: "26px" }}>Estante</span>
          <button onClick={onEdit} className="placar-btn" style={{ background: "transparent", color: "#F2F2EE", border: "1px solid #3A3A40" }}>
            <Pencil size={15} /> Editar
          </button>
        </header>

        <section className="detalhe-topo">
          <div className="detalhe-capa" style={{ position: "relative", aspectRatio: "2 / 3", background: "#1C1C20", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {game.cover && !imgFailed ? (
              <img src={displayCoverUrl(game.cover)} alt={`Capa de ${game.title}`} onError={() => setImgFailed(true)} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            ) : (
              <Gamepad2 size={32} color="#55555C" />
            )}
            {is100 && (
              <span style={{ position: "absolute", top: 0, left: 0, background: "#D7FF3A", color: "#0E0E10", fontSize: "14px", fontWeight: 900, fontStretch: "75%", padding: "6px 10px", letterSpacing: "0.04em" }}>100%</span>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "24px", minWidth: 0 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <span className="placar-label">
                {platform.label} · <span style={{ color: status.color }}>{status.label}</span>
                {game.completedAt && isCompletedStatus(game.status) && <> · concluído em {formatDate(game.completedAt)}</>}
                {game.startedAt && game.status === "jogando" && <> · desde {formatDate(game.startedAt)}</>}
              </span>
              <h1 className="detalhe-titulo">{game.title}</h1>
            </div>
          </div>
          <div className="detalhe-stats">
            <div>
              <span className="placar-label">Conquistas</span>
              <span className="placar-num detalhe-num">
                {achievements.length > 0 ? done : "—"}
                {achievements.length > 0 && <span className="detalhe-num-sub"> / {achievements.length}</span>}
              </span>
            </div>
            <div>
              <span className="placar-label">Pontos</span>
              <span className="placar-num detalhe-num">
                {aggPoints.total > 0 ? aggPoints.earned.toLocaleString("pt-BR") : "—"}
                {aggPoints.total > 0 && aggPoints.earned !== aggPoints.total && <span className="detalhe-num-sub"> / {aggPoints.total.toLocaleString("pt-BR")}</span>}
              </span>
            </div>
            <div>
              <span className="placar-label">{temRaridade ? `Raras · menos de ${RARA_PCT}%` : "Progresso"}</span>
              <span className="placar-num detalhe-num" style={{ color: "#D7FF3A" }}>
                {temRaridade ? rarasFeitas : pct !== null ? `${pct}%` : "—"}
              </span>
            </div>
          </div>
        </section>

        {game.notes && (
          <p style={{ fontSize: "14px", color: "#C8C8CE", lineHeight: 1.6, margin: "0 0 24px", maxWidth: "720px" }}>{game.notes}</p>
        )}

        {achievements.length === 0 && aggPoints.total > 0 && (
          <p style={{ fontSize: "14px", color: "#A2A2A8", lineHeight: 1.6, margin: "0 0 24px" }}>
            Só o total de pontos foi importado para este jogo. Sincronize com a Steam ou adicione as conquistas em "Gerenciar conquistas" para ver a lista.
          </p>
        )}

        <div className="placar-filtros" style={{ marginBottom: "8px" }}>
          <div className="placar-chips">
            {achievements.length > 0 && ordemBtn("jogo", "Ordem do jogo")}
            {achievements.length > 0 && temRaridade && ordemBtn("raras", "Mais raras primeiro")}
            {achievements.length > 0 && ordemBtn("data", "Data de desbloqueio")}
          </div>
          <Chip active={gerenciar} onClick={() => setGerenciar((g) => !g)} label="Gerenciar conquistas" />
        </div>
        {temRaridade && (
          <p className="so-desktop" style={{ fontSize: "12px", color: "#8A8A90", margin: "0 0 8px" }}>
            Raridade = % dos jogadores da Steam que têm a conquista.
          </p>
        )}

        {achievements.length > 0 && (
          <section style={{ display: "flex", flexDirection: "column", marginBottom: "32px" }}>
            {grupos.map(({ key, items }) => {
              const doneCount = items.filter((a) => a.done).length;
              const isCollapsed = !!collapsedGroups[key];
              return (
                <div key={key || "__base__"}>
                  {grupos.length > 1 && (
                    <button
                      onClick={() => setCollapsedGroups((s) => ({ ...s, [key]: !s[key] }))}
                      aria-expanded={!isCollapsed}
                      style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", background: "none", border: "none", borderBottom: "1px solid #2A2A2E", color: "#F2F2EE", padding: "18px 0 10px", cursor: "pointer", fontFamily: "inherit" }}
                    >
                      <span style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                        <ChevronDown size={14} style={{ transform: isCollapsed ? "rotate(-90deg)" : "none", transition: "transform 0.15s ease" }} />
                        {key || "Jogo base"}
                      </span>
                      <span style={{ fontSize: "13px", fontWeight: 700, color: "#A2A2A8" }}>{doneCount}/{items.length}</span>
                    </button>
                  )}
                  {!isCollapsed && items.map((a, i) => (
                    <div key={a.id} className="detalhe-linha" onClick={() => !gerenciar && onToggle(a.id)}>
                      <span style={{ width: "100%", aspectRatio: "1", background: "#1C1C20", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                        {a.icon ? (
                          <img src={a.icon} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", opacity: a.done ? 1 : 0.35, filter: a.done ? "none" : "grayscale(1)" }} />
                        ) : (
                          <span style={{ fontSize: "16px", fontWeight: 800, fontStretch: "70%", color: "#8A8A90" }}>{String(i + 1).padStart(2, "0")}</span>
                        )}
                      </span>
                      <div style={{ display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 }}>
                        <span style={{ fontSize: "16px", fontWeight: 700, fontStretch: "85%", color: a.done ? "#F2F2EE" : "#A2A2A8" }}>{a.name}</span>
                        {a.description && <span style={{ fontSize: "13px", color: "#8A8A90", lineHeight: 1.4 }}>{a.description}</span>}
                        {a.done && a.doneAt && <span style={{ fontSize: "12px", color: "#A2A2A8" }}>desbloqueada em {formatDate(a.doneAt)}</span>}
                      </div>
                      <div className="detalhe-raridade" style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                        {typeof a.rarity === "number" && (
                          <>
                            <div style={{ flex: 1, height: "3px", background: "#2A2A2E" }}>
                              <div style={{ width: `${Math.max(a.rarity, 1)}%`, height: "100%", background: a.rarity < RARA_PCT ? "#D7FF3A" : "#F2F2EE" }} />
                            </div>
                            <span style={{ fontSize: "13px", fontWeight: 700, width: "56px", textAlign: "right", color: a.rarity < RARA_PCT ? "#D7FF3A" : "#F2F2EE" }}>{formatPct(a.rarity)}</span>
                          </>
                        )}
                      </div>
                      <span className="detalhe-pontos" style={{ fontSize: "14px", fontWeight: 700, textAlign: "right", color: a.done ? "#F2F2EE" : "#8A8A90" }}>
                        {a.points > 0 ? `${a.points} pts` : ""}
                      </span>
                      {gerenciar ? (
                        <button
                          onClick={(e) => { e.stopPropagation(); onRemove(a.id); }}
                          style={{ ...iconBtnStyle, width: "44px", height: "44px", color: "#FF7A5C" }}
                          aria-label={`Remover a conquista ${a.name}`}
                        >
                          <Trash2 size={16} />
                        </button>
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); onToggle(a.id); }}
                          aria-pressed={a.done}
                          aria-label={a.done ? `Desmarcar ${a.name}` : `Marcar ${a.name} como feita`}
                          style={{ width: "44px", height: "44px", background: a.done ? "#D7FF3A" : "transparent", border: a.done ? "none" : "1px solid #3A3A40", color: "#0E0E10", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
                        >
                          {a.done && <Check size={20} strokeWidth={3} />}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
          </section>
        )}

        {gerenciar && (
          <section style={{ border: "1px solid #2A2A2E", padding: "20px", marginBottom: "32px", display: "flex", flexDirection: "column", gap: "18px" }}>
            {achievements.length > 0 && (
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <button onClick={onCompleteAll} className="placar-btn" style={{ background: "#D7FF3A", color: "#0E0E10", border: "none" }}>Marcar todas como feitas</button>
                <button onClick={onUncompleteAll} className="placar-btn" style={{ background: "transparent", color: "#F2F2EE", border: "1px solid #3A3A40" }}>Desmarcar todas</button>
                <button
                  onClick={() => {
                    if (confirmDeleteAll) {
                      onDeleteAll();
                      setConfirmDeleteAll(false);
                    } else {
                      setConfirmDeleteAll(true);
                      setTimeout(() => setConfirmDeleteAll(false), 3000);
                    }
                  }}
                  className="placar-btn"
                  style={{ background: confirmDeleteAll ? "#FF5A36" : "transparent", color: confirmDeleteAll ? "#0E0E10" : "#FF7A5C", border: "1px solid #FF5A36" }}
                >
                  {confirmDeleteAll ? "Clique de novo pra confirmar" : "Apagar todas"}
                </button>
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <span className="placar-label">Adicionar uma conquista</span>
              <input value={singleName} onChange={(e) => setSingleName(e.target.value)} placeholder="Nome da conquista" aria-label="Nome da conquista" style={inputStyle} />
              <input value={singleDesc} onChange={(e) => setSingleDesc(e.target.value)} placeholder="Descrição (opcional)" aria-label="Descrição" style={inputStyle} />
              <div style={{ display: "flex", gap: "8px" }}>
                <input type="number" value={singlePoints} onChange={(e) => setSinglePoints(e.target.value)} placeholder="Pontos" aria-label="Pontos" style={{ ...inputStyle, width: "100px" }} />
                <input
                  value={singleDlc}
                  onChange={(e) => setSingleDlc(e.target.value)}
                  placeholder="DLC (opcional — em branco pro jogo base)"
                  aria-label="DLC"
                  list="dlc-options"
                  style={{ ...inputStyle, flex: 1 }}
                />
                <datalist id="dlc-options">
                  {dlcOptions.map((d) => <option key={d} value={d} />)}
                </datalist>
              </div>
              <button onClick={submitSingle} disabled={!singleName.trim()} className="placar-btn" style={{ alignSelf: "flex-start", background: singleName.trim() ? "#D7FF3A" : "#2A2A2E", color: singleName.trim() ? "#0E0E10" : "#8A8A90", border: "none", cursor: singleName.trim() ? "pointer" : "default" }}>
                Adicionar
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              <label htmlFor="ach-lote" className="placar-label">Adicionar várias</label>
              <span style={{ fontSize: "12px", color: "#8A8A90", lineHeight: 1.5 }}>
                Uma por linha: "Nome; Descrição; Pontos; DLC; Desbloqueada". Os quatro últimos são opcionais. No último, use uma data AAAA-MM-DD ou "sim" pra já marcar como feita.
              </span>
              <textarea
                id="ach-lote"
                value={achText}
                onChange={(e) => setAchText(e.target.value)}
                placeholder={"Primeiros passos; Complete o capítulo 1; 10;; sim\nMestre da espada;;;Expansão X;2024-03-12"}
                rows={4}
                style={{ ...inputStyle, resize: "vertical" }}
              />
              {achError && <p style={{ color: "#FF7A5C", fontSize: "12px", margin: 0 }}>{achError}</p>}
              <button onClick={onAddBulk} className="placar-btn" style={{ alignSelf: "flex-start", background: "#D7FF3A", color: "#0E0E10", border: "none" }}>
                Adicionar à lista
              </button>
            </div>
          </section>
        )}

        {game.metadata?.source && (
          <section style={{ borderTop: "1px solid #2A2A2E", paddingTop: "24px", marginBottom: "24px", display: "flex", flexDirection: "column", gap: "12px", maxWidth: "820px" }}>
            <span className="placar-label">Sobre o jogo</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", fontSize: "13px", color: "#A2A2A8" }}>
              {game.metadata.releaseYear && <strong style={{ color: "#F2F2EE" }}>{game.metadata.releaseYear}</strong>}
              {game.metadata.developer && <span>{game.metadata.developer}</span>}
              {game.metadata.publisher && game.metadata.publisher !== game.metadata.developer && <span>{game.metadata.publisher}</span>}
              {typeof game.metadata.rating === "number" && <span>nota {game.metadata.rating.toFixed(1)}</span>}
              {Array.isArray(game.metadata.genres) && game.metadata.genres.length > 0 && <span>{game.metadata.genres.join(" · ")}</span>}
            </div>
            {game.metadata.summary && <p style={{ fontSize: "14px", color: "#C8C8CE", lineHeight: 1.6, margin: 0 }}>{game.metadata.summary}</p>}
          </section>
        )}

        {Array.isArray(game.metadata?.screenshots) && game.metadata.screenshots.length > 0 && (
          <div style={{ display: "flex", gap: "8px", overflowX: "auto", paddingBottom: "4px" }}>
            {game.metadata.screenshots.map((url, i) => (
              <button key={i} onClick={() => setLightboxIndex(i)} aria-label={`Ampliar screenshot ${i + 1}`} style={{ padding: 0, border: "none", background: "none", cursor: "pointer", flexShrink: 0 }}>
                <img src={displayCoverUrl(url)} alt="" loading="lazy" style={{ width: "200px", height: "112px", objectFit: "cover", display: "block" }} />
              </button>
            ))}
          </div>
        )}

        {lightboxIndex !== null && Array.isArray(game.metadata?.screenshots) && (
          <div
            onClick={() => setLightboxIndex(null)}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.9)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60, padding: "24px" }}
          >
            <button onClick={(e) => { e.stopPropagation(); setLightboxIndex(null); }} style={{ ...iconBtnStyle, position: "absolute", top: "18px", right: "18px", width: "44px", height: "44px" }} aria-label="Fechar">
              <X size={18} />
            </button>
            {game.metadata.screenshots.length > 1 && (
              <button
                onClick={(e) => { e.stopPropagation(); setLightboxIndex((i) => (i - 1 + game.metadata.screenshots.length) % game.metadata.screenshots.length); }}
                style={{ ...iconBtnStyle, position: "absolute", left: "18px", top: "50%", transform: "translateY(-50%)", width: "44px", height: "44px" }}
                aria-label="Anterior"
              >
                <ChevronLeft size={20} />
              </button>
            )}
            <img
              src={displayCoverUrl(game.metadata.screenshots[lightboxIndex])}
              alt={`Screenshot ${lightboxIndex + 1} de ${game.title}`}
              onClick={(e) => e.stopPropagation()}
              style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
            />
            {game.metadata.screenshots.length > 1 && (
              <button
                onClick={(e) => { e.stopPropagation(); setLightboxIndex((i) => (i + 1) % game.metadata.screenshots.length); }}
                style={{ ...iconBtnStyle, position: "absolute", right: "18px", top: "50%", transform: "translateY(-50%)", width: "44px", height: "44px" }}
                aria-label="Próximo"
              >
                <ChevronRight size={20} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const iconBtnStyle = {
  background: "#0E0E10e6", border: "1px solid #3A3A40", borderRadius: 0, width: "32px", height: "32px", display: "flex", alignItems: "center", justifyContent: "center", color: "#F2F2EE", cursor: "pointer",
};

function EmptyState({ hasGames, onAdd }) {
  return (
    <div style={{ textAlign: "center", padding: "60px 20px", border: "1px dashed #2A2A2E", borderRadius: 0 }}>
      <Gamepad2 size={28} color="#8A8A90" style={{ marginBottom: "10px" }} />
      <p style={{ fontFamily: "'Archivo', sans-serif", fontWeight: 600, fontSize: "15px", margin: "0 0 4px" }}>
        {hasGames ? "Nenhum jogo bate com esse filtro" : "A estante tá vazia"}
      </p>
      <p style={{ fontSize: "12px", color: "#A2A2A8", margin: "0 0 16px" }}>
        {hasGames ? "Tenta limpar os filtros ou a busca." : "Comece adicionando o primeiro jogo que você zerou ou platinou."}
      </p>
      {!hasGames && (
        <button onClick={onAdd} style={{ display: "inline-flex", alignItems: "center", gap: "6px", background: "#D7FF3A", color: "#0E0E10", border: "none", padding: "9px 14px", borderRadius: 0, fontWeight: 600, fontSize: "13px", cursor: "pointer" }}>
          <Plus size={15} /> Adicionar jogo
        </button>
      )}
    </div>
  );
}
