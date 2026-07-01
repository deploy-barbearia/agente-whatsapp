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
        "Oi! 👋 Vi que você entrou em contato sobre nossa *prótese capilar*. Ficou com alguma dúvida que eu possa esclarecer? Tenho casos reais de transformação que posso te mostrar 📸",
    },
    {
      afterDays: 3,
      message:
        "Olá! Ainda pensando na prótese capilar? 😊 A *avaliação presencial é gratuita e sem nenhum compromisso* — você vem, a gente analisa seu caso pessoalmente e você decide com calma. Que dia ficaria bom pra você?",
    },
    {
      afterDays: 7,
      message:
        "Oi! 💈 Não quero te incomodar, mas tenho uma vaga disponível essa semana pra avaliação gratuita de prótese capilar. Se ainda tiver interesse, é só responder aqui! Qualquer dúvida, estou à disposição. 🤝",
    },
  ],
  clube: [
    {
      afterDays: 1,
      message:
        "Oi! 👋 Vi que você perguntou sobre o nosso *Clube VIP*. Posso te explicar direitinho como funciona e quais os benefícios? É bem vantajoso! 💈",
    },
    {
      afterDays: 3,
      message:
        "Olá! 😊 Ainda pensando no Clube VIP? As vagas desse mês estão quase todas preenchidas. Posso te reservar uma enquanto há tempo? Me conta o que tá travando sua decisão que eu te ajudo!",
    },
    {
      afterDays: 7,
      message:
        "Oi! Última mensagem sobre o *Clube VIP*, prometo 😄 Ainda temos uma vaga esse mês. Se quiser garantir a sua, é só falar aqui. Se mudar de ideia depois, sem problema — seja bem-vindo! ✂️",
    },
  ],
  organico: [
    {
      afterDays: 3,
      message:
        "Oi! 👋 Tudo bem? Precisando de alguma coisa, é só falar. Estou à disposição para tirar dúvidas ou agendar um horário 💈",
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
