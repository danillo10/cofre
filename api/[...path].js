export default async function handler(req, res) {
  const origin = process.env.COFRE_API_ORIGIN?.replace(/\/$/, "");
  if (!origin) {
    res.status(503).json({ error: "COFRE_API_ORIGIN não configurado" });
    return;
  }

  const incoming = new URL(req.url, "http://cofre.local");
  const target = `${origin}${incoming.pathname}${incoming.search}`;
  const headers = { accept: req.headers.accept || "application/json" };
  const init = { method: req.method, headers };

  if (req.method !== "GET" && req.method !== "HEAD") {
    headers["content-type"] = "application/json";
    init.body = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
  }

  const response = await fetch(target, init);
  const body = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get("content-type");
  if (type) res.setHeader("content-type", type);
  res.status(response.status).send(body);
}
