import Redis from "ioredis";

let redis;
function getRedis() {
  if (!redis) redis = new Redis(process.env.REDIS_URL);
  return redis;
}

function checkAuth(req) {
  return req.headers["x-panel-password"] === process.env.PANEL_PASSWORD;
}

// GET  /api/media-config?flow=protese           → lista ids do fluxo + metadados
// POST /api/media-config  { flow, id, type, data, caption, trigger }  → salva item
// DELETE /api/media-config?flow=x&id=y          → remove item
export default async function handler(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: "unauthorized" });

  const r = getRedis();

  if (req.method === "GET") {
    const flow = req.query.flow;
    if (!flow) return res.status(400).json({ error: "flow required" });
    const ids = await r.lrange(`media:${flow}:ids`, 0, -1);
    const items = [];
    for (const id of ids) {
      const meta = await r.get(`media:${flow}:${id}:meta`);
      const data = await r.get(`media:${flow}:${id}:data`);
      if (meta && data) items.push({ id, ...JSON.parse(meta), data });
    }
    return res.status(200).json({ items });
  }

  if (req.method === "POST") {
    const { flow, id, type, data, caption, trigger } = req.body;
    if (!flow || !id || !type || !data) return res.status(400).json({ error: "missing fields" });
    const EX = 60 * 60 * 24 * 365;
    // salva metadados e dados separados para evitar payload gigante no GET
    await r.set(`media:${flow}:${id}:meta`, JSON.stringify({ type, caption, trigger }), "EX", EX);
    await r.set(`media:${flow}:${id}:data`, data, "EX", EX);
    // adiciona id na lista se ainda não estiver
    const ids = await r.lrange(`media:${flow}:ids`, 0, -1);
    if (!ids.includes(id)) await r.rpush(`media:${flow}:ids`, id);
    await r.expire(`media:${flow}:ids`, EX);
    return res.status(200).json({ ok: true });
  }

  if (req.method === "DELETE") {
    const { flow, id } = req.query;
    if (!flow || !id) return res.status(400).json({ error: "flow and id required" });
    await r.del(`media:${flow}:${id}:meta`);
    await r.del(`media:${flow}:${id}:data`);
    await r.lrem(`media:${flow}:ids`, 0, id);
    return res.status(200).json({ ok: true });
  }

  // PATCH: atualizar só metadados (caption/trigger) sem re-enviar o arquivo
  if (req.method === "PATCH") {
    const { flow, id, caption, trigger } = req.body;
    if (!flow || !id) return res.status(400).json({ error: "missing fields" });
    const raw = await r.get(`media:${flow}:${id}:meta`);
    const meta = raw ? JSON.parse(raw) : {};
    if (caption !== undefined) meta.caption = caption;
    if (trigger !== undefined) meta.trigger = trigger;
    await r.set(`media:${flow}:${id}:meta`, JSON.stringify(meta), "EX", 60 * 60 * 24 * 365);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "method not allowed" });
}
