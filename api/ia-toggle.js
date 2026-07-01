import Redis from "ioredis";

let redis;
function getRedis() {
  if (!redis) redis = new Redis(process.env.REDIS_URL);
  return redis;
}

// GET  ?phone=xxx  → { iaoff: true|false }
// POST { phone, iaoff: true|false } → liga/desliga IA para o contato
export default async function handler(req, res) {
  if (req.headers["x-panel-password"] !== process.env.PANEL_PASSWORD)
    return res.status(401).json({ error: "unauthorized" });

  const r = getRedis();

  if (req.method === "GET") {
    const phone = req.query.phone;
    if (!phone) return res.status(400).json({ error: "phone required" });
    const off = await r.get(`iaoff:${phone}`);
    return res.status(200).json({ iaoff: !!off });
  }

  if (req.method === "POST") {
    const { phone, iaoff } = req.body;
    if (!phone) return res.status(400).json({ error: "phone required" });
    if (iaoff) {
      await r.set(`iaoff:${phone}`, "1", "EX", 60 * 60 * 24 * 30);
    } else {
      await r.del(`iaoff:${phone}`);
    }
    return res.status(200).json({ ok: true, iaoff });
  }

  return res.status(405).json({ error: "method not allowed" });
}
