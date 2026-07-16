import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

loadEnv();

const PORT = Number(process.env.PORT || 5175);
const APP_BACKEND_URL = trimTrailingSlash(process.env.APP_BACKEND_URL || "http://localhost:3333");
const APP_WEB_URL = process.env.APP_WEB_URL || "http://localhost:5175/billing/success?plan=free";
const CHECKOUT_RESULT_ROUTES = new Set(["/billing/success", "/billing/cancel", "/billing/expired"]);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    if (request.method === "GET" && url.pathname === "/api/plans") {
      return sendJson(response, 200, await listPlans());
    }

    if (request.method === "POST" && url.pathname === "/api/checkout") {
      const payload = await readJson(request);
      const result = await createCheckout(payload);
      return sendJson(response, 200, result);
    }

    if (request.method === "GET" && CHECKOUT_RESULT_ROUTES.has(url.pathname)) {
      return serveStatic("/checkout-result.html", response);
    }

    if (request.method === "GET") {
      return serveStatic(url.pathname, response);
    }

    return sendJson(response, 405, { message: "Método não permitido." });
  } catch (error) {
    const status = error.statusCode || 500;
    return sendJson(response, status, {
      message: error.publicMessage || error.message || "Erro inesperado ao processar solicitação."
    });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`A porta ${PORT} já está em uso. Feche o outro servidor ou altere PORT no .env.`);
    process.exit(1);
  }

  throw error;
});

server.listen(PORT, () => {
  console.log(`Landing Bipaai em http://localhost:${PORT}`);
});

async function createCheckout(payload) {
  const plan = await getPlan(payload.plan);
  const lead = normalizeLead(payload);

  if (plan.id === "custom") {
    return {
      status: "contact",
      checkoutUrl: process.env.CUSTOM_PLAN_CONTACT_URL || "mailto:comercial@bipaai.app",
      message: "Vamos direcionar você para o contato comercial."
    };
  }

  const session = await createOrLoginLogScanUser(lead);

  if (plan.id === "free") {
    return {
      status: "free",
      checkoutUrl: APP_WEB_URL,
      message: "Conta criada. Você já pode acessar o Bipaai."
    };
  }

  const checkout = await requestLogScanCheckout(plan, session, lead);

  return {
    status: checkout.status || "pending",
    checkoutUrl: checkout.checkoutUrl,
    message: checkout.message || "Checkout de assinatura criado com sucesso."
  };
}

function normalizeLead(payload) {
  const name = String(payload.name || "").trim();
  const email = String(payload.email || "").trim().toLowerCase();
  const password = String(payload.password || "").trim();
  const company = String(payload.company || "").trim();
  const cpfCnpj = String(payload.cpfCnpj || "").replace(/\D/g, "");
  const phoneNumber = String(payload.phoneNumber || payload.phone || "").replace(/\D/g, "");
  const postalCode = String(payload.postalCode || "").replace(/\D/g, "");
  const address = String(payload.address || "").trim();
  const addressNumber = String(payload.addressNumber || "").trim();
  const province = String(payload.province || "").trim();

  if (!name || name.length < 3) throw publicError("Informe seu nome.", 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw publicError("Informe um e-mail válido.", 400);
  if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}/.test(password)) {
    throw publicError("A senha precisa ter pelo menos 8 caracteres, com maiuscula, minuscula e numero.", 400);
  }
  if (![11, 14].includes(cpfCnpj.length)) throw publicError("Informe um CPF ou CNPJ válido.", 400);
  if (phoneNumber.length < 10 || phoneNumber.length > 11) throw publicError("Informe um WhatsApp com DDD válido.", 400);
  if (postalCode.length !== 8) throw publicError("Informe um CEP válido.", 400);
  if (!address) throw publicError("Informe o logradouro.", 400);
  if (!addressNumber) throw publicError("Informe o numero do endereco.", 400);
  if (!province) throw publicError("Informe o bairro.", 400);

  return { name, email, password, company, cpfCnpj, phoneNumber, postalCode, address, addressNumber, province };
}

async function createOrLoginLogScanUser(lead) {
  if (!APP_BACKEND_URL) return {};

  const registerResult = await callBackend("/api/auth/register", {
    method: "POST",
    body: { name: lead.name, email: lead.email, password: lead.password }
  });

  if (registerResult.ok) return registerResult.data;

  if (registerResult.status !== 409) {
    throw publicError(registerResult.data?.message || "Não consegui criar a conta no LogScan.", registerResult.status);
  }

  const loginResult = await callBackend("/api/auth/login", {
    method: "POST",
    body: { email: lead.email, password: lead.password }
  });

  if (!loginResult.ok) {
    throw publicError(loginResult.data?.message || "Este e-mail já existe. Entre com a senha correta.", loginResult.status);
  }

  return loginResult.data;
}

async function requestLogScanCheckout(plan, session, lead) {
  if (!session?.token) {
    throw publicError("Não consegui autenticar sua conta para iniciar o checkout.", 401);
  }

  const result = await callBackend("/api/billing/checkout", {
    method: "POST",
    token: session.token,
    body: {
      plan: plan.id,
      cpfCnpj: lead.cpfCnpj,
      phoneNumber: lead.phoneNumber,
      postalCode: lead.postalCode,
      address: lead.address,
      addressNumber: lead.addressNumber,
      province: lead.province
    }
  });

  if (!result.ok) {
    throw publicError(result.data?.message || "Não consegui criar o checkout no Bipaai.", result.status);
  }

  if (!result.data?.checkoutUrl) {
    throw publicError(result.data?.message || "Checkout criado sem URL.", 502);
  }

  return result.data;
}

async function callBackend(pathname, options) {
  try {
    const requestOptions = {
      method: options.method,
      headers: {
        "Content-Type": "application/json",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
      }
    };

    if (options.body !== undefined) {
      requestOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(`${APP_BACKEND_URL}${pathname}`, {
      ...requestOptions
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  } catch {
    throw publicError("Não consegui conectar no backend do Bipaai.", 502);
  }
}

async function listPlans() {
  const result = await callBackend("/api/billing/plans", { method: "GET" });

  if (!result.ok || !Array.isArray(result.data)) {
    throw publicError(result.data?.message || "Nao consegui carregar os planos no backend.", result.status || 502);
  }

  return result.data;
}

async function getPlan(planId) {
  const plans = await listPlans();
  const plan = plans.find((item) => item.id === String(planId || "").trim());
  if (!plan) throw publicError("Plano inválido.", 400);
  return plan;
}

async function serveStatic(requestPath, response) {
  const safePath = requestPath === "/" ? "/index.html" : decodeURIComponent(requestPath);
  const filePath = path.normalize(path.join(publicDir, safePath));

  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    return sendJson(response, 404, { message: "Arquivo não encontrado." });
  }

  const body = await readFile(filePath);
  response.writeHead(200, { "Content-Type": contentType(filePath) });
  response.end(body);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".svg": "image/svg+xml"
    }[ext] || "application/octet-stream"
  );
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(publicError("Payload muito grande.", 413));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(publicError("JSON inválido.", 400));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function publicError(message, statusCode = 500) {
  const error = new Error(message);
  error.publicMessage = message;
  error.statusCode = statusCode;
  return error;
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!existsSync(envPath)) return;

  const content = awaitableReadEnv(envPath);
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function awaitableReadEnv(envPath) {
  return existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
}
