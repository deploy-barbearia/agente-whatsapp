import Redis from "ioredis";

let redis;
function getRedis() {
  if (!redis) redis = new Redis(process.env.REDIS_URL);
  return redis;
}

function checkAuth(req) {
  const auth = req.headers["x-panel-password"];
  return auth === process.env.PANEL_PASSWORD;
}

export default async function handler(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: "unauthorized" });
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });

  const r = getRedis();

  // pegar os 20 contatos mais recentes
  const phones = await r.zrevrange("conversations", 0, 19);

  const conversations = await Promise.all(
    phones.map(async (phone) => {
      const raw = await r.get(`last:${phone}`);
      return raw ? JSON.parse(raw) : { phone, ts: 0 };
    })
  );

  return res.status(200).json({ conversations });
}
