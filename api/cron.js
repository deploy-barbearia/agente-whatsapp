import Anthropic from "@anthropic-ai/sdk";
import Redis from "ioredis";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let redis;
function getRedis() {
  if (!redis) redis = new Redis(process.env.REDIS_URL);
  return redis;
}

const DAY = 24 * 60 * 60 * 1000;

const DEFAULT_CONFIG = {
  protese:  { active: true, days: [1, 3, 7], instruction: "Objetivo: retomar a conversa de forma natural, com base no que foi dito, e conduzir para o agendamento de uma avaliação presencial gratuita. Sem emojis. Direto. Máximo 2 frases." },
  clube:    { active: true, days: [1, 3, 7], instruction: "Objetivo: retomar a conversa com base no contexto e fechar a adesão ao plano do Clube VIP. Sem emojis. Direto. Máximo 2 frases." },
  organico: { active: true, days: [3],       instruction: "Objetivo: retomar a conversa de forma simples e verificar se o cliente ainda precisa de algo. Sem emojis. Direto. Máximo 2 frases." },
};

async function getConfig(r) {
  const raw = await r.get("config:followup");
  return raw ? JSON.parse(raw) : DEFAULT_CONFIG;
}

async function sendWhatsApp(phone, text) {
  await fetch(
    `${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: process.env.EVOLUTION_API_KEY,
      },
      body: JSON.stringify({ number: phone, text }),
    }
  );
}

async function generateFollowUp(flow, history, instruction) {
  const systemPrompt = `Você é o assistente da Barbearia do Regis. O cliente parou de responder.\nLeia o histórico e escreva UMA mensagem de retomada.\n${instruction}`;
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 200,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: `Histórico da conversa:\n${history.map(m => `${m.role === "user" ? "Cliente" : "Atendente"}: ${m.content}`).join("\n")}\n\nEscreva a mensagem de retomada.`,
      },
    ],
  });
  return response.content[0].text.trim();
}

export default async function handler(req, res) {
  const auth = req.headers["authorization"];
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const r = getRedis();
  const now = Date.now();
  const results = { checked: 0, sent: 0, skipped: 0 };
  const config = await getConfig(r);

  for (const flow of ["protese", "clube", "organico"]) {
    const flowConfig = config[flow] || DEFAULT_CONFIG[flow];
    if (!flowConfig.active) continue;

    const phones = await r.smembers(`phones:${flow}`);
    const stageLimits = flowConfig.days || [3];

    for (const phone of phones) {
      results.checked++;

      if (await r.get(`iaoff:${phone}`)) { results.skipped++; continue; }

      const lastMsgRaw = await r.get(`lastmsg:${phone}`);
      if (!lastMsgRaw) continue;

      const daysSince = (now - parseInt(lastMsgRaw)) / DAY;

      const stageRaw = await r.get(`followup:${phone}`);
      const stage = stageRaw ? parseInt(stageRaw) : 0;

      if (stage >= stageLimits.length) { results.skipped++; continue; }

      if (daysSince >= stageLimits[stage]) {
        try {
          const histRaw = await r.get(`hist:${phone}`);
          const history = histRaw ? JSON.parse(histRaw) : [];

          // Sem histórico, sem contexto → pular
          if (history.length === 0) continue;

          const message = await generateFollowUp(flow, history, flowConfig.instruction);
          await sendWhatsApp(phone, message);
          await r.set(`followup:${phone}`, stage + 1, "EX", 60 * 60 * 24 * 30);
          results.sent++;

          // Registra log do follow-up enviado
          const logEntry = JSON.stringify({
            ts: now,
            phone,
            flow,
            stage: stage + 1,
            message,
            daysSince: Math.round(daysSince * 10) / 10,
          });
          await r.lpush("log:followups", logEntry);
          await r.ltrim("log:followups", 0, 199); // mantém últimos 200

          console.log(`follow-up [${flow}] stage ${stage + 1} → ${phone}: "${message}"`);
        } catch (err) {
          console.error(`follow-up error for ${phone}:`, err.message);
        }
      }
    }
  }

  console.log("cron results:", results);
  return res.status(200).json({ ok: true, ...results });
}
