import Anthropic from "@anthropic-ai/sdk";
import Redis from "ioredis";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let redis;
function getRedis() {
  if (!redis) redis = new Redis(process.env.REDIS_URL);
  return redis;
}

const DAY = 24 * 60 * 60 * 1000;

// Quantos dias esperar por estágio de follow-up
const STAGES = {
  protese:  [1, 3, 7],
  clube:    [1, 3, 7],
  organico: [3],
};

const FOLLOWUP_PROMPT = {
  protese: `Você é o assistente da Barbearia do Regis. O cliente demonstrou interesse em prótese capilar mas parou de responder.
Leia o histórico abaixo e escreva UMA mensagem de retomada de conversa.
Regras:
- Sem emojis
- Sem frases de desculpa ou "não quero incomodar"
- Direto, confiante, como quem tem algo de valor a oferecer
- Retome pelo ponto exato onde a conversa parou (dúvida não respondida, próximo passo não dado)
- O objetivo final é marcar a avaliação presencial gratuita
- Máximo 2 frases`,

  clube: `Você é o assistente da Barbearia do Regis. O cliente demonstrou interesse no Clube VIP mas parou de responder.
Leia o histórico abaixo e escreva UMA mensagem de retomada de conversa.
Regras:
- Sem emojis
- Sem frases de desculpa ou "não quero incomodar"
- Direto, confiante, como quem tem algo de valor a oferecer
- Retome pelo ponto exato onde a conversa parou
- O objetivo final é fechar a adesão ao plano
- Máximo 2 frases`,

  organico: `Você é o assistente da Barbearia do Regis. O cliente entrou em contato mas parou de responder.
Leia o histórico abaixo e escreva UMA mensagem de retomada de conversa.
Regras:
- Sem emojis
- Direto e objetivo
- Retome pelo ponto exato onde a conversa parou
- Máximo 2 frases`,
};

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

async function generateFollowUp(flow, history) {
  const systemPrompt = FOLLOWUP_PROMPT[flow] || FOLLOWUP_PROMPT.organico;
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

  for (const flow of ["protese", "clube", "organico"]) {
    const phones = await r.smembers(`phones:${flow}`);
    const stageLimits = STAGES[flow] || [3];

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

          const message = await generateFollowUp(flow, history);
          await sendWhatsApp(phone, message);
          await r.set(`followup:${phone}`, stage + 1, "EX", 60 * 60 * 24 * 30);
          results.sent++;
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
