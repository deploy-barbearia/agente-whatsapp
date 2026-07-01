export default async function handler(req, res) {
  const auth = req.headers["x-panel-password"];
  if (auth !== process.env.PANEL_PASSWORD)
    return res.status(401).json({ error: "unauthorized" });

  if (req.method !== "GET")
    return res.status(405).json({ error: "method not allowed" });

  try {
    const url = `${process.env.EVOLUTION_API_URL}/instance/connect/${process.env.EVOLUTION_INSTANCE}`;
    const r = await fetch(url, {
      headers: { apikey: process.env.EVOLUTION_API_KEY },
    });
    const data = await r.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
