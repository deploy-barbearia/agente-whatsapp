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

  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: "phone required" });

  const r = getRedis();
  const raw = await r.get(`hist:${phone}`);
  const history = raw ? JSON.parse(raw) : [];

  return res.status(200).json({ history });
}
