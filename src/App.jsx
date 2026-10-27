import { useState, useEffect, useMemo, useRef } from "react";
import { Trophy, CheckCircle2, Play, Archive, Plus, X, Pencil, Trash2, Search, Gamepad2, ImageUp, FileUp, Download, Images, Upload, Clock, LogOut, Lock, Wrench, ChevronDown } from "lucide-react";

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
  { id: "100", label: "100%", color: "#E8A33D", dark: "#static", Icon: Trophy },
  { id: "zerado", label: "Zerado", color: "#4FD1C5", Icon: CheckCircle2 },
  { id: "jogando", label: "Jogando", color: "#8B7FD1", Icon: Play },
  { id: "backlog", label: "Backlog", color: "#6B6960", Icon: Archive },
  { id: "historico", label: "Histórico", color: "#8A8783", Icon: Clock },
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
  const [showAutoCover, setShowAutoCover] = useState(false);
  const [autoCoverBusy, setAutoCoverBusy] = useState(false);
  const [autoCoverDone, setAutoCoverDone] = useState(false);
  const [autoCoverProgress, setAutoCoverProgress] = useState({ current: 0, total: 0, found: 0, notFound: 0 });

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
    const existingById = new Map(games.map((g) => [g.id, g]));
    const mergedFull = (() => {
      const map = new Map(existingById);
      gamesToSave.forEach((g) => map.set(g.id, g));
      return Array.from(map.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    })();

    let ok = true;
    try {
      await sbUpsertGames(session.access_token, gamesToSave.map(gameToRow));
    } catch (e) {
      console.error("Falha ao salvar no Supabase", e);
      ok = false;
    }

    setGames(mergedFull);
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
  // detalhe do jogo > formulário de novo/editar jogo > import em lote > lote de capas > busca automática.
  // Só um desses costuma estar aberto por vez, mas a ordem garante um comportamento
  // previsível caso mais de um esteja (o "mais em cima" fecha primeiro).
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key !== "Escape") return;
      if (detailGameId) {
        closeDetail();
      } else if (showForm) {
        closeForm();
      } else if (showBulk) {
        closeBulk();
      } else if (showCoverBatch) {
        closeCoverBatch();
      } else if (showAutoCover) {
        closeAutoCover();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [detailGameId, showForm, showBulk, showCoverBatch, showAutoCover]);

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
      <div style={{ fontFamily: "'Inter', sans-serif", background: "#15141B", minHeight: "300px", borderRadius: "16px", display: "flex", alignItems: "center", justifyContent: "center", color: "#6B6960", fontSize: "13px" }}>
        carregando...
      </div>
    );
  }

  if (!session) {
    return (
      <div style={{ fontFamily: "'Inter', sans-serif", background: "#15141B", minHeight: "500px", padding: "28px 24px", color: "#EDEAE0", borderRadius: "16px", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=Inter:wght@400;500;600&display=swap');`}</style>
        <form onSubmit={handleLogin} style={{ width: "100%", maxWidth: "320px", background: "#1E1D26", border: "1px solid #2E2C36", borderRadius: "14px", padding: "28px 24px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <Lock size={16} color="#E4536B" />
            <h1 style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: "18px", margin: 0 }}>Estante de Conquistas</h1>
          </div>
          <p style={{ color: "#9C9A93", fontSize: "12px", margin: "4px 0 20px" }}>Faça login pra acessar sua estante</p>
          <label style={{ display: "block", fontSize: "12px", color: "#9C9A93", marginBottom: "6px" }}>Email</label>
          <input
            type="email"
            value={loginEmail}
            onChange={(e) => setLoginEmail(e.target.value)}
            required
            style={{ ...inputStyle, marginBottom: "12px" }}
          />
          <label style={{ display: "block", fontSize: "12px", color: "#9C9A93", marginBottom: "6px" }}>Senha</label>
          <input
            type="password"
            value={loginPassword}
            onChange={(e) => setLoginPassword(e.target.value)}
            required
            style={{ ...inputStyle, marginBottom: "16px" }}
          />
          {loginError && <p style={{ color: "#E4536B", fontSize: "12px", margin: "0 0 14px" }}>{loginError}</p>}
          <button
            type="submit"
            disabled={loginBusy}
            style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "none", background: loginBusy ? "#3A3844" : "#E4536B", color: loginBusy ? "#6B6960" : "#2A0F16", cursor: loginBusy ? "default" : "pointer", fontSize: "13px", fontWeight: 600 }}
          >
            {loginBusy ? "entrando..." : "Entrar"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "'Inter', sans-serif", background: "#15141B", minHeight: "600px", padding: "28px 24px", color: "#EDEAE0", borderRadius: "16px" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;600&display=swap');
        .shelf-scroll::-webkit-scrollbar { height: 6px; }
        .shelf-chip { transition: all 0.15s ease; cursor: pointer; }
        .shelf-chip:hover { filter: brightness(1.15); }
        .cart-card { transition: transform 0.12s ease, border-color 0.12s ease; }
        .cart-card:hover { transform: translateY(-3px); }
        .cart-actions { opacity: 0; transition: opacity 0.15s ease; }
        .cart-card:hover .cart-actions { opacity: 1; }
        input, textarea, select { font-family: 'Inter', sans-serif; }
      `}</style>

      {restoreResult && (
        <div
          style={{
            background: restoreResult.error ? "#E4536B22" : "#4FD1C522",
            border: `1px solid ${restoreResult.error ? "#E4536B" : "#4FD1C5"}`,
            borderRadius: "10px",
            padding: "10px 14px",
            marginBottom: "18px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: "12.5px", color: restoreResult.error ? "#F2B8C2" : "#B7EFE7" }}>
            {restoreResult.error
              ? `⚠️ ${restoreResult.error}`
              : `✅ ${restoreResult.count} jogo(s) restaurado(s)${restoreResult.ok ? "" : " — mas algo pode não ter salvo, tenta de novo se sumir"}.`}
          </span>
          <button
            onClick={() => setRestoreResult(null)}
            style={{ background: "none", border: "1px solid currentColor", color: "inherit", borderRadius: "6px", padding: "4px 10px", fontSize: "11px", cursor: "pointer", flexShrink: 0 }}
          >
            ok
          </button>
        </div>
      )}

      {saveWarning && (
        <div style={{ background: "#E4536B22", border: "1px solid #E4536B", borderRadius: "10px", padding: "10px 14px", marginBottom: "18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
          <span style={{ fontSize: "12.5px", color: "#F2B8C2" }}>
            ⚠️ A última alteração pode não ter sido salva de verdade. Não feche esta aba ainda.
          </span>
          <button
            onClick={retrySaveIndex}
            style={{ background: "#E4536B", color: "#2A0F16", border: "none", borderRadius: "6px", padding: "6px 12px", fontSize: "12px", fontWeight: 600, cursor: "pointer", flexShrink: 0 }}
          >
            Tentar salvar de novo
          </button>
        </div>
      )}

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "16px", marginBottom: "24px" }}>
        <div>
          <h1 style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: "26px", margin: 0, letterSpacing: "-0.02em" }}>
            Estante de Conquistas
          </h1>
          <p style={{ color: "#9C9A93", fontSize: "13px", margin: "4px 0 0" }}>
            catálogo pessoal — Switch 2 e o que sobrou do resto
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <div style={{ position: "relative" }}>
            <button
              onClick={() => setShowToolsMenu((s) => !s)}
              style={{ display: "flex", alignItems: "center", gap: "6px", background: showToolsMenu ? "#2E2C36" : "transparent", color: "#EDEAE0", border: "1px solid #2E2C36", padding: "10px 14px", borderRadius: "10px", fontWeight: 500, fontSize: "14px", cursor: "pointer" }}
            >
              <Wrench size={16} /> Ferramentas
            </button>
            {showToolsMenu && (
              <>
                <div onClick={() => setShowToolsMenu(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
                <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, background: "#1E1D26", border: "1px solid #2E2C36", borderRadius: "10px", padding: "6px", display: "flex", flexDirection: "column", gap: "2px", zIndex: 41, minWidth: "200px", boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
                  <button
                    onClick={() => { exportData(); setShowToolsMenu(false); }}
                    disabled={games.length === 0}
                    title="Baixa um arquivo com todos os jogos e capas, útil como backup ou para migrar no futuro"
                    style={{ display: "flex", alignItems: "center", gap: "8px", background: "none", color: games.length === 0 ? "#4A4845" : "#EDEAE0", border: "none", padding: "9px 10px", borderRadius: "7px", fontWeight: 500, fontSize: "13px", cursor: games.length === 0 ? "default" : "pointer", textAlign: "left" }}
                  >
                    <Download size={15} /> Exportar
                  </button>
                  <label
                    title="Restaura jogos, capas e conquistas a partir de um arquivo de backup exportado anteriormente"
                    style={{ display: "flex", alignItems: "center", gap: "8px", background: "none", color: "#EDEAE0", border: "none", padding: "9px 10px", borderRadius: "7px", fontWeight: 500, fontSize: "13px", cursor: restoreBusy ? "default" : "pointer", opacity: restoreBusy ? 0.6 : 1 }}
                  >
                    <Upload size={15} /> {restoreBusy ? "restaurando..." : "Restaurar backup"}
                    <input
                      type="file"
                      accept=".json,application/json"
                      onChange={(e) => { handleRestoreFile(e); setShowToolsMenu(false); }}
                      disabled={restoreBusy}
                      style={{ display: "none" }}
                    />
                  </label>
                  <button
                    onClick={() => { setShowBulk(true); setShowToolsMenu(false); }}
                    style={{ display: "flex", alignItems: "center", gap: "8px", background: "none", color: "#EDEAE0", border: "none", padding: "9px 10px", borderRadius: "7px", fontWeight: 500, fontSize: "13px", cursor: "pointer", textAlign: "left" }}
                  >
                    <FileUp size={15} /> Importar em lote
                  </button>
                  <button
                    onClick={() => { setShowCoverBatch(true); setShowToolsMenu(false); }}
                    disabled={games.length === 0}
                    style={{ display: "flex", alignItems: "center", gap: "8px", background: "none", color: games.length === 0 ? "#4A4845" : "#EDEAE0", border: "none", padding: "9px 10px", borderRadius: "7px", fontWeight: 500, fontSize: "13px", cursor: games.length === 0 ? "default" : "pointer", textAlign: "left" }}
                  >
                    <Images size={15} /> Várias capas
                  </button>
                  <button
                    onClick={() => { setShowAutoCover(true); setShowToolsMenu(false); }}
                    disabled={games.filter((g) => !g.cover).length === 0}
                    title="Busca automaticamente no IGDB e aplica a primeira opção encontrada pra cada jogo sem capa"
                    style={{ display: "flex", alignItems: "center", gap: "8px", background: "none", color: games.filter((g) => !g.cover).length === 0 ? "#4A4845" : "#EDEAE0", border: "none", padding: "9px 10px", borderRadius: "7px", fontWeight: 500, fontSize: "13px", cursor: games.filter((g) => !g.cover).length === 0 ? "default" : "pointer", textAlign: "left" }}
                  >
                    <Search size={15} /> Buscar capas automáticas
                  </button>
                </div>
              </>
            )}
          </div>
          <button
            onClick={openAdd}
            style={{ display: "flex", alignItems: "center", gap: "6px", background: "#E4536B", color: "#2A0F16", border: "none", padding: "10px 16px", borderRadius: "10px", fontWeight: 600, fontSize: "14px", cursor: "pointer" }}
          >
            <Plus size={16} /> Adicionar jogo
          </button>
          <button
            onClick={handleLogout}
            title="Sair"
            style={{ display: "flex", alignItems: "center", gap: "6px", background: "transparent", color: "#6B6960", border: "1px solid #2E2C36", padding: "10px 12px", borderRadius: "10px", fontWeight: 500, fontSize: "14px", cursor: "pointer" }}
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>

      {loading ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: "10px", marginBottom: "22px" }}>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} style={{ background: "#1E1D26", borderRadius: "10px", padding: "10px 12px", border: "1px solid #2E2C36", height: "52px" }} />
            ))}
          </div>
          <div style={{ padding: "70px 0", textAlign: "center", color: "#6B6960", fontSize: "13px" }}>Carregando estante...</div>
        </>
      ) : (
        <>
          {/* Stats */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: "10px", marginBottom: "22px" }}>
            <StatCard label="na estante" value={counts.total} color="#EDEAE0" />
            <StatCard label="100%" value={counts["100"] || 0} color="#E8A33D" Icon={Trophy} />
            <StatCard label="zerados" value={counts.zerado || 0} color="#4FD1C5" Icon={CheckCircle2} />
            <StatCard label="jogando" value={counts.jogando || 0} color="#8B7FD1" Icon={Play} />
            <StatCard label="backlog" value={counts.backlog || 0} color="#6B6960" Icon={Archive} />
            {counts.historico > 0 && <StatCard label="histórico" value={counts.historico} color="#8A8783" Icon={Clock} />}
          </div>

          {/* Points profile */}
          {pointsStats.totalPossible > 0 && (
            <div style={{ background: "#1E1D26", border: "1px solid #2E2C36", borderRadius: "10px", padding: "12px 16px", marginBottom: "22px" }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: "8px", marginBottom: pointsStats.byPlatform && Object.keys(pointsStats.byPlatform).length > 0 ? "8px" : 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <Trophy size={13} color="#8B7FD1" />
                  <span style={{ fontSize: "11.5px", color: "#9C9A93" }}>Pontuação do perfil</span>
                </div>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "16px", fontWeight: 700, color: "#8B7FD1" }}>
                  {pointsStats.totalEarned.toLocaleString("pt-BR")} <span style={{ fontSize: "11px", color: "#6B6960", fontWeight: 500 }}>/ {pointsStats.totalPossible.toLocaleString("pt-BR")} pts</span>
                </span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {FILTER_PLATFORMS.filter((p) => pointsStats.byPlatform[p.id]).map((p) => (
                  <div key={p.id} style={{ display: "flex", alignItems: "center", gap: "5px", background: "#15141B", borderRadius: "6px", padding: "4px 9px" }}>
                    <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: p.color, display: "inline-block" }} />
                    <span style={{ fontSize: "10.5px", color: "#9C9A93" }}>{p.label}</span>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "10.5px", color: "#B7C4CF" }}>
                      {pointsStats.byPlatform[p.id].earned.toLocaleString("pt-BR")}/{pointsStats.byPlatform[p.id].possible.toLocaleString("pt-BR")}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Filters */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "10px" }}>
            <Chip active={filterPlatform === "all"} onClick={() => setFilterPlatform("all")} label="Todas plataformas" />
            {FILTER_PLATFORMS.map((p) => (
              <Chip key={p.id} active={filterPlatform === p.id} onClick={() => setFilterPlatform(p.id)} label={p.label} dot={p.color} />
            ))}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "16px", alignItems: "center" }}>
            <Chip active={filterStatus === "all"} onClick={() => setFilterStatus("all")} label="Todos status" />
            {STATUSES.map((s) => (
              <Chip key={s.id} active={filterStatus === s.id} onClick={() => setFilterStatus(s.id)} label={s.label} dot={s.color} />
            ))}
            <div style={{ marginLeft: "auto", position: "relative" }}>
              <Search size={14} style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)", color: "#6B6960" }} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar jogo..."
                style={{ background: "#1E1D26", border: "1px solid #2E2C36", borderRadius: "8px", padding: "8px 10px 8px 30px", fontSize: "13px", color: "#EDEAE0", outline: "none", width: "170px" }}
              />
            </div>
          </div>

          {/* Grid */}
          {filtered.length === 0 ? (
            <EmptyState hasGames={games.length > 0} onAdd={openAdd} />
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "16px" }}>
          {filtered.map((g) => (
            <GameCard key={g.id} game={g} onEdit={() => openEdit(g)} onDelete={() => removeGame(g.id)} onOpen={() => openDetail(g.id)} onMarkZerado={() => markAsZerado(g)} isConfirmingDelete={confirmDeleteId === g.id} />
          ))}
        </div>
          )}
        </>
      )}

      {/* Bulk import modal */}
      {showBulk && (
        <div onClick={closeBulk} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: "16px" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#1E1D26", borderRadius: "14px", padding: "22px", width: "100%", maxWidth: "440px", border: "1px solid #2E2C36" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
              <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "17px", margin: 0, fontWeight: 600 }}>
                Importar em lote
              </h2>
              <button onClick={closeBulk} style={{ background: "none", border: "none", color: "#9C9A93", cursor: "pointer", padding: "2px" }}>
                <X size={18} />
              </button>
            </div>

            <p style={{ fontSize: "12px", color: "#9C9A93", lineHeight: 1.5, margin: "0 0 10px" }}>
              Um jogo por linha, campos separados por ponto e vírgula:<br />
              <span style={{ color: "#EDEAE0" }}>Título; Plataforma; Status; Data(AAAA-MM-DD); Notas; Link da capa</span><br />
              Só o título é obrigatório. Campos em branco não apagam o que já existe — útil pra atualizar só a capa de jogos que já estão na estante.
            </p>
            <div style={{ background: "#15141B", border: "1px solid #2E2C36", borderRadius: "8px", padding: "8px 10px", fontSize: "11px", color: "#6B6960", marginBottom: "12px", fontFamily: "'JetBrains Mono', monospace" }}>
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
              style={{ ...inputStyle, resize: "vertical", fontFamily: "'JetBrains Mono', monospace", fontSize: "12px", marginBottom: "10px" }}
            />

            {bulkResult && (
              <div style={{ marginBottom: "10px", fontSize: "12px" }}>
                {bulkResult.added > 0 && (
                  <p style={{ color: "#4FD1C5", margin: "0 0 4px" }}>{bulkResult.added} jogo(s) novo(s) adicionado(s).</p>
                )}
                {bulkResult.updated > 0 && (
                  <p style={{ color: "#8B7FD1", margin: "0 0 4px" }}>{bulkResult.updated} jogo(s) já existente(s) atualizado(s) (status/data/notas).</p>
                )}
                {bulkResult.errors.length > 0 && (
                  <ul style={{ color: "#E4536B", margin: 0, paddingLeft: "16px" }}>
                    {bulkResult.errors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                )}
              </div>
            )}

            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={closeBulk} style={{ flex: 1, padding: "10px", borderRadius: "8px", border: "1px solid #2E2C36", background: "transparent", color: "#9C9A93", cursor: "pointer", fontSize: "13px", fontWeight: 500 }}>
                Fechar
              </button>
              <button onClick={runBulkImport} disabled={!bulkText.trim()} style={{ flex: 1, padding: "10px", borderRadius: "8px", border: "none", background: bulkText.trim() ? "#E4536B" : "#3A3844", color: bulkText.trim() ? "#2A0F16" : "#6B6960", cursor: bulkText.trim() ? "pointer" : "default", fontSize: "13px", fontWeight: 600 }}>
                Importar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Batch cover matching modal */}
      {showCoverBatch && (
        <div onClick={closeCoverBatch} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: "16px" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#1E1D26", borderRadius: "14px", width: "100%", maxWidth: "520px", border: "1px solid #2E2C36", maxHeight: "85vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "22px 22px 14px", flexShrink: 0 }}>
              <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "17px", margin: 0, fontWeight: 600 }}>Várias capas de uma vez</h2>
              <button onClick={closeCoverBatch} style={{ background: "none", border: "none", color: "#9C9A93", cursor: "pointer", padding: "2px" }}>
                <X size={18} />
              </button>
            </div>

            <div style={{ padding: "0 22px 22px", overflowY: "auto" }}>
              <div
                onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setBatchDragging(true); }}
                onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setBatchDragging(false); }}
                onDrop={handleBatchDrop}
                style={{
                  border: `1.5px dashed ${batchDragging ? "#E4536B" : "#2E2C36"}`, borderRadius: "10px",
                  background: batchDragging ? "#E4536B14" : "transparent", padding: "20px 10px", textAlign: "center", transition: "all 0.12s ease", marginBottom: "16px",
                }}
              >
                <p style={{ fontSize: "12px", color: batchDragging ? "#E4536B" : "#6B6960", margin: "0 0 8px" }}>
                  {batchDragging ? "solta aqui" : "arraste várias imagens aqui de uma vez, ou"}
                </p>
                <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "#EDEAE0", border: "1px solid #2E2C36", borderRadius: "8px", padding: "7px 12px", cursor: "pointer", background: "#15141B" }}>
                  <ImageUp size={13} />
                  escolher várias do computador
                  <input type="file" accept="image/*" multiple onChange={handleBatchFilePick} style={{ display: "none" }} />
                </label>
              </div>

              {coverQueue.length > 0 && (
                <>
                  <p style={{ fontSize: "12px", color: "#9C9A93", margin: "0 0 10px" }}>
                    Pra cada imagem, escolhe o jogo correspondente (já tentei adivinhar pelo nome do arquivo, e pela própria imagem quando o nome não ajudou):
                  </p>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "16px" }}>
                    {coverQueue.map((q) => {
                      const pickerOptions = games
                        .filter((g) => !g.cover || g.id === q.selectedGameId)
                        .slice()
                        .sort((a, b) => a.title.localeCompare(b.title, "pt"));
                      return (
                        <div key={q.tempId} style={{ display: "flex", alignItems: "center", gap: "10px", background: "#15141B", border: "1px solid #2E2C36", borderRadius: "8px", padding: "8px" }}>
                          <img src={q.dataUrl} alt={q.filename} style={{ width: "36px", height: "48px", objectFit: "cover", borderRadius: "4px", flexShrink: 0 }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: "10.5px", color: "#6B6960", marginBottom: "4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.filename}</div>
                            {q.visionPending ? (
                              <div style={{ fontSize: "11px", color: "#8B7FD1", padding: "6px 0" }}>analisando imagem...</div>
                            ) : (
                              <select
                                value={q.selectedGameId}
                                onChange={(e) => setQueueItemGame(q.tempId, e.target.value)}
                                style={{ width: "100%", background: "#1E1D26", border: "1px solid #2E2C36", borderRadius: "6px", padding: "6px 8px", fontSize: "12px", color: "#EDEAE0", outline: "none" }}
                              >
                                <option value="">— escolher jogo —</option>
                                {pickerOptions.map((g) => (
                                  <option key={g.id} value={g.id}>{g.title}</option>
                                ))}
                              </select>
                            )}
                          </div>
                          <button onClick={() => removeQueueItem(q.tempId)} style={{ background: "none", border: "none", color: "#6B6960", cursor: "pointer", padding: "2px", flexShrink: 0 }} aria-label="Remover da fila">
                            <X size={14} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <button
                    onClick={applyCoverBatch}
                    disabled={batchApplying || coverQueue.every((q) => !q.selectedGameId)}
                    style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "none", background: "#E4536B", color: "#2A0F16", cursor: "pointer", fontSize: "13px", fontWeight: 600, opacity: batchApplying ? 0.6 : 1 }}
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
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#1E1D26", borderRadius: "14px", padding: "22px", width: "100%", maxWidth: "380px", border: "1px solid #2E2C36" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
              <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "16px", margin: 0, fontWeight: 600 }}>
                Buscar capas automáticas
              </h2>
              {!autoCoverBusy && (
                <button onClick={closeAutoCover} style={{ background: "none", border: "none", color: "#9C9A93", cursor: "pointer", padding: "2px" }}>
                  <X size={18} />
                </button>
              )}
            </div>

            {!autoCoverBusy && !autoCoverDone && (
              <>
                <p style={{ fontSize: "12.5px", color: "#9C9A93", lineHeight: 1.5, margin: "0 0 16px" }}>
                  Isso vai buscar no IGDB pelo título de cada um dos <strong style={{ color: "#EDEAE0" }}>{games.filter((g) => !g.cover).length} jogos sem capa</strong> e aplicar automaticamente a primeira opção encontrada (capa + ano, gêneros, desenvolvedora, nota e sinopse). Se alguma vier errada, você pode corrigir manualmente depois editando o jogo.
                </p>
                <button
                  onClick={runAutoCoverSearch}
                  style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "none", background: "#E4536B", color: "#2A0F16", cursor: "pointer", fontSize: "13px", fontWeight: 600 }}
                >
                  Iniciar busca ({games.filter((g) => !g.cover).length} jogos)
                </button>
              </>
            )}

            {autoCoverBusy && (
              <>
                <p style={{ fontSize: "12.5px", color: "#9C9A93", margin: "0 0 10px" }}>
                  Buscando... {autoCoverProgress.current}/{autoCoverProgress.total}
                </p>
                <div style={{ height: "6px", background: "#15141B", borderRadius: "4px", overflow: "hidden", marginBottom: "10px" }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${autoCoverProgress.total > 0 ? (autoCoverProgress.current / autoCoverProgress.total) * 100 : 0}%`,
                      background: "#E4536B",
                      borderRadius: "4px",
                      transition: "width 0.2s ease",
                    }}
                  />
                </div>
                <p style={{ fontSize: "11px", color: "#6B6960", margin: 0 }}>
                  {autoCoverProgress.found} encontradas · {autoCoverProgress.notFound} não encontradas
                </p>
              </>
            )}

            {autoCoverDone && (
              <>
                <p style={{ fontSize: "13px", color: "#EDEAE0", margin: "0 0 4px" }}>
                  Busca concluída!
                </p>
                <p style={{ fontSize: "12px", color: "#9C9A93", margin: "0 0 16px" }}>
                  <strong style={{ color: "#4FD1C5" }}>{autoCoverProgress.found}</strong> capas aplicadas · <strong style={{ color: "#9C9A93" }}>{autoCoverProgress.notFound}</strong> não encontradas no IGDB
                </p>
                <button
                  onClick={closeAutoCover}
                  style={{ width: "100%", padding: "10px", borderRadius: "8px", border: "none", background: "#E4536B", color: "#2A0F16", cursor: "pointer", fontSize: "13px", fontWeight: 600 }}
                >
                  Fechar
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Achievement detail modal */}
      {detailGameId && (() => {
        const game = games.find((g) => g.id === detailGameId);
        if (!game) return null;
        return (
          <DetailModal
            game={game}
            onClose={closeDetail}
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
          <div onClick={(e) => e.stopPropagation()} style={{ background: "#1E1D26", borderRadius: "14px", width: "100%", maxWidth: "380px", border: "1px solid #2E2C36", maxHeight: "85vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "22px 22px 16px", flexShrink: 0, background: "#1E1D26", position: "sticky", top: 0, zIndex: 1 }}>
              <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "17px", margin: 0, fontWeight: 600 }}>
                {editingId ? "Editar jogo" : "Novo jogo"}
              </h2>
              <button type="button" onClick={closeForm} style={{ background: "none", border: "none", color: "#9C9A93", cursor: "pointer", padding: "2px" }}>
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
                  background: coverSearchBusy ? "#3A3844" : "#8B7FD122", color: coverSearchBusy ? "#6B6960" : "#8B7FD1",
                  border: `1px solid ${coverSearchBusy ? "#2E2C36" : "#8B7FD155"}`, borderRadius: "8px", padding: "8px",
                  fontSize: "12px", fontWeight: 600, cursor: coverSearchBusy || !form.title.trim() ? "default" : "pointer", marginBottom: "8px",
                }}
              >
                <Search size={13} /> {coverSearchBusy ? "buscando no IGDB..." : "Buscar no IGDB"}
              </button>
              {coverSearchError && <p style={{ color: "#E4536B", fontSize: "11px", margin: "0 0 8px" }}>{coverSearchError}</p>}
              {coverCandidates.length > 0 && (
                <div style={{ marginBottom: "10px" }}>
                  <p style={{ fontSize: "11px", color: "#9C9A93", margin: "0 0 6px" }}>Escolha a versão correta:</p>
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px", maxHeight: "260px", overflowY: "auto" }}>
                    {coverCandidates.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => pickIgdbMatch(m)}
                        style={{ display: "flex", gap: "8px", textAlign: "left", padding: "6px", border: "1px solid #2E2C36", borderRadius: "8px", cursor: "pointer", background: "#15141B" }}
                      >
                        <div style={{ width: "42px", height: "56px", flexShrink: 0, borderRadius: "4px", overflow: "hidden", background: "#0A0910" }}>
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
                          <div style={{ fontSize: "12px", fontWeight: 600, color: "#EDEAE0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {m.name} {m.releaseYear ? <span style={{ color: "#6B6960", fontWeight: 400 }}>({m.releaseYear})</span> : null}
                          </div>
                          <div style={{ fontSize: "10px", color: "#9C9A93", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: "2px" }}>
                            {[m.developer, ...(m.platforms || []).slice(0, 3)].filter(Boolean).join(" · ")}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setCoverCandidates([])}
                    style={{ background: "none", border: "none", color: "#6B6960", fontSize: "11px", cursor: "pointer", marginTop: "6px", textDecoration: "underline" }}
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
                  marginTop: "8px", border: `1.5px dashed ${coverDragging ? "#E4536B" : "#2E2C36"}`, borderRadius: "10px",
                  background: coverDragging ? "#E4536B14" : "transparent", padding: "14px 10px", textAlign: "center", transition: "all 0.12s ease",
                }}
              >
                <p style={{ fontSize: "11px", color: coverDragging ? "#E4536B" : "#6B6960", margin: "0 0 8px" }}>
                  {coverDragging ? "solta aqui" : "arraste uma imagem aqui, ou"}
                </p>
                <label style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "12px", color: "#EDEAE0", border: "1px solid #2E2C36", borderRadius: "8px", padding: "7px 12px", cursor: "pointer", background: "#15141B" }}>
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
                    style={{ background: "none", border: "none", color: "#9C9A93", fontSize: "12px", cursor: "pointer", textDecoration: "underline" }}
                  >
                    remover capa
                  </button>
                )}
              </div>
              {form.cover && (
                <div style={{ marginTop: "10px", width: "64px", height: "85px", borderRadius: "6px", overflow: "hidden", border: "1px solid #2E2C36" }}>
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
                      display: "flex", alignItems: "center", gap: "5px", padding: "7px 10px", borderRadius: "8px", fontSize: "12px", fontWeight: 600, cursor: "pointer",
                      border: form.status === s.id ? `1px solid ${s.color}` : "1px solid #2E2C36",
                      background: form.status === s.id ? `${s.color}22` : "transparent",
                      color: form.status === s.id ? s.color : "#9C9A93",
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

            {formError && <p style={{ color: "#E4536B", fontSize: "12px", margin: "0 0 12px" }}>{formError}</p>}

            <div style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
              <button type="button" onClick={closeForm} style={{ flex: 1, padding: "10px", borderRadius: "8px", border: "1px solid #2E2C36", background: "transparent", color: "#9C9A93", cursor: "pointer", fontSize: "13px", fontWeight: 500 }}>
                Cancelar
              </button>
              <button type="submit" style={{ flex: 1, padding: "10px", borderRadius: "8px", border: "none", background: "#E4536B", color: "#2A0F16", cursor: "pointer", fontSize: "13px", fontWeight: 600 }}>
                {editingId ? "Salvar" : "Adicionar"}
              </button>
            </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color, Icon }) {
  return (
    <div style={{ background: "#1E1D26", borderRadius: "10px", padding: "10px 12px", border: "1px solid #2E2C36" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "5px", marginBottom: "4px" }}>
        {Icon && <Icon size={12} color={color} />}
        <span style={{ fontSize: "11px", color: "#9C9A93" }}>{label}</span>
      </div>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "20px", fontWeight: 600, color }}>{value}</div>
    </div>
  );
}

function Chip({ active, onClick, label, dot }) {
  return (
    <div
      className="shelf-chip"
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: "6px", padding: "6px 12px", borderRadius: "20px", fontSize: "12px", fontWeight: 500,
        border: active ? "1px solid #E4536B" : "1px solid #2E2C36",
        background: active ? "#E4536B22" : "transparent",
        color: active ? "#EDEAE0" : "#9C9A93",
      }}
    >
      {dot && <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: dot, display: "inline-block" }} />}
      {label}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: "14px" }}>
      <label style={{ display: "block", fontSize: "12px", color: "#9C9A93", marginBottom: "6px" }}>{label}</label>
      {children}
    </div>
  );
}

const inputStyle = {
  width: "100%", background: "#15141B", border: "1px solid #2E2C36", borderRadius: "8px", padding: "9px 10px", fontSize: "13px", color: "#EDEAE0", outline: "none", boxSizing: "border-box",
};

function GameCard({ game, onEdit, onDelete, onOpen, onMarkZerado, isConfirmingDelete }) {
  const [imgFailed, setImgFailed] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const platform = platformOf(game.platform);
  const status = statusOf(game.status);
  const StatusIcon = status.Icon;
  const showCover = game.cover && !imgFailed;
  const achievements = game.achievements || [];
  const achDone = achievements.filter((a) => a.done).length;
  const points = gamePoints(game);

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
    <div className="cart-card" onClick={onOpen} style={{ background: "#1E1D26", borderRadius: "14px 14px 8px 8px", border: "1px solid #2E2C36", overflow: "hidden", position: "relative", cursor: "pointer" }}>
      <div style={{ position: "absolute", top: 0, left: "50%", transform: "translateX(-50%)", width: "36px", height: "7px", background: "#15141B", borderRadius: "0 0 6px 6px", zIndex: 2 }} />
      <div style={{ background: status.color, padding: "9px 10px 7px", display: "flex", alignItems: "center", gap: "5px" }}>
        <StatusIcon size={13} color="#1A1A1A" />
        <span style={{ fontSize: "11px", fontWeight: 700, color: "#1A1A1A", letterSpacing: "0.02em" }}>{status.label}</span>
      </div>
      <div style={{ width: "100%", aspectRatio: "3 / 4", background: showCover ? "#0F0E14" : `${platform.color}18`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", overflow: "hidden", gap: "6px" }}>
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
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <>
            <Gamepad2 size={26} color={platform.color} style={{ opacity: 0.55 }} />
            {game.cover && imgFailed && (
              <>
                <span style={{ fontSize: "9px", color: "#8A8783", textAlign: "center", padding: "0 10px" }}>link da capa não carregou</span>
                <button
                  onClick={handleManualRetry}
                  style={{ fontSize: "9px", color: "#8B7FD1", background: "none", border: "1px solid #8B7FD155", borderRadius: "6px", padding: "3px 8px", cursor: "pointer" }}
                >
                  tentar de novo
                </button>
              </>
            )}
          </>
        )}
      </div>
      <div style={{ padding: "12px 12px 14px", minHeight: "92px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "5px", marginBottom: "7px" }}>
          <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: platform.color, display: "inline-block" }} />
          <span style={{ fontSize: "10px", color: "#9C9A93", fontWeight: 500 }}>{platform.label}</span>
        </div>
        <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: "13.5px", lineHeight: 1.3, marginBottom: (game.completedAt || game.startedAt || game.notes || achievements.length > 0 || points.total > 0) ? "6px" : 0 }}>
          {game.title}
        </div>
        {game.completedAt && isCompletedStatus(game.status) && (
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "10.5px", color: "#8A8783", marginBottom: game.notes ? "6px" : 0 }}>
            zerado em {formatDate(game.completedAt)}
          </div>
        )}
        {game.startedAt && game.status === "jogando" && (
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "10.5px", color: "#8A8783", marginBottom: game.notes ? "6px" : 0 }}>
            desde {formatDate(game.startedAt)}
          </div>
        )}
        {game.notes && (
          <p style={{ fontSize: "11px", color: "#8A8783", margin: 0, lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", marginBottom: (achievements.length > 0 || points.total > 0) ? "6px" : 0 }}>
            {game.notes}
          </p>
        )}
        {(achievements.length > 0 || points.total > 0) && (
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            {achievements.length > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                <Trophy size={11} color="#E8A33D" />
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "10.5px", color: "#E8A33D" }}>
                  {achDone}/{achievements.length}
                </span>
              </div>
            )}
            {points.total > 0 && (
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "10px", color: "#8B7FD1" }}>
                {points.earned.toLocaleString("pt-BR")}/{points.total.toLocaleString("pt-BR")} pts
              </div>
            )}
          </div>
        )}
      </div>
      <div className="cart-actions" style={{ position: "absolute", top: "40px", right: "8px", display: "flex", gap: "4px", opacity: isConfirmingDelete ? 1 : undefined }}>
        {game.status === "historico" && (
          <button
            onClick={(e) => { e.stopPropagation(); onMarkZerado(); }}
            style={{ ...iconBtnStyle, background: "#4FD1C5", borderColor: "#4FD1C5", color: "#0F2E2A" }}
            aria-label="Marcar como zerado"
            title="Marcar como zerado"
          >
            <CheckCircle2 size={12} />
          </button>
        )}
        <button onClick={(e) => { e.stopPropagation(); onEdit(); }} style={iconBtnStyle} aria-label="Editar"><Pencil size={12} /></button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          style={isConfirmingDelete ? { ...iconBtnStyle, background: "#E4536B", borderColor: "#E4536B", color: "#2A0F16" } : iconBtnStyle}
          aria-label={isConfirmingDelete ? "Clique de novo para confirmar" : "Remover"}
          title={isConfirmingDelete ? "Clique de novo pra confirmar" : "Remover"}
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

function DetailModal({ game, onClose, achText, setAchText, achError, onAddBulk, onToggle, onRemove, onCompleteAll, onUncompleteAll, onDeleteAll, onAddSingle }) {
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [showSingleForm, setShowSingleForm] = useState(false);
  const [singleName, setSingleName] = useState("");
  const [singleDesc, setSingleDesc] = useState("");
  const [singlePoints, setSinglePoints] = useState("");
  const [singleDlc, setSingleDlc] = useState("");
  const [lightboxIndex, setLightboxIndex] = useState(null);
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const platform = platformOf(game.platform);
  const status = statusOf(game.status);
  const achievements = game.achievements || [];
  const dlcOptions = [...new Set(achievements.map((a) => a.dlc).filter(Boolean))];
  const done = achievements.filter((a) => a.done).length;
  const pct = achievements.length > 0 ? Math.round((done / achievements.length) * 100) : 0;
  const totalPoints = achievements.reduce((s, a) => s + (Number(a.points) || 0), 0);
  const earnedPoints = achievements.filter((a) => a.done).reduce((s, a) => s + (Number(a.points) || 0), 0);
  const aggPoints = gamePoints(game);

  const submitSingle = () => {
    if (!singleName.trim()) return;
    onAddSingle({ name: singleName, description: singleDesc, points: singlePoints, dlc: singleDlc });
    setSingleName("");
    setSingleDesc("");
    setSinglePoints("");
    setSingleDlc("");
  };

  // Se o lightbox de screenshot estiver aberto, ESC fecha só ele — e impede
  // (via stopImmediatePropagation) que o mesmo ESC também feche o modal de
  // detalhe por trás, já que os dois listeners ficam no document.
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

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: "16px" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#1E1D26", borderRadius: "14px", padding: "22px", width: "100%", maxWidth: "460px", border: "1px solid #2E2C36", maxHeight: "85vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "14px" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
              <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: platform.color, display: "inline-block" }} />
              <span style={{ fontSize: "11px", color: "#9C9A93" }}>{platform.label}</span>
              <span style={{ fontSize: "10px", color: status.color, fontWeight: 700, marginLeft: "4px" }}>{status.label}</span>
            </div>
            <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "18px", margin: 0, fontWeight: 600 }}>{game.title}</h2>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#9C9A93", cursor: "pointer", padding: "2px" }}>
            <X size={18} />
          </button>
        </div>

        {achievements.length === 0 && aggPoints.total > 0 && (
          <div style={{ background: "#8B7FD114", border: "1px solid #8B7FD140", borderRadius: "10px", padding: "10px 12px", marginBottom: "16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: "11.5px", color: "#9C9A93" }}>Gamerscore (sem detalhamento por conquista)</span>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "13px", fontWeight: 700, color: "#8B7FD1" }}>
              {aggPoints.earned.toLocaleString("pt-BR")} / {aggPoints.total.toLocaleString("pt-BR")}
            </span>
          </div>
        )}

        {game.metadata && (
          <div style={{ background: "#15141B", border: "1px solid #2E2C36", borderRadius: "10px", padding: "12px", marginBottom: "16px" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", fontSize: "11px", color: "#9C9A93", marginBottom: game.metadata.summary ? "8px" : 0 }}>
              {game.metadata.releaseYear && <span><strong style={{ color: "#EDEAE0" }}>{game.metadata.releaseYear}</strong></span>}
              {game.metadata.developer && <span>{game.metadata.developer}</span>}
              {game.metadata.publisher && game.metadata.publisher !== game.metadata.developer && <span>· {game.metadata.publisher}</span>}
              {typeof game.metadata.rating === "number" && (
                <span style={{ color: "#E8A33D", fontFamily: "'JetBrains Mono', monospace" }}>★ {game.metadata.rating.toFixed(1)}</span>
              )}
            </div>
            {Array.isArray(game.metadata.genres) && game.metadata.genres.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "5px", marginBottom: game.metadata.summary ? "8px" : 0 }}>
                {game.metadata.genres.map((g) => (
                  <span key={g} style={{ fontSize: "10px", color: "#8B7FD1", background: "#8B7FD11a", borderRadius: "10px", padding: "2px 8px" }}>{g}</span>
                ))}
              </div>
            )}
            {game.metadata.summary && (
              <p style={{ fontSize: "11.5px", color: "#B7B4AB", lineHeight: 1.5, margin: 0 }}>{game.metadata.summary}</p>
            )}
          </div>
        )}

        {Array.isArray(game.metadata?.screenshots) && game.metadata.screenshots.length > 0 && (
          <div style={{ marginBottom: "16px" }}>
            <span style={{ fontSize: "11px", fontWeight: 600, color: "#9C9A93", textTransform: "uppercase", letterSpacing: "0.04em", display: "block", marginBottom: "8px" }}>
              Screenshots
            </span>
            <div style={{ display: "flex", gap: "8px", overflowX: "auto", paddingBottom: "4px" }}>
              {game.metadata.screenshots.map((url, i) => (
                <img
                  key={i}
                  src={displayCoverUrl(url)}
                  alt={`Screenshot ${i + 1} de ${game.title}`}
                  onClick={() => setLightboxIndex(i)}
                  loading="lazy"
                  style={{ width: "120px", height: "68px", objectFit: "cover", borderRadius: "8px", border: "1px solid #2E2C36", cursor: "pointer", flexShrink: 0 }}
                />
              ))}
            </div>
          </div>
        )}

        {lightboxIndex !== null && Array.isArray(game.metadata?.screenshots) && (
          <div
            onClick={(e) => { e.stopPropagation(); setLightboxIndex(null); }}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60, padding: "24px" }}
          >
            <button
              onClick={(e) => { e.stopPropagation(); setLightboxIndex(null); }}
              style={{ position: "absolute", top: "18px", right: "18px", background: "#1E1D26", border: "1px solid #2E2C36", borderRadius: "8px", width: "32px", height: "32px", display: "flex", alignItems: "center", justifyContent: "center", color: "#EDEAE0", cursor: "pointer" }}
              aria-label="Fechar"
            >
              <X size={16} />
            </button>
            {game.metadata.screenshots.length > 1 && (
              <button
                onClick={(e) => { e.stopPropagation(); setLightboxIndex((i) => (i - 1 + game.metadata.screenshots.length) % game.metadata.screenshots.length); }}
                style={{ position: "absolute", left: "18px", top: "50%", transform: "translateY(-50%)", background: "#1E1D26", border: "1px solid #2E2C36", borderRadius: "8px", width: "36px", height: "36px", display: "flex", alignItems: "center", justifyContent: "center", color: "#EDEAE0", cursor: "pointer", fontSize: "16px" }}
                aria-label="Anterior"
              >
                ‹
              </button>
            )}
            <img
              src={displayCoverUrl(game.metadata.screenshots[lightboxIndex])}
              alt={`Screenshot ${lightboxIndex + 1} de ${game.title}`}
              onClick={(e) => e.stopPropagation()}
              style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: "10px", objectFit: "contain" }}
            />
            {game.metadata.screenshots.length > 1 && (
              <button
                onClick={(e) => { e.stopPropagation(); setLightboxIndex((i) => (i + 1) % game.metadata.screenshots.length); }}
                style={{ position: "absolute", right: "18px", top: "50%", transform: "translateY(-50%)", background: "#1E1D26", border: "1px solid #2E2C36", borderRadius: "8px", width: "36px", height: "36px", display: "flex", alignItems: "center", justifyContent: "center", color: "#EDEAE0", cursor: "pointer", fontSize: "16px" }}
                aria-label="Próximo"
              >
                ›
              </button>
            )}
          </div>
        )}


        {achievements.length > 0 && (
          <div style={{ marginBottom: "16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "#9C9A93", marginBottom: "6px" }}>
              <span>Progresso</span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "#E8A33D" }}>{done}/{achievements.length} ({pct}%)</span>
            </div>
            <div style={{ height: "6px", background: "#15141B", borderRadius: "4px", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${pct}%`, background: "#E8A33D", borderRadius: "4px", transition: "width 0.2s ease" }} />
            </div>
            {totalPoints > 0 && (
              <div style={{ textAlign: "right", marginTop: "5px", fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: "#8B7FD1" }}>
                {earnedPoints.toLocaleString("pt-BR")} / {totalPoints.toLocaleString("pt-BR")} pts
              </div>
            )}
            <div style={{ display: "flex", gap: "6px", marginTop: "10px" }}>
              <button
                onClick={onCompleteAll}
                style={{ flex: 1, background: "#E8A33D22", border: "1px solid #E8A33D55", color: "#E8A33D", borderRadius: "6px", padding: "6px 10px", fontSize: "11px", fontWeight: 600, cursor: "pointer" }}
              >
                Marcar todas como feitas
              </button>
              <button
                onClick={onUncompleteAll}
                style={{ background: "none", border: "1px solid #2E2C36", color: "#8A8783", borderRadius: "6px", padding: "6px 10px", fontSize: "11px", cursor: "pointer" }}
              >
                Desmarcar todas
              </button>
            </div>
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
              style={{
                width: "100%", marginTop: "6px", background: confirmDeleteAll ? "#E4536B" : "none",
                border: `1px solid ${confirmDeleteAll ? "#E4536B" : "#2E2C36"}`, color: confirmDeleteAll ? "#2A0F16" : "#6B6960",
                borderRadius: "6px", padding: "6px 10px", fontSize: "11px", fontWeight: confirmDeleteAll ? 600 : 400, cursor: "pointer",
              }}
            >
              {confirmDeleteAll ? "Clique de novo pra confirmar" : "Apagar todas as conquistas"}
            </button>
          </div>
        )}

        {achievements.length > 0 && (() => {
          const groupOrder = [];
          const groups = {};
          achievements.forEach((a) => {
            const key = a.dlc || "";
            if (!groups[key]) {
              groups[key] = [];
              groupOrder.push(key);
            }
            groups[key].push(a);
          });
          // Base game (no dlc) always first, regardless of insertion order.
          groupOrder.sort((x, y) => (x === "" ? -1 : y === "" ? 1 : 0));

          return (
            <div style={{ display: "flex", flexDirection: "column", gap: "14px", marginBottom: "16px" }}>
              {groupOrder.map((key) => {
                const items = groups[key];
                const doneCount = items.filter((a) => a.done).length;
                const isCollapsed = !!collapsedGroups[key];
                return (
                  <div key={key || "__base__"}>
                    {groupOrder.length > 1 && (
                      <div
                        onClick={() => setCollapsedGroups((s) => ({ ...s, [key]: !s[key] }))}
                        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px", cursor: "pointer", userSelect: "none" }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                          <ChevronDown
                            size={11}
                            color="#7B93A8"
                            style={{ transform: isCollapsed ? "rotate(-90deg)" : "none", transition: "transform 0.15s ease", flexShrink: 0 }}
                          />
                          <span style={{ fontSize: "10.5px", fontWeight: 700, color: "#7B93A8", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                            {key || "Jogo base"}
                          </span>
                        </div>
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "10px", color: "#6B6960" }}>{doneCount}/{items.length}</span>
                      </div>
                    )}
                    {!isCollapsed && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                      {items.map((a) => (
                        <div
                          key={a.id}
                          onClick={() => onToggle(a.id)}
                          style={{ display: "flex", alignItems: "flex-start", gap: "9px", padding: "9px 10px", borderRadius: "8px", background: a.done ? "#E8A33D14" : "#15141B", border: `1px solid ${a.done ? "#E8A33D33" : "#2E2C36"}`, cursor: "pointer" }}
                        >
                          <div style={{ width: "16px", height: "16px", borderRadius: "4px", border: `1.5px solid ${a.done ? "#E8A33D" : "#4A4845"}`, background: a.done ? "#E8A33D" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: "1px" }}>
                            {a.done && <CheckCircle2 size={11} color="#1A1A1A" />}
                          </div>
                          <div style={{ flex: 1 }}>
                            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "8px" }}>
                              <span style={{ fontSize: "12.5px", fontWeight: 500, color: a.done ? "#EDEAE0" : "#C9C6BE" }}>{a.name}</span>
                              {a.points > 0 && (
                                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "10px", color: "#8B7FD1", flexShrink: 0 }}>{a.points} pts</span>
                              )}
                            </div>
                            {a.description && <div style={{ fontSize: "11px", color: "#8A8783", marginTop: "2px" }}>{a.description}</div>}
                            {a.done && a.doneAt && (
                              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "10px", color: "#E8A33D99", marginTop: "3px" }}>
                                feita em {formatDate(a.doneAt)}
                              </div>
                            )}
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); onRemove(a.id); }}
                            style={{ background: "none", border: "none", color: "#6B6960", cursor: "pointer", padding: "2px", flexShrink: 0 }}
                            aria-label="Remover conquista"
                          >
                            <X size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })()}

        <div style={{ borderTop: achievements.length > 0 ? "1px solid #2E2C36" : "none", paddingTop: achievements.length > 0 ? "14px" : 0 }}>
          <button
            onClick={() => setShowSingleForm((s) => !s)}
            style={{ display: "flex", alignItems: "center", gap: "5px", background: "none", border: "none", color: "#8B7FD1", fontSize: "12px", fontWeight: 600, cursor: "pointer", padding: 0, marginBottom: showSingleForm ? "10px" : "14px" }}
          >
            <Plus size={13} /> Adicionar conquista individual
          </button>

          {showSingleForm && (
            <div style={{ background: "#15141B", border: "1px solid #2E2C36", borderRadius: "8px", padding: "10px", marginBottom: "14px", display: "flex", flexDirection: "column", gap: "7px" }}>
              <input
                value={singleName}
                onChange={(e) => setSingleName(e.target.value)}
                placeholder="Nome da conquista"
                style={{ ...inputStyle, fontSize: "12px", padding: "7px 9px" }}
                autoFocus
              />
              <input
                value={singleDesc}
                onChange={(e) => setSingleDesc(e.target.value)}
                placeholder="Descrição (opcional)"
                style={{ ...inputStyle, fontSize: "12px", padding: "7px 9px" }}
              />
              <div style={{ display: "flex", gap: "7px" }}>
                <input
                  type="number"
                  value={singlePoints}
                  onChange={(e) => setSinglePoints(e.target.value)}
                  placeholder="Pontos"
                  style={{ ...inputStyle, fontSize: "12px", padding: "7px 9px", width: "80px" }}
                />
                <input
                  value={singleDlc}
                  onChange={(e) => setSingleDlc(e.target.value)}
                  placeholder="DLC (opcional — deixa em branco pro jogo base)"
                  list="dlc-options"
                  style={{ ...inputStyle, fontSize: "12px", padding: "7px 9px", flex: 1 }}
                />
                <datalist id="dlc-options">
                  {dlcOptions.map((d) => <option key={d} value={d} />)}
                </datalist>
              </div>
              <button
                onClick={submitSingle}
                disabled={!singleName.trim()}
                style={{ background: singleName.trim() ? "#E4536B" : "#3A3844", color: singleName.trim() ? "#2A0F16" : "#6B6960", border: "none", borderRadius: "6px", padding: "7px", fontSize: "12px", fontWeight: 600, cursor: singleName.trim() ? "pointer" : "default" }}
              >
                Adicionar
              </button>
            </div>
          )}

          <label style={{ display: "block", fontSize: "12px", color: "#9C9A93", marginBottom: "6px" }}>
            Adicionar conquistas (uma por linha: "Nome; Descrição; Pontos; DLC; Desbloqueada" — os quatro últimos são opcionais. No último campo, use uma data AAAA-MM-DD ou "sim" pra já marcar como concluída)
          </label>
          <textarea
            value={achText}
            onChange={(e) => setAchText(e.target.value)}
            placeholder={"Primeiros passos; Complete o capítulo 1; 10;; sim\nMestre da espada;;;Expansão X;2024-03-12"}
            rows={3}
            style={{ ...inputStyle, resize: "vertical", fontSize: "12px", marginBottom: "8px" }}
          />
          {achError && <p style={{ color: "#E4536B", fontSize: "12px", margin: "0 0 8px" }}>{achError}</p>}
          <button
            onClick={onAddBulk}
            style={{ width: "100%", padding: "9px", borderRadius: "8px", border: "none", background: "#E4536B", color: "#2A0F16", cursor: "pointer", fontSize: "13px", fontWeight: 600 }}
          >
            Adicionar à lista
          </button>
        </div>
      </div>
    </div>
  );
}

const iconBtnStyle = {
  background: "#15141Bcc", border: "1px solid #2E2C36", borderRadius: "6px", width: "24px", height: "24px", display: "flex", alignItems: "center", justifyContent: "center", color: "#EDEAE0", cursor: "pointer",
};

function EmptyState({ hasGames, onAdd }) {
  return (
    <div style={{ textAlign: "center", padding: "60px 20px", border: "1px dashed #2E2C36", borderRadius: "14px" }}>
      <Gamepad2 size={28} color="#6B6960" style={{ marginBottom: "10px" }} />
      <p style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600, fontSize: "15px", margin: "0 0 4px" }}>
        {hasGames ? "Nenhum jogo bate com esse filtro" : "A estante tá vazia"}
      </p>
      <p style={{ fontSize: "12px", color: "#9C9A93", margin: "0 0 16px" }}>
        {hasGames ? "Tenta limpar os filtros ou a busca." : "Comece adicionando o primeiro jogo que você zerou ou platinou."}
      </p>
      {!hasGames && (
        <button onClick={onAdd} style={{ display: "inline-flex", alignItems: "center", gap: "6px", background: "#E4536B", color: "#2A0F16", border: "none", padding: "9px 14px", borderRadius: "8px", fontWeight: 600, fontSize: "13px", cursor: "pointer" }}>
          <Plus size={15} /> Adicionar jogo
        </button>
      )}
    </div>
  );
}
