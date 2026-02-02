/**
 * Integração DF Imóveis / 62 Imóveis  → Bitrix24
 * Autor: Adriano Alves
 * Projeto: kojima-dfimoveis-bitrix
 *
 * Payload esperado (padrão Grupo OLX/ZAP):
 *
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
 *   "originListingId": "87027856"
 * }
 *
 * Fonte no Bitrix:
 *  - "Portal DF Imóveis" (ou renomeada internamente) -> SOURCE_ID
 */

const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || null;

// (Opcional) responsável padrão para atividades/atribuição futura (se quiser usar)
const BITRIX_RESPONSIBLE_ID = process.env.BITRIX_RESPONSIBLE_ID
  ? Number(process.env.BITRIX_RESPONSIBLE_ID)
  : null;

// Fonte DF Imóveis (ID interno da fonte no Bitrix)
const SOURCE_DF_IMOVEIS = "EMAIL";

// Se quiser fonte separada para 62 Imóveis no futuro:
const SOURCE_62_IMOVEIS = "EMAIL"; // ex: "PORTAL_62IMOVEIS"

// ------------------ Utils ------------------

function normalizePhone(ddd, phone) {
  const digitsDDD = (ddd || "").toString().replace(/\D/g, "");
  const digitsPhone = (phone || "").toString().replace(/\D/g, "");
  if (!digitsPhone) return null;

  // Brasil (+55)
  if (digitsDDD) return `+55${digitsDDD}${digitsPhone}`;
  return `+55${digitsPhone}`;
}

function safeStr(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

function pickToken(req) {
  // 1) Authorization: Bearer <token>
  const rawAuth = req.headers?.authorization || req.headers?.Authorization || "";
  const bearer = safeStr(rawAuth).replace(/^Bearer\s+/i, "").trim();

  // 2) Header alternativo (caso o portal não envie Bearer)
  const xToken = safeStr(req.headers?.["x-webhook-token"]).trim();

  // 3) Query token (caso portal só consiga mandar querystring)
  const qToken = safeStr(req.query?.token).trim();

  return bearer || xToken || qToken || "";
}

async function bitrixCall(method, params) {
  if (!BITRIX_WEBHOOK_URL) {
    throw new Error("BITRIX_WEBHOOK_URL não definido");
  }

  // Bitrix REST exige .json
  const url = `${BITRIX_WEBHOOK_URL}/${method}.json`;

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
    console.error(`Bitrix request FAILED [${method}]`, resp.status, data);
    throw new Error(
      `BITRIX_REQUEST_FAILED (${resp.status}) [${method}] ${JSON.stringify(data)}`
    );
  }

  if (data?.error) {
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

function getLeadIdFromDuplicates(duplicates) {
  const leadFromPhone = duplicates?.PHONE?.LEAD?.[0];
  const leadFromEmail = duplicates?.EMAIL?.LEAD?.[0];
  return leadFromPhone || leadFromEmail || null;
}

function hasLeadDuplicate(duplicates) {
  const leadIdsPhone = duplicates?.PHONE?.LEAD || [];
  const leadIdsEmail = duplicates?.EMAIL?.LEAD || [];
  return leadIdsPhone.length > 0 || leadIdsEmail.length > 0;
}

async function addTimelineCommentToLead(leadId, comment) {
  // ✅ Em duplicidade, usar Timeline Comment (evita erro COMMUNICATIONS de crm.activity.add)
  return bitrixCall("crm.timeline.comment.add", {
    fields: {
      ENTITY_TYPE: "lead", // Bitrix aceita "lead"
      ENTITY_ID: Number(leadId),
      COMMENT: comment,
    },
  });
}

// ------------------ Handler ------------------

module.exports = async (req, res) => {
  try {
    console.log("=== INÍCIO /api/dfimoveis ===", new Date().toISOString());
    console.log("Method:", req.method);

    // CORS básico
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Webhook-Token");

    if (req.method === "OPTIONS") {
      return res.status(200).end();
    }

    // Aceita POST e GET
    if (req.method !== "POST" && req.method !== "GET") {
      return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
    }

    // Autenticação (se definido)
    if (WEBHOOK_TOKEN) {
      const received = pickToken(req);
      const expected = safeStr(WEBHOOK_TOKEN).replace(/^Bearer\s+/i, "").trim();

      if (!received || received !== expected) {
        console.warn("Token inválido recebido em /api/dfimoveis");
        return res.status(401).json({ error: "INVALID_TOKEN" });
      }
    }

    // Normaliza payload
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
    } = payload;

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

    let portalNome = "DF Imóveis";
    let sourceId = SOURCE_DF_IMOVEIS;
    let portalOrigemUF = "DF_IMOVEIS";

    if (is62Imoveis) {
      portalNome = "62 Imóveis";
      sourceId = SOURCE_62_IMOVEIS;
      portalOrigemUF = "62_IMOVEIS";
    }

    const fullPhone = normalizePhone(ddd, phone);
    const codigoImovel = clientListingId || originListingId || "NAO_INFORMADO";

    // 1) Checa duplicidade
    const duplicates = await findDuplicate(fullPhone, email);
    const isDuplicate = hasLeadDuplicate(duplicates);

    if (isDuplicate) {
      const leadId = getLeadIdFromDuplicates(duplicates);

      const comment =
        `🔁 *Novo contato (duplicado) - ${portalNome}*\n\n` +
        `Imóvel: ${codigoImovel}\n` +
        `Nome: ${name || "não informado"}\n` +
        `Telefone: ${fullPhone || "não informado"}\n` +
        `E-mail: ${email || "não informado"}\n\n` +
        `Mensagem: ${message || ""}\n\n` +
        `clientListingId: ${clientListingId || ""}\n` +
        `originListingId: ${originListingId || ""}\n` +
        `originLeadId: ${originLeadId || ""}\n` +
        `leadOrigin: ${leadOrigin || ""}\n` +
        `timestamp: ${timestamp || ""}`;

      if (!leadId) {
        return res.status(200).json({
          status: "DUPLICATE_FOUND_BUT_NO_LEAD_ID",
          duplicates,
        });
      }

      await addTimelineCommentToLead(leadId, comment);

      return res.status(200).json({
        status: "DUPLICATE_TIMELINE_COMMENT_CREATED",
        leadId,
      });
    }

    // 2) Cria novo Lead
    const leadFields = {
      TITLE: `${portalNome} | ${codigoImovel} | ${name || "Sem nome"}`,
      NAME: name || "Contato Portal",
      SOURCE_ID: sourceId,
      SOURCE_DESCRIPTION: `Lead vindo do portal ${portalNome}`,

      COMMENTS:
        `Portal: ${portalNome}\n` +
        `leadOrigin: ${leadOrigin || ""}\n\n` +
        `Mensagem: ${message || ""}\n\n` +
        `clientListingId: ${clientListingId || ""}\n` +
        `originListingId: ${originListingId || ""}\n` +
        `originLeadId: ${originLeadId || ""}\n` +
        `timestamp: ${timestamp || ""}`,

      // ⚠️ Ajuste se os códigos UF forem diferentes no seu Bitrix
      UF_CODIGO_IMOVEL: codigoImovel,
      UF_PORTAL_ORIGEM: portalOrigemUF,
      UF_DFIMOVEIS_ORIGIN_LEAD_ID: originLeadId || "",
      UF_DFIMOVEIS_ORIGIN_LISTING_ID: originListingId || "",
    };

    if (fullPhone) {
      leadFields.PHONE = [{ VALUE: fullPhone, VALUE_TYPE: "WORK" }];
    }

    if (email) {
      leadFields.EMAIL = [{ VALUE: email, VALUE_TYPE: "WORK" }];
    }

    // Se quiser setar responsável no Lead (opcional)
    if (BITRIX_RESPONSIBLE_ID) {
      leadFields.ASSIGNED_BY_ID = BITRIX_RESPONSIBLE_ID;
    }

    console.log("LeadFields enviados:", JSON.stringify(leadFields, null, 2));

    const leadId = await bitrixCall("crm.lead.add", { fields: leadFields });

    return res.status(200).json({
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
