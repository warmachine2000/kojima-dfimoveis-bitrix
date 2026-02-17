// api/dfimoveis.js
// Endpoint DF Imóveis / 62 Imóveis -> Bitrix
// Suporta:
//  - POST (application/json) conforme VRSYNC
//  - GET (querystring) para testes manuais
//
// CORREÇÃO:
// - O DF Imóveis às vezes não manda URL ou manda URL inválida.
// - O Código do anúncio (ClientListingId / VILLA...) SEMPRE vem.
// - Então o link principal do imóvel será SEMPRE do site Kojima:
//   https://kojimaimoveis.com.br/Imovel/Detalhar?CodigoImovel=VILLAxxxx
// - (Opcional) Se vier URL do DF, guardamos apenas como referência nos comentários.
// - FONTE no Bitrix: usar SOURCE_ID correto do "Portal DF Imóveis" => STATUS_ID = "EMAIL"
//   (configure na Vercel: BITRIX_SOURCE_ID_DFIMOVEIS=EMAIL)

function onlyDigits(str = "") {
  return String(str).replace(/\D+/g, "");
}

function normalizePhoneBR(raw = "") {
  const digits = onlyDigits(raw);
  if (!digits) return { e164: "", digits: "" };

  // Se vier com 55 na frente, remove para validar DDD+numero
  let d = digits;
  if (d.startsWith("55") && d.length >= 12) d = d.slice(2);

  // Esperado: DDD(2) + número (8 ou 9)
  // Se vier curto, retorna o que tiver
  const e164 = d ? `+55${d}` : "";
  return { e164, digits: d };
}

function safeStr(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function normalizeUrl(raw = "") {
  let url = safeStr(raw);
  if (!url) return "";

  if (url.startsWith("www.")) url = "https://" + url;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  // remove double slash no path (mantendo https://)
  url = url.replace(/([^:]\/)\/+/g, "$1");
  return url;
}

// Extrai um “código do anúncio” a partir de vários possíveis campos
function resolveListingCode(input = {}) {
  const direct =
    safeStr(input.listingCode) ||
    safeStr(input.ListingCode) ||
    safeStr(input.ClientListingId) ||
    safeStr(input.clientListingId);

  if (direct) return direct;

  // tenta extrair de URL /imovel/ALGUMACOISA
  const url = safeStr(input.listingUrl) || safeStr(input.ListingUrl) || safeStr(input.listingURL);
  const m = url.match(/\/imovel\/([^/?#]+)/i);
  return m ? m[1] : "NAO_INFORMADO";
}

// URL do DF (se vier), só para referência/diagnóstico
function resolveDfRawUrl(input = {}) {
  const direct =
    safeStr(input.listingUrl) ||
    safeStr(input.ListingUrl) ||
    safeStr(input.listingURL);

  return normalizeUrl(direct);
}

// URL canônica para atendimento: SEMPRE a do site Kojima (Villa Portal resolve por CodigoImovel)
function resolveKojimaListingUrl(input = {}) {
  const code = resolveListingCode(input);
  if (!code || code === "NAO_INFORMADO") return "";

  const base =
    process.env.KOJIMA_LISTING_BASE_URL ||
    "https://kojimaimoveis.com.br/Imovel/Detalhar";

  const sep = base.includes("?") ? "&" : "?";
  return normalizeUrl(`${base}${sep}CodigoImovel=${encodeURIComponent(code)}`);
}

function buildComments(payload = {}) {
  const leadOrigin = safeStr(payload.leadOrigin || payload.LeadOrigin || "dfimoveis");

  const timestamp =
    safeStr(payload.timestamp || payload.Timestamp) ||
    new Date().toISOString();

  const originLeadId = safeStr(payload.originLeadId || payload.OriginLeadId);
  const originListingId = safeStr(payload.originListingId || payload.OriginListingId);

  const name = safeStr(payload.name || payload.Name);
  const email = safeStr(payload.email || payload.Email);
  const phoneRaw = safeStr(payload.phone || payload.Phone || payload.PhoneNumber);
  const { e164 } = normalizePhoneBR(phoneRaw);

  const listingCode = resolveListingCode(payload);

  // Principal (atendimento)
  const listingUrl = resolveKojimaListingUrl(payload);

  // Referência (se vier do DF)
  const dfUrl = resolveDfRawUrl(payload);

  const msg = safeStr(payload.message || payload.Message);

  const lines = [];

  lines.push(`*Novo contato - DF Imóveis*`);
  lines.push(``);
  lines.push(`Código do anúncio: ${listingCode}`);
  if (listingUrl) lines.push(`Link do imóvel (Kojima): ${listingUrl}`);
  if (dfUrl) lines.push(`Link original (DF): ${dfUrl}`);
  if (name) lines.push(`Nome: ${name}`);
  if (e164) lines.push(`Telefone: ${e164}`);
  if (email) lines.push(`E-mail: ${email}`);
  lines.push(`leadOrigin: ${leadOrigin}`);
  lines.push(``);

  lines.push(`Mensagem:`);
  lines.push(msg || "(sem mensagem)");
  lines.push(``);

  lines.push(`-- Dados técnicos --`);
  lines.push(`timestamp: ${timestamp}`);
  if (originLeadId) lines.push(`originLeadId: ${originLeadId}`);
  if (originListingId) lines.push(`originListingId: ${originListingId}`);

  return lines.join("\n");
}

async function callBitrix(method, params) {
  const base = process.env.BITRIX_WEBHOOK_BASE_URL; // ex: https://SEU.bitrix24.com.br/rest/1/xxxxxxxxx
  if (!base) {
    throw new Error("MISSING_ENV: BITRIX_WEBHOOK_BASE_URL");
  }

  const url = `${base}/${method}.json`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok || data.error) {
    const msg = data.error_description || data.error || `HTTP_${resp.status}`;
    const err = new Error(`BITRIX_REQUEST_FAILED (${resp.status}) ${method} - ${msg}`);
    err.bitrix = data;
    throw err;
  }

  return data;
}

function parseIncoming(req) {
  // 1) POST JSON (VRSYNC)
  // 2) GET querystring (teste manual)
  if (req.method === "POST") return req.body || {};

  // GET
  const q = req.query || {};
  return {
    leadOrigin: q.leadOrigin,
    timestamp: q.timestamp,
    originLeadId: q.originLeadId,
    name: q.name,
    email: q.email,
    phone: q.phone,
    clientListingId: q.clientListingId,
    originListingId: q.originListingId,
    listingCode: q.listingCode,
    listingUrl: q.listingUrl,
    message: q.message,
  };
}

function validateIdentity(p = {}) {
  const name = safeStr(p.name || p.Name);
  const email = safeStr(p.email || p.Email);
  const phone = safeStr(p.phone || p.Phone || p.PhoneNumber);

  if (!name && !email && !phone) {
    const err = new Error("MISSING_IDENTITY");
    err.statusCode = 400;
    err.publicMessage = "Precisa de ao menos nome, e-mail ou telefone";
    throw err;
  }
}

export default async function handler(req, res) {
  try {
    // Healthcheck simples
    if (req.method === "GET" && req.query && req.query.ping === "1") {
      return res.status(200).json({ ok: true, pong: true });
    }

    const incoming = parseIncoming(req);

    // Modo “ajuda” para vocês (retorna exemplo do payload que o DF deve mandar)
    if (req.method === "GET" && req.query && req.query.mode === "sample") {
      return res.status(200).json({
        ok: true,
        expected: {
          LeadOrigin: "DFimoveis",
          Timestamp: new Date().toISOString(),
          OriginLeadId: "uuid",
          Name: "Teste",
          Email: "teste@gmail.com",
          Phone: "(61) 99999-9999",
          PhoneNumber: "(61) 99999-9999",
          ClientListingId: "VILLA152067V01",
          OriginListingId: 1227330,
          Message: "teste",
        },
      });
    }

    validateIdentity(incoming);

    // Normaliza dados
    const name = safeStr(incoming.name || incoming.Name);
    const email = safeStr(incoming.email || incoming.Email);

    const phoneRaw = safeStr(incoming.phone || incoming.Phone || incoming.PhoneNumber);
    const { e164 } = normalizePhoneBR(phoneRaw);

    const leadOrigin = safeStr(incoming.leadOrigin || incoming.LeadOrigin || "dfimoveis");

    const listingCode = resolveListingCode(incoming);

    // URL canônica de atendimento: Kojima
    const listingUrl = resolveKojimaListingUrl(incoming);

    // Fonte (SOURCE_ID) — Portal DF Imóveis no seu Bitrix é STATUS_ID="EMAIL"
    // Configure na Vercel: BITRIX_SOURCE_ID_DFIMOVEIS=EMAIL
    // (fallback hardcoded para garantir que não caia em "Chamada" se a env estiver ausente)
    const sourceId = process.env.BITRIX_SOURCE_ID_DFIMOVEIS || "EMAIL";

    // Campo custom URL de origem (UF_CRM_ORIGIN_URL)
    const originUrlField = process.env.BITRIX_FIELD_ORIGIN_URL || "";

    const comments = buildComments({
      ...incoming,
      leadOrigin,
      listingCode,
      name,
      email,
      phone: phoneRaw,
    });

    // Monta payload do Lead
    const leadFields = {
      TITLE: `DF Imóveis | ${listingCode} | ${name || "Novo Lead"}`,
      NAME: name || "",
      COMMENTS: comments,
      SOURCE_ID: sourceId, // <<< ajuste final
    };

    if (e164) {
      leadFields.PHONE = [{ VALUE: e164, VALUE_TYPE: "WORK" }];
    }
    if (email) {
      leadFields.EMAIL = [{ VALUE: email, VALUE_TYPE: "WORK" }];
    }

    // UF_CRM_ORIGIN_URL (se configurado) - vamos gravar a URL do Kojima, que é a útil
    if (originUrlField && listingUrl) {
      leadFields[originUrlField] = listingUrl;
    }

    const created = await callBitrix("crm.lead.add", { fields: leadFields });
    const leadId = created?.result;

    return res.status(200).json({
      status: "LEAD_CREATED",
      leadId,
      listingCode,
      leadOrigin,
      listingUrl,
      sourceId,
      receivedMethod: req.method,
    });
  } catch (err) {
    const status = err.statusCode || 500;

    return res.status(status).json({
      error: status === 500 ? "INTERNAL_ERROR" : "BAD_REQUEST",
      message: err.publicMessage || err.message || "UNKNOWN_ERROR",
      details: err.bitrix || undefined,
    });
  }
}
