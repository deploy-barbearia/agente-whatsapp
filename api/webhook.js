import Anthropic from "@anthropic-ai/sdk";
import Redis from "ioredis";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let redis;
function getRedis() {
  if (!redis) redis = new Redis(process.env.REDIS_URL);
  return redis;
}

async function getPrompt() {
  const r = getRedis();
  const stored = await r.get("prompt:system");
  return stored || process.env.DEFAULT_PROMPT || "Você é um assistente virtual.";
}

async function getHistory(phone) {
  const r = getRedis();
  const raw = await r.get(`hist:${phone}`);
  return raw ? JSON.parse(raw) : [];
}

async function saveHistory(phone, history) {
  const r = getRedis();
  // manter apenas as últimas 20 mensagens
  const trimmed = history.slice(-20);
  await r.set(`hist:${phone}`, JSON.stringify(trimmed), "EX", 60 * 60 * 24 * 7);
}

async function sendWhatsApp(phone, text) {
  const url = `${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`;
  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: process.env.EVOLUTION_API_KEY,
    },
    body: JSON.stringify({
      number: phone,
      text,
    }),
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).json({ ok: true });

  try {
    const body = req.body;

    // Evolution API v2 payload
    const event = body?.event;
    if (event !== "messages.upsert") return res.status(200).json({ ok: true });

    const msg = body?.data;
    if (!msg) return res.status(200).json({ ok: true });

    // ignorar mensagens enviadas pelo próprio número
    if (msg.key?.fromMe) return res.status(200).json({ ok: true });

    // ignorar grupos
    const remoteJid = msg.key?.remoteJid || "";
    if (remoteJid.includes("@g.us")) return res.status(200).json({ ok: true });

    const phone = remoteJid.replace("@s.whatsapp.net", "");
    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      "";

    if (!text) return res.status(200).json({ ok: true });

    // buscar prompt e histórico
    const systemPrompt = await getPrompt();
    const history = await getHistory(phone);

    // adicionar mensagem do usuário ao histórico
    history.push({ role: "user", content: text });

    // chamar Claude
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      messages: history,
    });

    const reply = response.content[0].text;

    // salvar resposta no histórico
    history.push({ role: "assistant", content: reply });
    await saveHistory(phone, history);

    // registrar conversa recente para o painel
    const r = getRedis();
    await r.zadd("conversations", Date.now(), phone);
    await r.set(`last:${phone}`, JSON.stringify({ phone, text, reply, ts: Date.now() }), "EX", 60 * 60 * 24 * 30);

    // enviar resposta no WhatsApp
    await sendWhatsApp(phone, reply);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("webhook error:", err);
    return res.status(200).json({ ok: true }); // sempre 200 pro Evolution API
  }
}
