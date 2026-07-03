import Redis from "ioredis";

let redis;
function getRedis() {
  if (!redis) redis = new Redis(process.env.REDIS_URL);
  return redis;
}

export default async function handler(req, res) {
  // Protegido pela senha do painel
  const auth = req.headers["x-export-secret"];
  if (auth !== process.env.PANEL_PASSWORD) return res.status(401).json({ error: "unauthorized" });

  const r = getRedis();
  const flows = ["protese", "clube", "organico"];
  const EX = 60 * 60 * 24 * 365;

  // Prompt
  const prompt = await r.get("prompt:system");

  // Follow-up config
  const followupRaw = await r.get("config:followup");
  const followup = followupRaw ? JSON.parse(followupRaw) : null;

  // Phones por fluxo + lastmsg + stage
  const phoneData = {};
  for (const flow of flows) {
    const phones = await r.smembers(`phones:${flow}`);
    phoneData[flow] = [];
    for (const phone of phones) {
      const lastmsg = await r.get(`lastmsg:${phone}`);
      const stage = await r.get(`followup:${phone}`);
      phoneData[flow].push({ phone, lastmsg, stage });
    }
  }

  // Mídia
  const media = {};
  for (const flow of flows) {
    const ids = await r.lrange(`media:${flow}:ids`, 0, -1);
    media[flow] = [];
    for (const id of ids) {
      const meta = await r.get(`media:${flow}:${id}:meta`);
      const data = await r.get(`media:${flow}:${id}:data`);
      if (meta) media[flow].push({ id, meta: JSON.parse(meta), data });
    }
  }

  return res.status(200).json({ prompt, followup, phoneData, media });
}
