import Redis from "ioredis";

let redis;
function getRedis() {
  if (!redis) redis = new Redis(process.env.REDIS_URL);
  return redis;
}

function checkAuth(req) {
  return req.headers["x-panel-password"] === process.env.PANEL_PASSWORD;
}

// Config de escalonamento (para onde avisar quando um cliente precisa de humano)
// Guardado no Redis (fora do git) — { numbers: ["55..."], groupSubject: "GRUPO DA FIRMA" }
export default async function handler(req, res) {
  if (!checkAuth(req)) return res.status(401).json({ error: "unauthorized" });

  const r = getRedis();

  if (req.method === "GET") {
    const raw = await r.get("config:escalation");
    return res.status(200).json(raw ? JSON.parse(raw) : { numbers: [], groupSubject: "" });
  }

  if (req.method === "POST") {
    const { numbers, groupSubject } = req.body || {};
    const cfg = {
      numbers: Array.isArray(numbers) ? numbers.filter(Boolean) : [],
      groupSubject: groupSubject || "",
    };
    await r.set("config:escalation", JSON.stringify(cfg));
    // Invalida o cache do JID do grupo (caso o nome tenha mudado)
    if (cfg.groupSubject) await r.del(`groupjid:${cfg.groupSubject}`);
    return res.status(200).json({ ok: true, config: cfg });
  }

  return res.status(405).json({ error: "method not allowed" });
}
