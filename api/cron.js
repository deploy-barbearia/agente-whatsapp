import Redis from "ioredis";

let redis;
function getRedis() {
  if (!redis) redis = new Redis(process.env.REDIS_URL);
  return redis;
}

const DAY = 24 * 60 * 60 * 1000;

// Templates por fluxo — índice = sequência de follow-up (0 = primeiro, 1 = segundo...)
const FOLLOW_UPS = {
  protese: [
    {
      afterDays: 1,
      message:
        "Você perguntou sobre a prótese capilar aqui na Barbearia do Regis. Pode mandar sua dúvida que te respondo agora.",
    },
    {
      afterDays: 3,
      message:
        "A avaliação presencial é gratuita e a gente analisa o seu caso do zero. Qual dia da semana funciona melhor pra você?",
    },
    {
      afterDays: 7,
      message:
        "Temos uma vaga disponível essa semana para avaliação de prótese capilar. Se quiser garantir, fala aqui.",
    },
  ],
  clube: [
    {
      afterDays: 1,
      message:
        "Você perguntou sobre o Clube VIP aqui na barbearia. Qual parte do plano você quer entender melhor?",
    },
    {
      afterDays: 3,
      message:
        "As vagas do Clube VIP desse mês estão no limite. Se quiser entrar, é agora que a gente resolve.",
    },
    {
      afterDays: 7,
      message:
        "Última vaga disponível no Clube VIP esse mês. Fala aqui se quiser garantir a sua.",
    },
  ],
  organico: [
    {
      afterDays: 3,
      message:
        "Você entrou em contato com a Barbearia do Regis. Pode mandar sua dúvida ou me dizer o que precisa.",
    },
  ],
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

export default async function handler(req, res) {
  // Autenticação: Vercel envia Bearer ${CRON_SECRET} automaticamente
  const auth = req.headers["authorization"];
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const r = getRedis();
  const now = Date.now();
  const results = { checked: 0, sent: 0, skipped: 0 };

  for (const flow of ["protese", "clube", "organico"]) {
    const phones = await r.smembers(`phones:${flow}`);
    const templates = FOLLOW_UPS[flow] || [];

    for (const phone of phones) {
      results.checked++;

      // IA OFF ativo → pular
      if (await r.get(`iaoff:${phone}`)) {
        results.skipped++;
        continue;
      }

      // Último timestamp de mensagem real do cliente
      const lastMsgRaw = await r.get(`lastmsg:${phone}`);
      if (!lastMsgRaw) continue;

      const daysSince = (now - parseInt(lastMsgRaw)) / DAY;

      // Estágio atual do funil de follow-up (quantos já foram enviados)
      const stageRaw = await r.get(`followup:${phone}`);
      const stage = stageRaw ? parseInt(stageRaw) : 0;

      // Já enviou todos os follow-ups → não incomodar mais
      if (stage >= templates.length) {
        results.skipped++;
        continue;
      }

      const next = templates[stage];
      if (daysSince >= next.afterDays) {
        try {
          await sendWhatsApp(phone, next.message);
          await r.set(`followup:${phone}`, stage + 1, "EX", 60 * 60 * 24 * 30);
          results.sent++;
          console.log(`follow-up [${flow}] stage ${stage + 1} → ${phone}`);
        } catch (err) {
          console.error(`follow-up error for ${phone}:`, err.message);
        }
      }
    }
  }

  console.log("cron results:", results);
  return res.status(200).json({ ok: true, ...results });
}
