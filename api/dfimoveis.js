/**
 * Integração DF Imóveis / 62 Imóveis  → Bitrix24
 * Autor: Adriano Alves
 * Projeto: kojima-dfimoveis-bitrix
 *
 * Payload esperado (padrão Grupo OLX/ZAP):
 * {
 *   "clientListingId": "a40171",
 *   "name": "Nome Consumidor",
 *   "email": "nome.consumidor@email.com",
 *   "ddd": "61",
 *   "phone": "999999999",
 *   "message": "Olá, tenho interesse neste imóvel.",
 *   "leadOrigin": "DFImoveis", // ou "62imoveis"
 *   "timestamp": "2017-10-23T15:50:30.619Z",
 *   "originLeadId": "59ee0fc6e4b043e1b2a6d863",
 *   "originListingId": "87027856",
 *   "listingUrl": "https://www.dfimoveis.com.br/imovel/ABC123" // (se enviar)
 * }
 *
 * Fonte no Bitrix:
 *  - "Portal DF Imóveis" → renomeamos a fonte "E-mail", então SOURCE_ID = "EMAIL"
 */

const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL;

// (Opcional) responsável padrão
const BITRIX_RESPONSIBLE_ID = process.env.BITRIX_RESPONSIBLE_ID
  ? Number(process.env.BITRIX_RESPONSIBLE_ID)
  : null;

// Fonte DF Imóveis (ID interno da fonte que você renomeou de "E-mail")
const SOURCE_DF_IMOVEIS = "EMAIL";
const SOURCE_62_IMOVEIS = "EMAIL"; // se criar outra fonte, troque aqui

// --------------- Funções auxiliares ---------------

function normalizePhone(ddd, phone) {
  const digitsDDD = (ddd || "").toString().replace(/\D/g, "");
  const digitsPhone = (phone || "").toString().replace(/\D/g, "");
  if (!digitsPhone) return null;
  if (digitsDDD) return `+55${digitsDDD}${digitsPhone}`;
  return `+55${digitsPhone}`;
}

function normalizeEmail(email) {
  const e = (email || "").toString().trim().toLowerCase();
  return e || null;
}

function safeStr(v) {
  return (v === undefined || v === null) ? "" : String(v);
}

function buildListingUrl(listingUrl, originListingId, clientListingId) {
  // se o portal mandar URL, usamos ela
  if (listingUrl) return String(listingUrl);

  // fallback simples (se quiser, depois ajustamos pro padrão real do DF Imóveis)
  const code = clientListingId || originListingId;
  if (code) return `https://www.dfimoveis.com.br/imovel/${encodeURIComponent(code)}`;

  return "";
}

function buildTimelineMessage({
  portalNome,
  leadOrigin,
  codigoImovel,
  listingUrl,
  name,
  fullPhone,
  email,
  message,
  clientListingId,
  originListingId,
  originLeadId,
  timestamp,
}) {
  const urlLine = listingUrl ? `🔗 Link do anúncio: ${listingUrl}\n` : "";

  return (
    `📩 *Novo contato - ${portalNome}*\n\n` +
    `🏷 Código do anúncio: ${codigoImovel}\n` +
    urlLine +
    `👤 Nome: ${safeStr(name) || "Não informado"}\n` +
    `📞 Telefone: ${fullPhone || "Não informado"}\n` +
    `✉️ E-mail: ${email || "Não informado"}\n` +
    `🧭 leadOrigin: ${leadOrigin || ""}\n\n` +
    `📝 Mensagem:\n${safeStr(message) || "(vazia)"}\n\n` +
    `-- Dados técnicos --\n` +
    `clientListingId: ${safeStr(clientListingId)}\n` +
    `originListingId: ${safeStr(originListingId)}\n` +
    `originLeadId: ${safeStr(originLeadId)}\n` +
    `timestamp: ${safeStr(timestamp)}\n`
  );
}

async function bitrixCall(method, params) {
  if (!BITRIX_WEBHOOK_URL) {
    throw new Error("BITRIX_WEBHOOK_URL não definido nas variáveis de ambiente");
  }

  // Bitrix REST exige .json no final
  const url = `${BITRIX_WEBHOOK_URL}/${method}.json`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  let data = {};
  try {
    data = await resp.json();
  } catch (_) {
    data = {};
  }

  if (!resp.ok) {
    console.error(`Bitrix request FAILED [${method}]`, resp.status, data);
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

async function addTimelineCommentToLead(leadId, commentText) {
  // ✅ Isso é o que aparece de verdade na timeline
  return bitrixCall("crm.timeline.comment.add", {
    fields: {
      ENTITY_TYPE: "lead",
      ENTITY_ID: Number(leadId),
      COMMENT: commentText,
    },
  });
}

// --------------- Handler principal ---------------

module.exports = async (req, res) => {
  try {
    console.log("=== INÍCIO /api/dfimoveis ===");
    console.log("Method:", req.method);

    // CORS básico
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

    if (req.method === "OPTIONS") {
      return res.status(200).end();
    }

    // Aceita POST e GET
    if (req.method !== "POST" && req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // ✅ Normaliza payload
    let payload = {};

    if (req.method === "GET") {
      payload = req.query || {};
    } else {
      // POST
      if (!req.body) {
        payload = req.query || {};
        if (!payload || Object.keys(payload).length === 0) {
          return res.status(400).json({ error: "EMPTY_BODY" });
        }
      } else if (typeof req.body === "string") {
        try {
          payload = JSON.parse(req.body);
        } catch (e) {
          console.error("Erro parse JSON:", e);
          return res.status(400).json({ error: "INVALID_JSON" });
        }
      } else {
        payload = req.body;
      }
    }

    console.log("Payload recebido:", JSON.stringify(payload, null, 2));

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
    } = payload;

    // trava anti-lead vazio
    if (!name && !email && !phone) {
      return res.status(400).json({
        error: "MISSING_IDENTITY",
        message: "Precisa de ao menos nome, e-mail ou telefone",
        receivedKeys: Object.keys(payload || {}),
      });
    }

    const originLower = (leadOrigin || "").toString().toLowerCase();
    const is62Imoveis = originLower === "62imoveis";

    let portalNome = "DF Imóveis";
    let sourceId = SOURCE_DF_IMOVEIS;
    let portalOrigemUF = "DF_IMOVEIS";

    if (is62Imoveis) {
      portalNome = "62 Imóveis";
      sourceId = SOURCE_62_IMOVEIS;
      portalOrigemUF = "62_IMOVEIS";
    }

    const fullPhone = normalizePhone(ddd, phone);
    const emailNorm = normalizeEmail(email);

    const codigoImovel = clientListingId || originListingId || "NAO_INFORMADO";
    const anuncioUrl = buildListingUrl(listingUrl, originListingId, clientListingId);

    // Duplicidade
    const duplicates = await findDuplicate(fullPhone, emailNorm);
    const duplicatedLeadId = pickLeadIdFromDuplicates(duplicates);

    // ✅ Monta o comentário definitivo (timeline)
    const timelineText = buildTimelineMessage({
      portalNome,
      leadOrigin,
      codigoImovel,
      listingUrl: anuncioUrl,
      name,
      fullPhone,
      email: emailNorm,
      message,
      clientListingId,
      originListingId,
      originLeadId,
      timestamp,
    });

    // Se duplicou: comenta na timeline do lead existente e encerra
    if (duplicatedLeadId) {
      await addTimelineCommentToLead(duplicatedLeadId, timelineText);

      return res.json({
        status: "DUPLICATE_TIMELINE_COMMENT_CREATED",
        leadId: duplicatedLeadId,
      });
    }

    // Novo lead
    const leadFields = {
      TITLE: `${portalNome} | ${codigoImovel} | ${name || "Sem nome"}`,
      NAME: name || "Contato Portal",
      SOURCE_ID: sourceId,
      SOURCE_DESCRIPTION: `Lead vindo do portal ${portalNome}`,

      // pode manter, mas o que garante timeline é o crm.timeline.comment.add
      COMMENTS: timelineText,

      // ⚠️ Ajuste se seus UF_* forem diferentes
      UF_CODIGO_IMOVEL: codigoImovel,
      UF_PORTAL_ORIGEM: portalOrigemUF,
      UF_DFIMOVEIS_ORIGIN_LEAD_ID: originLeadId || "",
      UF_DFIMOVEIS_ORIGIN_LISTING_ID: originListingId || "",
    };

    if (fullPhone) {
      leadFields.PHONE = [{ VALUE: fullPhone, VALUE_TYPE: "WORK" }];
    }
    if (emailNorm) {
      leadFields.EMAIL = [{ VALUE: emailNorm, VALUE_TYPE: "WORK" }];
    }

    console.log("LeadFields enviados:", JSON.stringify(leadFields, null, 2));

    const leadId = await bitrixCall("crm.lead.add", { fields: leadFields });

    // ✅ GARANTE o comentário na TIMELINE
    await addTimelineCommentToLead(leadId, timelineText);

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
