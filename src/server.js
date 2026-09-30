import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Cofre, loadEnv } from "./engine.js";
import { deliverAlerts, telegramConfig } from "./telegram.js";
import { inboxStatus, launchText, startInbox } from "./inbox.js";

loadEnv();

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const publicDir = path.join(root, "public");
const cofre = new Cofre();

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";
let lastWatch = { at: null, sent: 0, error: null };

async function watchSafely() {
  try {
    const result = await deliverAlerts(cofre);
    lastWatch = { at: new Date().toISOString(), sent: result.sent, error: null, reason: result.reason ?? null };
    if (result.sent > 0) console.log(`Telegram: ${result.sent} alerta(s).`);
  } catch (error) {
    lastWatch = { at: new Date().toISOString(), sent: 0, error: error.message };
    console.error(`Telegram: ${error.message}`);
  }
}

if (telegramConfig(cofre)) {
  setTimeout(watchSafely, 8000);
  setInterval(watchSafely, 30 * 60 * 1000);
}
if (process.env.COFRE_INBOX !== "0") startInbox(cofre);

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 100_000) {
        reject(Object.assign(new Error("Corpo grande demais"), { status: 413 }));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("JSON inválido"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function statePayload() {
  return {
    ...cofre.snapshot(),
    telegram: {
      ...inboxStatus(cofre),
      configured: Boolean(telegramConfig(cofre)),
      lastWatch,
    },
  };
}

function replyState(res) {
  send(res, 200, JSON.stringify(statePayload()));
  if (telegramConfig(cofre)) watchSafely();
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.resolve(publicDir, `.${requested}`);
  if (filePath !== publicDir && !filePath.startsWith(`${publicDir}${path.sep}`)) {
    send(res, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    send(res, 404, "Not found", "text/plain; charset=utf-8");
    return;
  }
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  send(res, 200, fs.readFileSync(filePath), types[path.extname(filePath)] || "application/octet-stream");
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/api/state") {
      send(res, 200, JSON.stringify(statePayload()));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/launch") {
      const body = await readBody(req);
      const result = launchText(cofre, body.text, {
        note: body.note,
      });
      if (!result.ok) {
        const error = new Error(result.error);
        error.code = result.code;
        error.status = 400;
        throw error;
      }
      replyState(res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/transactions") {
      const body = await readBody(req);
      cofre.addTransaction(body);
      replyState(res);
      return;
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/api/transactions/")) {
      await readBody(req);
      cofre.deleteTransaction(url.pathname.split("/").pop());
      replyState(res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/cards") {
      const body = await readBody(req);
      cofre.addCard(body);
      replyState(res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/budgets") {
      const body = await readBody(req);
      cofre.setBudget(body.category, body.limit);
      replyState(res);
      return;
    }
    if (req.method === "GET") {
      serveStatic(req, res);
      return;
    }
    send(res, 404, JSON.stringify({ error: "Rota não encontrada" }));
  } catch (error) {
    const status = error.status || 400;
    send(res, status, JSON.stringify({ error: error.message, code: error.code ?? null }));
  }
});

server.listen(port, host, () => {
  console.log(`Cofre em http://${host}:${port}`);
});
