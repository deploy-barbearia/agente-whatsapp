import Redis from "ioredis";

let redis;
function getRedis() {
  if (!redis) redis = new Redis(process.env.REDIS_URL);
  return redis;
}

const DEFAULT_CONFIG = {
  protese: {
    active: true,
    days: [1, 3, 7],
    instruction: "Objetivo: retomar a conversa de forma natural, com base no que foi dito, e conduzir para o agendamento de uma avaliação presencial gratuita. Sem emojis. Direto. Máximo 2 frases.",
  },
  clube: {
    active: true,
    days: [1, 3, 7],
    instruction: "Objetivo: retomar a conversa com base no contexto e fechar a adesão ao plano do Clube VIP. Sem emojis. Direto. Máximo 2 frases.",
  },
  organico: {
    active: true,
    days: [3],
    instruction: "Objetivo: retomar a conversa de forma simples e verificar se o cliente ainda precisa de algo. Sem emojis. Direto. Máximo 2 frases.",
  },
};

function checkAuth(req) {
  return req.headers["x-panel-password"] === process.env.PANEL_PASSWORD;
}

export default async function handler(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: "unauthorized" });

  const r = getRedis();

  if (req.method === "GET") {
    const raw = await r.get("config:followup");
    const config = raw ? JSON.parse(raw) : DEFAULT_CONFIG;
    return res.status(200).json({ config });
  }

  if (req.method === "POST") {
    const { config } = req.body;
    if (!config) return res.status(400).json({ error: "config required" });
    await r.set("config:followup", JSON.stringify(config));
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "method not allowed" });
}
