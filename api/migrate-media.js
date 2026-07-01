import Redis from "ioredis";

let redis;
function getRedis() {
  if (!redis) redis = new Redis(process.env.REDIS_URL);
  return redis;
}

// Migra dados do formato antigo (media:{flow} JSON array) para o novo (keys individuais)
export default async function handler(req, res) {
  if (req.headers["x-panel-password"] !== process.env.PANEL_PASSWORD)
    return res.status(401).json({ error: "unauthorized" });

  const r = getRedis();
  const flows = ["protese", "clube", "organico"];
  const results = {};

  for (const flow of flows) {
    const raw = await r.get(`media:${flow}`);
    if (!raw) { results[flow] = "sem dados antigos"; continue; }

    let items;
    try { items = JSON.parse(raw); } catch { results[flow] = "erro parse"; continue; }
    if (!Array.isArray(items) || items.length === 0) { results[flow] = "vazio"; continue; }

    const EX = 60 * 60 * 24 * 365;
    let migrated = 0;
    for (const item of items) {
      const id = Math.random().toString(36).slice(2, 10);
      const { data, ...meta } = item;
      await r.set(`media:${flow}:${id}:meta`, JSON.stringify(meta), "EX", EX);
      await r.set(`media:${flow}:${id}:data`, data, "EX", EX);
      await r.rpush(`media:${flow}:ids`, id);
      await r.expire(`media:${flow}:ids`, EX);
      migrated++;
    }
    // Remove chave antiga após migrar
    await r.del(`media:${flow}`);
    results[flow] = `${migrated} item(s) migrado(s)`;
  }

  return res.status(200).json({ ok: true, results });
}
