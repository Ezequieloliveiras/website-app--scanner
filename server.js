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
const APP_WEB_URL = process.env.APP_WEB_URL;
const CHECKOUT_RESULT_ROUTES = new Set(["/billing/success", "/billing/cancel", "/billing/expired"]);
const BACKEND_TIMEOUT_MS = Number(process.env.BACKEND_TIMEOUT_MS || 10000);
const GLOBAL_RATE_LIMIT_MAX = Number(process.env.LANDING_RATE_LIMIT_MAX_PER_MINUTE || 120);
const CHECKOUT_RATE_LIMIT_MAX = Number(process.env.LANDING_CHECKOUT_RATE_LIMIT_MAX || 8);
const CHECKOUT_RATE_LIMIT_WINDOW_MS = Number(process.env.LANDING_CHECKOUT_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const rateLimitBuckets = new Map();
let lastRateLimitCleanupAt = Date.now();

const server = createServer(async (request, response) => {
  try {
    setSecurityHeaders(response);
    enforceRateLimit(request, response, {
      keyPrefix: "global",
      max: GLOBAL_RATE_LIMIT_MAX,
      windowMs: 60 * 1000
    });

    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    if (request.method === "GET" && url.pathname === "/api/plans") {
      return sendJson(response, 200, await listPlans());
    }

    if (request.method === "POST" && url.pathname === "/api/checkout") {
      enforceRateLimit(request, response, {
        keyPrefix: "checkout",
        max: CHECKOUT_RATE_LIMIT_MAX,
        windowMs: CHECKOUT_RATE_LIMIT_WINDOW_MS
      });
      const payload = await readJson(request);
      const result = await createCheckout(payload, request);
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
  console.log(`Landing BipaAí em http://localhost:${PORT}`);
});

async function createCheckout(payload, request) {
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

  const checkout = await requestLogScanCheckout(plan, session, lead);
  const isFreePlan = plan.id === "free";

  if (!checkout.checkoutUrl && !isFreePlan) {
    throw publicError("Não consegui gerar o checkout do Asaas. Confira o valor do plano e as chaves ASAAS no backend.", 502);
  }

  return {
    status: checkout.status || "pending",
    checkoutUrl: checkout.checkoutUrl || getSuccessUrl(request, plan.id),
    message: checkout.message || "Conta criada. Você já pode acessar o BipaAí."
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
    throw publicError("A senha precisa ter pelo menos 8 caracteres, com maiúscula, minúscula e número.", 400);
  }
  if (![11, 14].includes(cpfCnpj.length)) throw publicError("Informe um CPF ou CNPJ válido.", 400);
  if (phoneNumber.length < 10 || phoneNumber.length > 11) throw publicError("Informe um WhatsApp com DDD válido.", 400);
  if (postalCode.length !== 8) throw publicError("Informe um CEP válido.", 400);
  if (!address) throw publicError("Informe o logradouro.", 400);
  if (!addressNumber) throw publicError("Informe o número do endereço.", 400);
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
    throw publicError(result.data?.message || "Não consegui criar o checkout no BipaAí.", result.status);
  }

  return result.data;
}

async function callBackend(pathname, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);

  try {
    const requestOptions = {
      method: options.method,
      signal: controller.signal,
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
    throw publicError("Não consegui conectar no backend do BipaAí.", 502);
  } finally {
    clearTimeout(timeout);
  }
}

async function listPlans() {
  const result = await callBackend("/api/billing/plans", { method: "GET" });

  if (!result.ok || !Array.isArray(result.data)) {
    throw publicError(result.data?.message || "Não consegui carregar os planos no backend.", result.status || 502);
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

  if ((!filePath.startsWith(`${publicDir}${path.sep}`) && filePath !== publicDir) || !existsSync(filePath)) {
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

function getSuccessUrl(request, planId) {
  if (APP_WEB_URL && !isLocalUrl(APP_WEB_URL)) {
    return APP_WEB_URL;
  }
  if (process.env.NODE_ENV === "production") {
    throw publicError("Configure APP_WEB_URL com a URL pública da landing em produção.", 500);
  }
  const host = request.headers["x-forwarded-host"] || request.headers.host || `localhost:${PORT}`;
  const proto = request.headers["x-forwarded-proto"] || (String(host).includes("localhost") ? "http" : "https");
  return `${String(proto).split(",")[0]}://${String(host).split(",")[0]}/billing/success?plan=${encodeURIComponent(planId)}`;
}

function isLocalUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  } catch {
    return false;
  }
}

function publicError(message, statusCode = 500) {
  const error = new Error(message);
  error.publicMessage = message;
  error.statusCode = statusCode;
  return error;
}

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'"
    ].join("; ")
  );

  if (process.env.NODE_ENV === "production") {
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

function enforceRateLimit(request, response, options) {
  const now = Date.now();
  cleanupRateLimits(now);

  const key = `${options.keyPrefix}:${getClientIp(request)}`;
  const bucket = rateLimitBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + options.windowMs });
    response.setHeader("RateLimit-Limit", String(options.max));
    response.setHeader("RateLimit-Remaining", String(Math.max(options.max - 1, 0)));
    return;
  }

  bucket.count += 1;
  response.setHeader("RateLimit-Limit", String(options.max));
  response.setHeader("RateLimit-Remaining", String(Math.max(options.max - bucket.count, 0)));
  response.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

  if (bucket.count > options.max) {
    throw publicError("Muitas requisições. Tente novamente em instantes.", 429);
  }
}

function getClientIp(request) {
  const cfIp = request.headers["cf-connecting-ip"];
  if (typeof cfIp === "string" && cfIp) return cfIp;

  const forwardedFor = request.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }

  return request.socket.remoteAddress || "unknown";
}

function cleanupRateLimits(now) {
  if (now - lastRateLimitCleanupAt < 60000) return;
  lastRateLimitCleanupAt = now;

  for (const [key, bucket] of rateLimitBuckets) {
    if (bucket.resetAt <= now) {
      rateLimitBuckets.delete(key);
    }
  }
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



