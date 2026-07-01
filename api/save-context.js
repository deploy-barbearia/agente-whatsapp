import Redis from "ioredis";

let redis;
function getRedis() {
  if (!redis) redis = new Redis(process.env.REDIS_URL);
  return redis;
}

// POST { phone, role: "user"|"assistant", content }
// Salva mensagem no histórico do agente para dar contexto a respostas futuras
export default async function handler(req, res) {
  if (req.headers["x-panel-password"] !== process.env.PANEL_PASSWORD)
    return res.status(401).json({ error: "unauthorized" });

  if (req.method !== "POST")
    return res.status(405).json({ error: "method not allowed" });

  const { phone, role, content } = req.body;
  if (!phone || !role || !content)
    return res.status(400).json({ error: "phone, role and content required" });

  const r = getRedis();
  const key = `hist:${phone}`;
  const raw = await r.get(key);
  const history = raw ? JSON.parse(raw) : [];

  history.push({ role, content });

  // Mantém só as últimas 20 mensagens
  await r.set(key, JSON.stringify(history.slice(-20)), "EX", 60 * 60 * 24 * 7);

  // Registra o fluxo como "clube" se ainda não tiver fluxo definido
  const hasFlow = await r.get(`fluxo:${phone}`);
  if (!hasFlow) {
    await r.set(`fluxo:${phone}`, "clube", "EX", 60 * 60 * 24 * 90);
    await r.sadd("phones:clube", phone);
  }

  return res.status(200).json({ ok: true, total: history.length });
}
