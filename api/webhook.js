import Anthropic from "@anthropic-ai/sdk";
import Redis from "ioredis";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let redis;
function getRedis() {
  if (!redis) redis = new Redis(process.env.REDIS_URL);
  return redis;
}

// ── DETECÇÃO DE FLUXO ──────────────────────────────────────────────────────
const FLOW_KEYWORDS = {
  protese: ["protese", "prótese", "capilar"],
  clube:   ["clube vip", "clube", "assinatura", "plano"],
};

function detectFlow(text) {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (FLOW_KEYWORDS.protese.some(k => t.includes(k.normalize("NFD").replace(/[̀-ͯ]/g, "")))) return "protese";
  if (FLOW_KEYWORDS.clube.some(k => t.includes(k.normalize("NFD").replace(/[̀-ͯ]/g, "")))) return "clube";
  return "organico";
}

const FLOW_CONTEXT = {
  protese: `FLUXO DO CLIENTE: Prótese Capilar.
O cliente demonstrou interesse em prótese capilar. Seu objetivo é sanar todas as dúvidas com clareza e naturalidade, e ao final conduzir para o agendamento de uma AVALIAÇÃO PRESENCIAL GRATUITA e sem compromisso. Explique o processo, mostre confiança, compartilhe resultados quando possível. Não force — guie.`,

  clube: `FLUXO DO CLIENTE: Clube VIP.
O cliente tem interesse nos planos de assinatura mensal. Seu objetivo é explicar os benefícios do plano, o custo-benefício em relação a pagar por corte, e fechar a adesão. Seja direto e amigável. Se houver mais de um plano, ajude o cliente a escolher o mais adequado.`,

  organico: `FLUXO DO CLIENTE: Contato direto (orgânico).
Atenda normalmente — identifique o que o cliente precisa e ajude da melhor forma.`,
};

// ── REDIS HELPERS ──────────────────────────────────────────────────────────
async function getPrompt() {
  const r = getRedis();
  return (await r.get("prompt:system")) || "Você é um assistente virtual de uma barbearia.";
}

async function getHistory(phone) {
  const r = getRedis();
  const raw = await r.get(`hist:${phone}`);
  return raw ? JSON.parse(raw) : [];
}

async function saveHistory(phone, history) {
  const r = getRedis();
  await r.set(`hist:${phone}`, JSON.stringify(history.slice(-20)), "EX", 60 * 60 * 24 * 7);
}

// ── EVOLUTION API ──────────────────────────────────────────────────────────
async function setPresence(phone, presence) {
  try {
    await fetch(`${process.env.EVOLUTION_API_URL}/chat/sendPresence/${process.env.EVOLUTION_INSTANCE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: process.env.EVOLUTION_API_KEY },
      body: JSON.stringify({ number: phone, presence }),
    });
  } catch {}
}

async function sendWhatsApp(phone, text) {
  await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: process.env.EVOLUTION_API_KEY },
    body: JSON.stringify({ number: phone, text }),
  });
}

async function sendMedia(phone, item) {
  const base = `${process.env.EVOLUTION_API_URL}`;
  const inst = process.env.EVOLUTION_INSTANCE;
  const headers = { "Content-Type": "application/json", apikey: process.env.EVOLUTION_API_KEY };

  if (item.type === "audio") {
    await fetch(`${base}/message/sendWhatsAppAudio/${inst}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ number: phone, audio: item.data }),
    });
  } else {
    // image or video or document
    await fetch(`${base}/message/sendMedia/${inst}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        number: phone,
        mediatype: item.type,
        media: item.data,
        caption: item.caption || "",
      }),
    });
  }
}

async function getFlowMedia(r, flow) {
  const ids = await r.lrange(`media:${flow}:ids`, 0, -1);
  const items = [];
  for (const id of ids) {
    const meta = await r.get(`media:${flow}:${id}:meta`);
    const data = await r.get(`media:${flow}:${id}:data`);
    if (meta && data) items.push({ id, ...JSON.parse(meta), data });
  }
  return items;
}

// Busca o ID interno do label pelo nome (com cache Redis 1h)
async function getLabelId(labelName) {
  const r = getRedis();
  const cacheKey = `labelid:${labelName}`;
  const cached = await r.get(cacheKey);
  if (cached) return cached;
  try {
    const resp = await fetch(
      `${process.env.EVOLUTION_API_URL}/label/findLabels/${process.env.EVOLUTION_INSTANCE}`,
      { headers: { apikey: process.env.EVOLUTION_API_KEY } }
    );
    const data = await resp.json();
    const list = Array.isArray(data) ? data : (data?.labels || []);
    for (const lbl of list) {
      const id = lbl.id || lbl.labelId;
      const name = lbl.name || lbl.label || "";
      if (id) await r.set(`labelid:${name}`, id, "EX", 3600);
    }
    const found = list.find(l => (l.name || l.label || "") === labelName);
    return found ? (found.id || found.labelId) : null;
  } catch { return null; }
}

async function applyLabel(phone, labelName) {
  // 1. Evolution API (com lookup de ID para maior compatibilidade)
  try {
    const labelId = await getLabelId(labelName);
    const body = labelId
      ? { number: phone, labelId, action: "add" }
      : { number: phone, label: labelName, action: "add" };
    await fetch(`${process.env.EVOLUTION_API_URL}/label/handleLabel/${process.env.EVOLUTION_INSTANCE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: process.env.EVOLUTION_API_KEY },
      body: JSON.stringify(body),
    });
  } catch {}

  // 2. Wascript (WhatsApp Web direto — garante que aparece no Waseller)
  if (process.env.WASCRIPT_TOKEN) {
    try {
      const listResp = await fetch(
        `https://api-whatsapp.wascript.com.br/api/listar-etiquetas/${process.env.WASCRIPT_TOKEN}`
      );
      const listData = await listResp.json();
      const found = (listData.etiquetas || []).find(e =>
        (e.name || "").toLowerCase().includes(labelName.toLowerCase().replace(" ✕", ""))
      );
      if (found?.id) {
        await fetch(
          `https://api-whatsapp.wascript.com.br/api/modificar-etiquetas/${process.env.WASCRIPT_TOKEN}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ phone, actions: [{ labelId: found.id, type: "add" }] }),
          }
        );
      }
    } catch {}
  }
}

// ── MÍDIA: download + transcrição ─────────────────────────────────────────

async function downloadMedia(msg) {
  try {
    const resp = await fetch(
      `${process.env.EVOLUTION_API_URL}/chat/getBase64FromMediaMessage/${process.env.EVOLUTION_INSTANCE}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: process.env.EVOLUTION_API_KEY },
        body: JSON.stringify({ message: { key: msg.key, message: msg.message } }),
      }
    );
    if (!resp.ok) return null;
    return await resp.json(); // { base64, mimetype, ... }
  } catch {
    return null;
  }
}

// Transcreve áudio usando Groq Whisper (precisa de GROQ_API_KEY no Vercel)
async function transcribeAudio(base64, mimetype) {
  if (!process.env.GROQ_API_KEY) return null;
  try {
    const buffer = Buffer.from(base64, "base64");
    const ext = (mimetype || "").includes("mp4") ? "mp4" : "ogg";
    const blob = new Blob([buffer], { type: mimetype || "audio/ogg; codecs=opus" });
    const formData = new FormData();
    formData.append("file", blob, `audio.${ext}`);
    formData.append("model", "whisper-large-v3-turbo");
    formData.append("language", "pt");
    formData.append("response_format", "text");

    const resp = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: formData,
    });
    if (!resp.ok) return null;
    return (await resp.text()).trim();
  } catch {
    return null;
  }
}

// Verifica via Evolution API se o label "IA OFF" ainda está no chat do contato.
// Chamado quando iaoff:{phone} existe no Redis mas o agente recebeu nova mensagem —
// detecta remoção do label feita pelo Waseller (que não dispara webhook labels.edit).
async function hasIAOffLabelOnChat(phone) {
  try {
    const jid = `${phone}@s.whatsapp.net`;

    // 1. Busca os labels cadastrados para encontrar o ID do "IA OFF"
    const labelsResp = await fetch(
      `${process.env.EVOLUTION_API_URL}/label/findLabels/${process.env.EVOLUTION_INSTANCE}`,
      { headers: { apikey: process.env.EVOLUTION_API_KEY } }
    );
    if (!labelsResp.ok) return true; // erro → assume ainda iaoff (seguro)
    const labelsData = await labelsResp.json();
    const labelList = Array.isArray(labelsData) ? labelsData : (labelsData?.labels || []);
    const iaOffIds = labelList
      .filter(l => (l.name || l.label || "").toLowerCase().includes("ia off"))
      .map(l => l.id || l.labelId || l.name);

    // 2. Busca os dados do chat do contato
    const chatResp = await fetch(
      `${process.env.EVOLUTION_API_URL}/chat/findChats/${process.env.EVOLUTION_INSTANCE}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: process.env.EVOLUTION_API_KEY },
        body: JSON.stringify({ where: { id: jid } }),
      }
    );
    if (!chatResp.ok) return true;
    const chatData = await chatResp.json();
    const chats = Array.isArray(chatData) ? chatData : (chatData?.chats || [chatData]);
    const chat = chats.find(c => c.id === jid || c.remoteJid === jid);
    if (!chat) return true; // chat não encontrado → assume ainda iaoff

    const chatLabels = chat.labels || [];

    // Checa por ID ou por nome direto (depende da versão do Evolution API)
    return chatLabels.some(l => {
      const name = (typeof l === "string" ? l : l?.name || l?.id || "").toLowerCase();
      if (name.includes("ia off")) return true;
      return iaOffIds.includes(typeof l === "string" ? l : l?.id);
    });
  } catch {
    return true; // erro → assume ainda iaoff (seguro: não responde por engano)
  }
}

// Etiquetas do funil por fluxo
const FUNNEL_LABELS = {
  protese: {
    lead:       "TRÁFEGO PRÓTESE - LEADS",
    respondeu:  "TRÁFEGO PRÓTESE - RESPONDEU",
    interessou: "TRÁFEGO PRÓTESE - SE INTERESSOU",
    agendou:    "TRÁFEGO PRÓTESE - AGENDOU AVALIAÇÃO",
  },
  clube: {
    lead: "LEADS - CLUB VIP",
  },
};

// ── ESCALONAMENTO: config + notificação ativa ──────────────────────────────
async function getEscalationConfig() {
  const r = getRedis();
  const raw = await r.get("config:escalation");
  return raw ? JSON.parse(raw) : { numbers: [], groupSubject: "" };
}

// Descobre o JID do grupo pelo nome (subject) e cacheia 24h — evita hardcode do ID
async function resolveGroupJid(subject) {
  if (!subject) return null;
  const r = getRedis();
  const cacheKey = `groupjid:${subject}`;
  const cached = await r.get(cacheKey);
  if (cached) return cached;
  try {
    const resp = await fetch(
      `${process.env.EVOLUTION_API_URL}/group/fetchAllGroups/${process.env.EVOLUTION_INSTANCE}?getParticipants=false`,
      { headers: { apikey: process.env.EVOLUTION_API_KEY } }
    );
    const data = await resp.json();
    const list = Array.isArray(data) ? data : (data?.groups || []);
    const want = subject.trim().toLowerCase();
    const match = list.find(g => (g.subject || "").trim().toLowerCase() === want);
    if (match?.id) {
      await r.set(cacheKey, match.id, "EX", 60 * 60 * 24);
      return match.id;
    }
  } catch (e) {
    console.error("resolveGroupJid error:", e);
  }
  return null;
}

// Avisa ativamente os destinos (número(s) + grupo) que um cliente precisa de humano
async function notifyEscalation(phone, clientText) {
  const r = getRedis();
  const cfg = await getEscalationConfig();
  const waLink = `https://wa.me/${phone}`;
  const alert =
    `🔔 *Atendimento humano necessário*\n\n` +
    `Cliente: +${phone}\n` +
    `Última mensagem: "${(clientText || "").slice(0, 400)}"\n\n` +
    `A IA foi pausada pra esse cliente. Alguém assume por aqui:\n${waLink}`;

  const targets = [...(cfg.numbers || [])];
  const groupJid = await resolveGroupJid(cfg.groupSubject);
  if (groupJid) targets.push(groupJid);

  for (const t of targets) {
    try {
      await sendWhatsApp(t, alert);
    } catch (e) {
      console.error("notifyEscalation send error:", t, e);
    }
  }

  // Log leve pra eventual painel de pendências
  try {
    await r.lpush("escalations", JSON.stringify({ phone, text: (clientText || "").slice(0, 400), ts: Date.now() }));
    await r.ltrim("escalations", 0, 199);
  } catch {}
}

// ── HANDLER ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS — necessário para Waseller (executa webhook via browser)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Rota de diagnóstico temporária
  if (req.method === "GET" && req.query?.debug === "wh2025") {
    const r0 = getRedis();
    // ?cleariaoff=phone → limpa iaoff de um contato específico
    if (req.query.cleariaoff) {
      await r0.del(`iaoff:${req.query.cleariaoff}`);
      return res.status(200).json({ cleared: req.query.cleariaoff });
    }
    const [webhookLogs, wasellerLogs, iaoffKeys, lockKeys, pendingKeys, prompt, followupLogs] = await Promise.all([
      r0.lrange("debug:webhook", 0, 9),
      r0.lrange("debug:waseller", 0, 19),
      r0.keys("iaoff:*"),
      r0.keys("lock:*"),
      r0.keys("pending:*"),
      r0.get("prompt:system"),
      r0.lrange("log:followups", 0, 99),
    ]);
    return res.status(200).json({
      webhookLogs: webhookLogs.map(i => { try { return JSON.parse(i); } catch { return i; } }),
      wasellerLogs: wasellerLogs.map(i => { try { return JSON.parse(i); } catch { return i; } }),
      followupLogs: followupLogs.map(i => { try { return JSON.parse(i); } catch { return i; } }),
      iaoffKeys, lockKeys, pendingKeys, prompt
    });
  }
  // Rota de escrita temporária de prompt via debug
  if (req.method === "POST" && req.query?.debug === "wh2025" && req.body?.setPrompt) {
    const r0 = getRedis();
    await r0.set("prompt:system", req.body.setPrompt);
    return res.status(200).json({ ok: true, length: req.body.setPrompt.length });
  }
  // Rota de teste de follow-up: injeta phone no Redis como se tivesse parado há X dias
  if (req.method === "POST" && req.query?.debug === "wh2025" && req.body?.testFollowup) {
    const r0 = getRedis();
    const phone = String(req.body.testFollowup).replace(/\D/g, "");
    const flow = req.body.flow || "organico";
    const daysAgo = req.body.daysAgo || 4;
    const fakeLastMsg = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
    await r0.set(`lastmsg:${phone}`, fakeLastMsg, "EX", 60 * 60 * 24 * 90);
    await r0.sadd(`phones:${flow}`, phone);
    await r0.set(`fluxo:${phone}`, flow, "EX", 60 * 60 * 24 * 90);
    await r0.del(`followup:${phone}`); // reset etapa
    // Injeta histórico fictício se fornecido
    if (req.body.history && Array.isArray(req.body.history)) {
      await r0.set(`hist:${phone}`, JSON.stringify(req.body.history), "EX", 60 * 60 * 24 * 90);
    }
    const hist = await r0.get(`hist:${phone}`);
    return res.status(200).json({ ok: true, phone, flow, daysAgo, hasHistory: !!hist, histLen: hist ? JSON.parse(hist).length : 0 });
  }
  // Disparo manual do cron via debug endpoint
  if (req.method === "POST" && req.query?.debug === "wh2025" && req.body?.runCron) {
    const base = `https://${req.headers.host}`;
    const cronRes = await fetch(`${base}/api/cron`);
    const cronResult = await cronRes.json();
    return res.status(200).json({ ok: true, cron: cronResult });
  }

  if (req.method !== "POST") return res.status(200).json({ ok: true });

  try {
    const body = req.body;
    // Normaliza event para lowercase com ponto: "LABELS_ASSOCIATION" → "labels.association"
    const rawEvent = body?.event || "";
    const event = rawEvent.toLowerCase().replace(/_/g, ".");

    // Salva últimos payloads não-mensagem no Redis para diagnóstico
    if (!event || event !== "messages.upsert") {
      const r0 = getRedis();
      const entry = JSON.stringify({ ts: Date.now(), rawEvent, event, body: body }).slice(0, 800);
      await r0.lpush("debug:webhook", entry);
      await r0.ltrim("debug:webhook", 0, 9);
      console.log(`[incoming] ${entry.slice(0, 300)}`);
    }

    // ── Webhook do Waseller (etiqueta adicionada/removida manualmente pela equipe) ──
    // URL configurada no Waseller: /api/webhook?source=waseller
    if (req.query?.source === "waseller" || body?.eventID === "labels") {
      const r = getRedis();
      await r.lpush("debug:waseller", JSON.stringify({ ts: Date.now(), method: req.method, query: req.query, body }));
      await r.ltrim("debug:waseller", 0, 19);

      // Payload real do Waseller:
      // body.number = "554197345230@c.us"
      // body.eventDetails.type = "add" | "remove"
      // body.eventDetails.labels = [{ id: "10", name: "IA OFF ❌" }]
      const phone = String(body?.number || body?.numero || "").replace(/@\S+/g, "").replace(/\D/g, "");
      const type = body?.eventDetails?.type || "";
      const labels = body?.eventDetails?.labels || [];
      const isIaOff = labels.some(l => String(l.id) === "10" || String(l.name || "").toLowerCase().includes("ia off"));

      console.log(`[waseller] phone=${phone} type=${type} isIaOff=${isIaOff}`);

      if (phone && isIaOff) {
        if (type === "add") {
          await r.set(`iaoff:${phone}`, "1", "EX", 60 * 60 * 24 * 30);
          console.log(`[waseller] IA OFF ativado para ${phone}`);
        } else if (type === "remove") {
          await r.del(`iaoff:${phone}`);
          console.log(`[waseller] IA OFF removido para ${phone}`);
        }
      }
      return res.status(200).json({ ok: true });
    }

    // Log de eventos não-mensagem para diagnóstico
    if (event && event !== "messages.upsert") {
      console.log(`[webhook-event] event=${event} data=${JSON.stringify(body?.data).slice(0, 500)}`);
    }

    // ── Evento de etiqueta da Evolution API (labels.association / labels.edit) ──
    // Payload real: { event, data: { instance, type, chatId, labelId } }
    if (event === "labels.association" || event === "labels.edit") {
      const r = getRedis();
      const d = body?.data || {};

      // Campos estão direto em d (não aninhados)
      const labelId = String(d.labelId || d.id || "");
      const chatId  = d.chatId || d.remoteJid || d.id?.remote || "";
      const type    = d.type || d.action || "";

      // Extrai chave de identificação: remove sufixos @s.whatsapp.net, @c.us, @lid
      const contactKey = chatId.replace(/@s\.whatsapp\.net|@c\.us|@lid/g, "");

      console.log(`[label-event] labelId=${labelId} chatId=${chatId} type=${type}`);

      // labelId "10" = IA OFF ❌ (confirmado via findLabels)
      if (contactKey && labelId === "10") {
        if (type === "add") {
          await r.set(`iaoff:${contactKey}`, "1", "EX", 60 * 60 * 24 * 30);
          console.log(`[label-event] IA OFF ativado para ${contactKey}`);
        } else if (type === "remove") {
          await r.del(`iaoff:${contactKey}`);
          console.log(`[label-event] IA OFF removido para ${contactKey}`);
        }
      }
      return res.status(200).json({ ok: true });
    }

    if (event !== "messages.upsert") return res.status(200).json({ ok: true });

    const msg = body?.data;
    if (!msg || msg.key?.fromMe) return res.status(200).json({ ok: true });

    const remoteJid = msg.key?.remoteJid || "";
    if (remoteJid.includes("@g.us")) return res.status(200).json({ ok: true });

    // Extrai identificador numérico (sem sufixo) — usado como chave no Redis
    const phone = remoteJid.replace(/@s\.whatsapp\.net|@c\.us|@lid/g, "");
    // Preserva o JID original para enviar a resposta corretamente (Evolution API aceita @lid)
    const sendTo = remoteJid.includes("@lid") ? remoteJid : phone;

    // ── Extrair conteúdo: texto, áudio ou imagem ──
    let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";

    const msgType = Object.keys(msg.message || {}).find(k =>
      ["audioMessage", "pttMessage", "imageMessage"].includes(k)
    );

    if (!text && (msgType === "audioMessage" || msgType === "pttMessage")) {
      const media = await downloadMedia(msg);
      if (media?.base64) {
        const transcription = await transcribeAudio(media.base64, media.mimetype);
        if (transcription) {
          text = transcription; // trata o áudio transcrito como texto normal
        }
        // sem transcrição disponível → ignora (não responde a áudio sem GROQ_API_KEY)
      }
    }

    if (!text && msgType === "imageMessage") {
      const caption = msg.message.imageMessage?.caption || "";
      const media = await downloadMedia(msg);
      if (media?.base64) {
        const r2 = getRedis();
        // Guarda a imagem temporariamente para o Claude ver nesta rodada
        await r2.set(`img:${phone}`, JSON.stringify({ base64: media.base64, mimetype: media.mimetype || "image/jpeg" }), "EX", 120);
        text = caption || "[imagem]";
      }
    }

    if (!text) return res.status(200).json({ ok: true });

    const r = getRedis();

    // ── RESET DE CONVERSA (deve rodar ANTES do iaoff check) ──
    if (text.trim().toLowerCase().includes("reset") && text.includes("❌")) {
      await r.del(`hist:${phone}`);
      await r.del(`pending:${phone}`);
      await r.del(`lock:${phone}`);
      await r.del(`iaoff:${phone}`);
      await sendWhatsApp(sendTo, "Conversa resetada. Pode começar o teste!");
      return res.status(200).json({ ok: true });
    }

    // ── IA OFF: Redis é a fonte de verdade ──
    if (await r.get(`iaoff:${phone}`)) return res.status(200).json({ ok: true });

    // ── DEBOUNCE: acumula mensagens por 8s antes de processar ──
    const DEBOUNCE_MS = 10000;
    await r.rpush(`pending:${phone}`, text);
    await r.expire(`pending:${phone}`, 60);

    // Tenta adquirir lock exclusivo (só uma invocação processa por vez)
    const gotLock = await r.set(`lock:${phone}`, "1", "NX", "EX", 60);
    if (!gotLock) {
      // Outra invocação já está aguardando — só acumulamos e saímos
      return res.status(200).json({ ok: true });
    }

    // Tem o lock: espera o debounce para capturar mensagens que chegarem juntas
    await new Promise(resolve => setTimeout(resolve, DEBOUNCE_MS));

    // Lê e limpa todas as mensagens acumuladas
    const pending = await r.lrange(`pending:${phone}`, 0, -1);
    await r.del(`pending:${phone}`);
    await r.del(`lock:${phone}`);

    if (!pending || pending.length === 0) return res.status(200).json({ ok: true });

    // Une tudo em uma só mensagem para o Claude
    const combinedText = pending.join("\n");

    // ── Detectar fluxo na primeira mensagem ──
    const history = await getHistory(phone);
    const isFirstMessage = history.length === 0;

    if (isFirstMessage) {
      const flow = detectFlow(combinedText);
      await r.set(`fluxo:${phone}`, flow, "EX", 60 * 60 * 24 * 90);
      await r.sadd(`phones:${flow}`, phone);
      // Etiqueta de entrada no funil
      const labels = FUNNEL_LABELS[flow];
      if (labels?.lead) await applyLabel(phone, labels.lead);
      // Agendar envio de mídia first_contact após resposta (via flag)
      await r.set(`sendmedia:first:${phone}`, "1", "EX", 300);
    }

    const flow = (await r.get(`fluxo:${phone}`)) || "organico";

    // ── Mídia: segunda mensagem ──
    const isSecondMessage = history.length === 1; // 1 msg de histórico = cliente está na 2ª
    if (isSecondMessage) {
      await r.set(`sendmedia:second:${phone}`, "1", "EX", 300);
    }

    // ── Etiqueta "respondeu" a partir da segunda mensagem ──
    if (!isFirstMessage && flow === "protese") {
      const jaRespondeu = await r.get(`label:respondeu:${phone}`);
      if (!jaRespondeu) {
        await applyLabel(phone, FUNNEL_LABELS.protese.respondeu);
        await r.set(`label:respondeu:${phone}`, "1", "EX", 60 * 60 * 24 * 90);
      }
    }

    // ── Montar prompt com contexto de fluxo ──
    const systemPrompt = await getPrompt();
    const horaBrasilia = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hour12: false });
    const fullPrompt   = `${systemPrompt}

---
HORÁRIO ATUAL EM BRASÍLIA: ${horaBrasilia}. Use este horário para definir a saudação correta: 05h-11h59 = "Bom dia", 12h-17h59 = "Boa tarde", 18h-04h59 = "Boa noite". NUNCA use saudação diferente do horário atual.

---
${FLOW_CONTEXT[flow] || FLOW_CONTEXT.organico}

Quando a conversa exigir intervenção humana, finalize sua resposta com a tag [ESCALAR]. Isso inclui SEMPRE: pedidos de marcar, remarcar, confirmar ou cancelar horário/agendamento; qualquer ação que você não executa sozinho (agendar, mudar/cancelar plano, reembolso, resolver pagamento específico); reclamações graves; ou pedidos fora do seu escopo. Nesses casos, ANTES da tag, mande uma resposta curta e calorosa deixando claro que a equipe vai assumir e retornar rapidinho (ex.: "perfeito, já vou pedir pra equipe reservar seu horário e te confirmo já já"). NUNCA tente marcar você mesmo, não mande só um link achando que resolve, e não diga que "já está agendado" — quem agenda é a equipe. O importante é não deixar o cliente no vácuo.
Quando o cliente demonstrar interesse claro em avançar (quer saber mais, pergunta sobre processo, demonstra intenção), adicione a tag [INTERESSOU].
Quando o cliente confirmar ou combinar uma avaliação presencial, adicione a tag [AGENDOU].
As tags são invisíveis para o cliente — use apenas quando realmente aplicável.`;

    // ── Montar conteúdo do usuário (visão se houver imagem pendente) ──
    const imgRaw = await r.get(`img:${phone}`);
    let userContent;
    if (imgRaw) {
      await r.del(`img:${phone}`);
      const img = JSON.parse(imgRaw);
      userContent = [
        { type: "image", source: { type: "base64", media_type: img.mimetype, data: img.base64 } },
        { type: "text", text: combinedText },
      ];
    } else {
      userContent = combinedText;
    }

    // Para o histórico, salva só texto (sem base64 para não estourar Redis)
    const histText = typeof userContent === "string"
      ? userContent
      : (userContent.find(c => c.type === "text")?.text || "[imagem]");

    history.push({ role: "user", content: histText });

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: fullPrompt,
      messages: [...history.slice(0, -1), { role: "user", content: userContent }],
    });

    let reply = response.content[0].text;

    // ── Processar tags do Claude ──
    if (reply.includes("[ESCALAR]")) {
      reply = reply.replace("[ESCALAR]", "").trim();
      await r.set(`iaoff:${phone}`, "1", "EX", 60 * 60 * 24 * 30);
      // Marca como verificado recentemente para evitar race condition: se o cliente
      // mandar outra mensagem antes do label ser aplicado no WhatsApp, o cache
      // garante que o bot já sabe que está iaoff e não responde.
      await r.set(`iaoff:checked:${phone}`, "1", "EX", 300);
      await applyLabel(phone, "IA OFF ❌");
      await notifyEscalation(phone, combinedText); // avisa humano(s) ativamente
    }

    if (reply.includes("[INTERESSOU]") && flow === "protese") {
      reply = reply.replace("[INTERESSOU]", "").trim();
      const jaInteressou = await r.get(`label:interessou:${phone}`);
      if (!jaInteressou) {
        await applyLabel(phone, FUNNEL_LABELS.protese.interessou);
        await r.set(`label:interessou:${phone}`, "1", "EX", 60 * 60 * 24 * 90);
        // Enviar mídias configuradas para trigger "on_interest"
        const mediaItems = await getFlowMedia(r, flow);
        for (const item of mediaItems.filter(m => m.trigger === "on_interest")) {
          await sendMedia(sendTo, item);
        }
      }
    }

    if (reply.includes("[AGENDOU]") && flow === "protese") {
      reply = reply.replace("[AGENDOU]", "").trim();
      await applyLabel(phone, FUNNEL_LABELS.protese.agendou);
    }

    // ── Salvar histórico ──
    history.push({ role: "assistant", content: reply });
    await saveHistory(phone, history);

    // ── Registros para o painel ──
    await r.zadd("conversations", Date.now(), phone);
    await r.set(`last:${phone}`, JSON.stringify({ phone, text: combinedText, reply, ts: Date.now() }), "EX", 60 * 60 * 24 * 30);

    // ── Timestamp de última mensagem real (para follow-up) ──
    await r.set(`lastmsg:${phone}`, Date.now(), "EX", 60 * 60 * 24 * 90);
    await r.del(`followup:${phone}`); // cliente respondeu → reset o funil de follow-up

    // ── Enviar mensagem única com delay e typing ──
    const delay = ms => new Promise(res => setTimeout(res, ms));
    // Delay proporcional ao tamanho da resposta: 5s (curto) a 10s (longo)
    await delay(Math.min(5000 + reply.length * 20, 10000));
    const typingMs = Math.min(1500 + reply.length * 40, 6000);
    await setPresence(sendTo, "composing");
    await delay(typingMs);
    await sendWhatsApp(sendTo, reply.trim());
    await setPresence(sendTo, "paused");

    // ── Enviar mídias first_contact após primeira resposta ──
    const shouldSendFirst = await r.get(`sendmedia:first:${phone}`);
    if (shouldSendFirst) {
      await r.del(`sendmedia:first:${phone}`);
      const mediaItems = await getFlowMedia(r, flow);
      for (const item of mediaItems.filter(m => m.trigger === "first_contact")) {
        await delay(1500);
        await sendMedia(sendTo, item);
      }
    }

    // ── Enviar mídias second_message após segunda resposta ──
    const shouldSendSecond = await r.get(`sendmedia:second:${phone}`);
    if (shouldSendSecond) {
      await r.del(`sendmedia:second:${phone}`);
      const mediaItems = await getFlowMedia(r, flow);
      for (const item of mediaItems.filter(m => m.trigger === "second_message")) {
        await delay(1500);
        await sendMedia(sendTo, item);
      }
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("webhook error:", err);
    return res.status(200).json({ ok: true });
  }
}
