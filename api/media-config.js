export const config = {
  api: { bodyParser: { sizeLimit: "20mb" } },
};

import Redis from "ioredis";

let redis;
function getRedis() {
  if (!redis) redis = new Redis(process.env.REDIS_URL);
  return redis;
}

function checkAuth(req) {
  return req.headers["x-panel-password"] === process.env.PANEL_PASSWORD;
}

// GET  /api/media-config?flow=protese  → lista mídias do fluxo
// POST /api/media-config               → { flow, items: [{type,data,caption,trigger}] }
// DELETE /api/media-config             → { flow, index }
export default async function handler(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: "unauthorized" });

  const r = getRedis();

  if (req.method === "GET") {
    const flow = req.query.flow;
    if (!flow) return res.status(400).json({ error: "flow required" });
    const raw = await r.get(`media:${flow}`);
    return res.status(200).json({ items: raw ? JSON.parse(raw) : [] });
  }

  if (req.method === "POST") {
    const { flow, items } = req.body;
    if (!flow || !items) return res.status(400).json({ error: "flow and items required" });
    await r.set(`media:${flow}`, JSON.stringify(items));
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "method not allowed" });
}
