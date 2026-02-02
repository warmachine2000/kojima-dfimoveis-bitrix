/**
 * Integração DF Imóveis / 62 Imóveis  → Bitrix24
 * Autor: Adriano Alves
 * Projeto: kojima-dfimoveis-bitrix
 *
 * Payload esperado (padrão Grupo OLX/ZAP):
 * {
 *   "clientListingId": "a40171",
 *   "name": "Nome Consumidor",
 *   "email": "nome@email.com",
 *   "ddd": "61",
 *   "phone": "999999999",
 *   "message": "Olá, tenho interesse neste imóvel.",
 *   "leadOrigin": "DFImoveis", // ou "62imoveis"
 *   "timestamp": "2017-10-23T15:50:30.619Z",
 *   "originLeadId": "59ee0fc6e4b043e1b2a6d863",
 *   "originListingId": "87027856",
 *   "listingUrl": "https://..." // (se o portal mandar)
 * }
 */

const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL;

// SOURCE_ID (ajuste se quiser separar DF e 62)
const SOURCE_DF_IMOVEIS = process.env.SOURCE_DF_IMOVEIS || "EMAIL";
const SOURCE_62_IMOVEIS = process.env.SOURCE_62_IMOVEIS || "EMAIL";

// Campos UF (opcionais) — só preenche se você definir no Vercel
const UF_CODIGO_IMOVEL_FIELD = process.env.UF_CODIGO_IMOVEL_FIELD || null;
const UF_PORTAL_ORIGEM_FIELD = process.env.UF_PORTAL_ORIGEM_FIELD || null;
const UF_ORIGIN_LEAD_ID_FIELD = process.env.UF_ORIGIN_LEAD_ID_FIELD || null;
const UF_ORIGIN_LISTING_ID_FIELD = process.env.UF_ORIGIN_LISTING_ID_FIELD || null;

// Montagem de URL do anúncio (se não vier no payload)
const DF_LISTING_URL_TEMPLATE =
  process.env.DF_LISTING_URL_TEMPLATE || "https://www.dfimoveis.com.br/imovel/{id}";

// --------------- Helpers ---------------

function normalizePhone(ddd, phone) {
  const digitsDDD = (ddd || "").toString().replace(/\D/g, "");
  const digitsPhone = (phone || "").toString().replace(/\D/g, "");
  if (!digitsPhone) return null;
  if (digitsDDD) return `+55${digitsDDD}${digitsPhone}`;
  return `+55${digitsPhone}`;
}

function safeStr(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

function buildListingUrl(listingUrlFromPayload, originListingId, clientListingId) {
  const raw = safeStr(listingUrlFromPayload).trim();
  if (raw) return raw;

  const id = safeStr(originListingId || clientListingId).trim();
  if (!id) return "";

  return DF_LISTING_URL_TEMPLATE.replace("{id}", encodeURIComponent(id));
}

function getCodigoAnuncio(clientListingId, originListingId) {
  return safeStr(originListingId || clientListingId || "NAO_INFORMADO").trim() || "NAO_INFORMADO";
}

function buildMensagemDefinitiva({
  portalNome,
  leadOrigin,
  timestamp,
  name,
  fullPhone,
  email,
  codigoAnuncio,
  listingUrl,
  clientListingId,
  originListingId,
  originLeadId,
  message,
}) {
  const ts = safeStr(timestamp).trim() || new Date().toISOString();

  const lines = [
    "🔹 NOVO LEAD – DF IMÓVEIS",
    "",
    `Portal: ${portalNome}`,
    `LeadOrigin: ${safeStr(leadOrigin).trim() || ""}`,
    `Data/Hora: ${ts}`,
    "",
    "👤 Cliente",
    `Nome: ${safeStr(name).trim() || "Não informado"}`,
    `Telefone: ${fullPhone || "não informado"}`,
    `E-mail: ${safeStr(email).trim() || "não informado"}`,
    "",
    "🏠 Imóvel",
    `Código do anúncio: ${codigoAnuncio}`,
    `URL do anúncio: ${listingUrl || ""}`,
    "",
    "🆔 Identificadores Técnicos",
    `clientListingId: ${safeStr(clientListingId).trim()}`,
    `originListingId: ${safeStr(originListingId).trim()}`,
    `originLeadId: ${safeStr(originLeadId).trim()}`,
    "",
    "📝 Mensagem do cliente:",
    safeStr(message).trim(),
  ];

  return lines.join("\n").trim();
}

async function bitrixCall(method, params) {
  if (!BITRIX_WEBHOOK_URL) {
    throw new Error("BITRIX_WEBHOOK_URL não definido nas variáveis de ambiente");
  }

  // Bitrix REST exige .json
  const url = `${BITRIX_WEBHOOK_URL.replace(/\/$/, "")}/${method}.json`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params || {}),
  });

  let data = {};
  try {
    data = await resp.json();
  } catch (_) {
    data = {};
  }

  if (!resp.ok) {
    throw new Error(
      `BITRIX_REQUEST_FAILED (${resp.status}) [${method}] - ${JSON.stringify(data)}`
    );
  }

  if (data && data.error) {
    throw new Error(
      `BITRIX_API_ERROR [${method}] ${data.error}: ${data.error_description || ""}`
    );
  }

  return data.result;
}

async function findDuplicate(phone, email) {
  const duplicates = { PHONE: null, EMAIL: null };

  if (phone) {
    try {
      duplicates.PHONE = await bitrixCall("crm.duplicate.findbycomm", {
        type: "PHONE",
        values: [phone],
      });
    } catch (e) {
      console.warn("Erro duplicidade telefone:", e.message);
    }
  }

  if (email) {
    try {
      duplicates.EMAIL = await bitrixCall("crm.duplicate.findbycomm", {
        type: "EMAIL",
        values: [email],
      });
    } catch (e) {
      console.warn("Erro duplicidade email:", e.message);
    }
  }

  return duplicates;
}

function pickLeadIdFromDuplicates(duplicates) {
  const leadFromPhone = duplicates?.PHONE?.LEAD?.[0];
  const leadFromEmail = duplicates?.EMAIL?.LEAD?.[0];
  return leadFromPhone || leadFromEmail || null;
}

function hasLeadDuplicate(duplicates) {
  const leadIdsPhone = duplicates?.PHONE?.LEAD || [];
  const leadIdsEmail = duplicates?.EMAIL?.LEAD || [];
  return (leadIdsPhone.length > 0) || (leadIdsEmail.length > 0);
}

async function addTimelineCommentToLead(leadId, comment) {
  // Método que funcionou no seu teste:
  // crm.timeline.comment.add com ENTITY_TYPE = "lead"
  return bitrixCall("crm.timeline.comment.add", {
    fields: {
      ENTITY_TYPE: "lead",
      ENTITY_ID: Number(leadId),
      COMMENT: comment,
    },
  });
}

// --------------- Handler ---------------

module.exports = async (req, res) => {
  try {
    // CORS básico
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST" && req.method !== "GET") {
      return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
    }

    // Normaliza payload
    let payload = {};
    if (req.method === "GET") {
      payload = req.query || {};
    } else {
      if (!req.body) {
        payload = req.query || {};
      } else if (typeof req.body === "string") {
        try {
          payload = JSON.parse(req.body);
        } catch (e) {
          return res.status(400).json({ error: "INVALID_JSON" });
        }
      } else {
        payload = req.body;
      }
    }

    const {
      clientListingId,
      name,
      email,
      ddd,
      phone,
      message,
      leadOrigin,
      timestamp,
      originLeadId,
      originListingId,
      listingUrl,
    } = payload || {};

    // trava anti-lead vazio
    if (!name && !email && !phone) {
      return res.status(400).json({
        error: "MISSING_IDENTITY",
        message: "Precisa de ao menos nome, e-mail ou telefone",
        receivedKeys: Object.keys(payload || {}),
      });
    }

    // Origem DFImoveis / 62imoveis
    const originLower = safeStr(leadOrigin).toLowerCase();
    const is62Imoveis = originLower === "62imoveis";

    const portalNome = is62Imoveis ? "62 Imóveis" : "DF Imóveis";
    const sourceId = is62Imoveis ? SOURCE_62_IMOVEIS : SOURCE_DF_IMOVEIS;
    const portalOrigemUF = is62Imoveis ? "62_IMOVEIS" : "DF_IMOVEIS";

    const fullPhone = normalizePhone(ddd, phone);
    const codigoAnuncio = getCodigoAnuncio(clientListingId, originListingId);
    const finalListingUrl = buildListingUrl(listingUrl, originListingId, clientListingId);

    const mensagemDefinitiva = buildMensagemDefinitiva({
      portalNome,
      leadOrigin,
      timestamp,
      name,
      fullPhone,
      email,
      codigoAnuncio,
      listingUrl: finalListingUrl,
      clientListingId,
      originListingId,
      originLeadId,
      message,
    });

    // Deduplicação
    const duplicates = await findDuplicate(fullPhone, email);
    const isDuplicate = hasLeadDuplicate(duplicates);

    if (isDuplicate) {
      const leadId = pickLeadIdFromDuplicates(duplicates);

      // Comentário na timeline do Lead existente
      await addTimelineCommentToLead(
        leadId,
        `*Novo contato (duplicado) - ${portalNome}*\n\n${mensagemDefinitiva}`
      );

      return res.json({
        status: "DUPLICATE_TIMELINE_COMMENT_CREATED",
        leadId,
      });
    }

    // Novo lead
    const leadFields = {
      TITLE: `${portalNome} | ${codigoAnuncio} | ${safeStr(name).trim() || "Sem nome"}`,
      NAME: safeStr(name).trim() || "Contato Portal",
      SOURCE_ID: sourceId,
      SOURCE_DESCRIPTION: `Lead vindo do portal ${portalNome}`,
      COMMENTS: mensagemDefinitiva,
    };

    if (fullPhone) {
      leadFields.PHONE = [{ VALUE: fullPhone, VALUE_TYPE: "WORK" }];
    }

    if (email) {
      leadFields.EMAIL = [{ VALUE: safeStr(email).trim(), VALUE_TYPE: "WORK" }];
    }

    // Campos UF opcionais (só se você setar os nomes corretos no Vercel)
    if (UF_CODIGO_IMOVEL_FIELD) leadFields[UF_CODIGO_IMOVEL_FIELD] = codigoAnuncio;
    if (UF_PORTAL_ORIGEM_FIELD) leadFields[UF_PORTAL_ORIGEM_FIELD] = portalOrigemUF;
    if (UF_ORIGIN_LEAD_ID_FIELD) leadFields[UF_ORIGIN_LEAD_ID_FIELD] = safeStr(originLeadId).trim();
    if (UF_ORIGIN_LISTING_ID_FIELD)
      leadFields[UF_ORIGIN_LISTING_ID_FIELD] = safeStr(originListingId).trim();

    const leadId = await bitrixCall("crm.lead.add", { fields: leadFields });

    return res.json({
      status: "LEAD_CREATED",
      leadId,
    });
  } catch (err) {
    console.error("ERRO GERAL /api/dfimoveis:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: err.message,
    });
  }
};
