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
async function sendWhatsApp(phone, text) {
  await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: process.env.EVOLUTION_API_KEY },
    body: JSON.stringify({ number: phone, text }),
  });
}

async function applyLabel(phone, label) {
  try {
    await fetch(`${process.env.EVOLUTION_API_URL}/label/handleLabel/${process.env.EVOLUTION_INSTANCE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: process.env.EVOLUTION_API_KEY },
      body: JSON.stringify({ number: phone, label, action: "add" }),
    });
  } catch {}
}

// ── HANDLER ───────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).json({ ok: true });

  try {
    const body = req.body;
    const event = body?.event;

    // ── Evento de etiqueta (IA OFF manual pela equipe) ──
    if (event === "labels.edit") {
      const r = getRedis();
      const label = (body?.data?.label?.name || "").toLowerCase().trim();
      const jid   = body?.data?.id?.remote || body?.data?.remoteJid || "";
      const phone = jid.replace("@s.whatsapp.net", "");
      const type  = body?.data?.type || body?.data?.action || "";

      if (phone && label === "ia off") {
        if (type === "add") {
          await r.set(`iaoff:${phone}`, "1", "EX", 60 * 60 * 24 * 30);
        } else {
          await r.del(`iaoff:${phone}`);
        }
      }
      return res.status(200).json({ ok: true });
    }

    if (event !== "messages.upsert") return res.status(200).json({ ok: true });

    const msg = body?.data;
    if (!msg || msg.key?.fromMe) return res.status(200).json({ ok: true });

    const remoteJid = msg.key?.remoteJid || "";
    if (remoteJid.includes("@g.us")) return res.status(200).json({ ok: true });

    const phone = remoteJid.replace("@s.whatsapp.net", "");
    const text  = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
    if (!text) return res.status(200).json({ ok: true });

    const r = getRedis();

    // ── IA OFF: ignorar este cliente ──
    if (await r.get(`iaoff:${phone}`)) return res.status(200).json({ ok: true });

    // ── Detectar fluxo na primeira mensagem ──
    const history = await getHistory(phone);
    if (history.length === 0) {
      const flow = detectFlow(text);
      await r.set(`fluxo:${phone}`, flow, "EX", 60 * 60 * 24 * 90);
      await r.sadd(`phones:${flow}`, phone);
    }

    const flow = (await r.get(`fluxo:${phone}`)) || "organico";

    // ── Montar prompt com contexto de fluxo ──
    const systemPrompt = await getPrompt();
    const fullPrompt   = `${systemPrompt}

---
${FLOW_CONTEXT[flow] || FLOW_CONTEXT.organico}

Quando a conversa exigir intervenção humana (situações complexas, reclamações graves, pedidos fora do seu escopo), finalize sua resposta com a tag [ESCALAR] no final.`;

    history.push({ role: "user", content: text });

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: fullPrompt,
      messages: history,
    });

    let reply = response.content[0].text;

    // ── Auto-escalonamento via [ESCALAR] ──
    if (reply.includes("[ESCALAR]")) {
      reply = reply.replace("[ESCALAR]", "").trim();
      await r.set(`iaoff:${phone}`, "1", "EX", 60 * 60 * 24 * 30);
      await applyLabel(phone, "IA OFF");
    }

    // ── Salvar histórico ──
    history.push({ role: "assistant", content: reply });
    await saveHistory(phone, history);

    // ── Registros para o painel ──
    await r.zadd("conversations", Date.now(), phone);
    await r.set(`last:${phone}`, JSON.stringify({ phone, text, reply, ts: Date.now() }), "EX", 60 * 60 * 24 * 30);

    // ── Timestamp de última mensagem real (para follow-up) ──
    await r.set(`lastmsg:${phone}`, Date.now(), "EX", 60 * 60 * 24 * 90);
    await r.del(`followup:${phone}`); // cliente respondeu → reset o funil de follow-up

    await sendWhatsApp(phone, reply);
    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("webhook error:", err);
    return res.status(200).json({ ok: true });
  }
}
