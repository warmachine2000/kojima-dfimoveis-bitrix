/**
 * Integração DF Imóveis / 62 Imóveis  → Bitrix24
 * Autor: Adriano Alves
 * Projeto: kojima-dfimoveis-bitrix
 *
 * Payload esperado (padrão Grupo OLX/ZAP + extras opcionais):
 * {
 *   "clientListingId": "a40171",
 *   "name": "Nome Consumidor",
 *   "email": "nome@email.com",
 *   "ddd": "61",
 *   "phone": "999999999",
 *   "message": "Olá, tenho interesse neste imóvel. https://...",
 *   "leadOrigin": "DFImoveis", // ou "62imoveis"
 *   "timestamp": "2017-10-23T15:50:30.619Z",
 *   "originLeadId": "59ee0fc6e4b043e1b2a6d863",
 *   "originListingId": "87027856",
 *   "listingUrl": "https://www.dfimoveis.com.br/imovel/..."
 * }
 *
 * Fonte no Bitrix:
 *  - "Portal DF Imóveis" → renomeamos a fonte "E-mail", então SOURCE_ID = "EMAIL"
 */

const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL;

// Token (opcional) — por padrão DESLIGADO
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || null;

const BITRIX_RESPONSIBLE_ID = process.env.BITRIX_RESPONSIBLE_ID
  ? Number(process.env.BITRIX_RESPONSIBLE_ID)
  : null;

// Fonte DF Imóveis (ID interno da fonte que você renomeou de "E-mail")
const SOURCE_DF_IMOVEIS = "EMAIL";
const SOURCE_62_IMOVEIS = "EMAIL";

// ---------------- Helpers ----------------

function normalizePhone(ddd, phone) {
  const digitsDDD = (ddd || "").toString().replace(/\D/g, "");
  const digitsPhone = (phone || "").toString().replace(/\D/g, "");
  if (!digitsPhone) return null;
  if (digitsDDD) return `+55${digitsDDD}${digitsPhone}`;
  return `+55${digitsPhone}`;
}

function extractUrl(text) {
  if (!text) return null;
  const match = text.toString().match(/https?:\/\/\S+/i);
  return match ? match[0] : null;
}

function buildTimelineMessage({
  portalNome,
  leadOrigin,
  message,
  codigoImovel,
  listingUrl,
  clientListingId,
  originListingId,
  originLeadId,
  timestamp,
  name,
  email,
  fullPhone,
}) {
  const url = listingUrl || extractUrl(message) || "";
  const msg = (message || "").toString().trim();

  return (
    `🧲 Novo contato (${portalNome})\n` +
    `----------------------------------\n` +
    `👤 Nome: ${name || "não informado"}\n` +
    `📞 Telefone: ${fullPhone || "não informado"}\n` +
    `✉️ E-mail: ${email || "não informado"}\n\n` +
    `🏷️ Código do anúncio: ${codigoImovel || "não informado"}\n` +
    `🔗 URL do anúncio: ${url || "não informado"}\n\n` +
    `💬 Mensagem:\n${msg || "(vazia)"}\n\n` +
    `ℹ️ Metadados:\n` +
    `- leadOrigin: ${leadOrigin || ""}\n` +
    `- clientListingId: ${clientListingId || ""}\n` +
    `- originListingId: ${originListingId || ""}\n` +
    `- originLeadId: ${originLeadId || ""}\n` +
    `- timestamp: ${timestamp || ""}\n`
  );
}

async function bitrixCall(method, params) {
  if (!BITRIX_WEBHOOK_URL) {
    throw new Error("BITRIX_WEBHOOK_URL não definido");
  }

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
    throw new Error(
      `BITRIX_REQUEST_FAILED (${resp.status}) [${method}] - ${
        data?.error_description || data?.error || JSON.stringify(data)
      }`
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
    } catch (_) {}
  }

  if (email) {
    try {
      duplicates.EMAIL = await bitrixCall("crm.duplicate.findbycomm", {
        type: "EMAIL",
        values: [email],
      });
    } catch (_) {}
  }

  return duplicates;
}

function hasLeadDuplicate(duplicates) {
  const leadIdsPhone = duplicates?.PHONE?.LEAD || [];
  const leadIdsEmail = duplicates?.EMAIL?.LEAD || [];
  return leadIdsPhone.length > 0 || leadIdsEmail.length > 0;
}

async function addTimelineComment(leadId, message) {
  // Bitrix timeline comment
  return bitrixCall("crm.timeline.comment.add", {
    fields: {
      ENTITY_TYPE: "lead",
      ENTITY_ID: Number(leadId),
      COMMENT: message,
    },
  });
}

// ---------------- Handler ----------------

module.exports = async (req, res) => {
  try {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

    if (req.method === "OPTIONS") return res.status(200).end();

    if (req.method !== "POST" && req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Token opcional (se você NÃO quiser, é só não setar WEBHOOK_TOKEN)
    if (WEBHOOK_TOKEN) {
      const rawHeader = req.headers["authorization"] || req.headers["Authorization"] || "";
      const received = rawHeader.replace(/^Bearer\s+/i, "").trim();
      const expected = WEBHOOK_TOKEN.replace(/^Bearer\s+/i, "").trim();
      if (!received || received !== expected) {
        return res.status(401).json({ error: "INVALID_TOKEN" });
      }
    }

    // Normaliza payload
    let payload = {};
    if (req.method === "GET") {
      payload = req.query || {};
    } else {
      if (!req.body) payload = req.query || {};
      else if (typeof req.body === "string") {
        try {
          payload = JSON.parse(req.body);
        } catch (_) {
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
    } = payload;

    if (!name && !email && !phone) {
      return res.status(400).json({
        error: "MISSING_IDENTITY",
        message: "Precisa de ao menos nome, e-mail ou telefone",
      });
    }

    const originLower = (leadOrigin || "").toLowerCase();
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

    // Duplicidade
    const duplicates = await findDuplicate(fullPhone, email);
    const isDuplicate = hasLeadDuplicate(duplicates);

    // Monta mensagem definitiva (TIMELINE)
    const timelineText = buildTimelineMessage({
      portalNome,
      leadOrigin,
      message,
      codigoImovel,
      listingUrl,
      clientListingId,
      originListingId,
      originLeadId,
      timestamp,
      name,
      email,
      fullPhone,
    });

    if (isDuplicate) {
      const leadId =
        duplicates?.PHONE?.LEAD?.[0] || duplicates?.EMAIL?.LEAD?.[0];

      // ✅ Aqui é o principal: comentar na TIMELINE (é o que aparece na tela)
      await addTimelineComment(leadId, `⚠️ DUPLICADO\n\n${timelineText}`);

      return res.json({
        status: "DUPLICATE_TIMELINE_COMMENT_CREATED",
        leadId: Number(leadId),
      });
    }

    // Novo lead
    const leadFields = {
      TITLE: `${portalNome} | ${codigoImovel} | ${name || "Sem nome"}`,
      NAME: name || "Contato Portal",
      SOURCE_ID: sourceId,
      SOURCE_DESCRIPTION: `Lead vindo do portal ${portalNome}`,

      // Ainda grava COMMENTS (se seu Bitrix mostrar)
      COMMENTS: timelineText,

      // Se esses UF não existirem, Bitrix costuma ignorar sem erro em algumas contas;
      // Se der erro em algum momento, você remove estes 4.
      UF_CODIGO_IMOVEL: codigoImovel,
      UF_PORTAL_ORIGEM: portalOrigemUF,
      UF_DFIMOVEIS_ORIGIN_LEAD_ID: originLeadId || "",
      UF_DFIMOVEIS_ORIGIN_LISTING_ID: originListingId || "",
    };

    if (fullPhone) leadFields.PHONE = [{ VALUE: fullPhone, VALUE_TYPE: "WORK" }];
    if (email) leadFields.EMAIL = [{ VALUE: email, VALUE_TYPE: "WORK" }];

    if (BITRIX_RESPONSIBLE_ID) {
      leadFields.ASSIGNED_BY_ID = BITRIX_RESPONSIBLE_ID;
    }

    const leadId = await bitrixCall("crm.lead.add", { fields: leadFields });

    // ✅ E aqui garante aparecer na tela (timeline)
    await addTimelineComment(leadId, timelineText);

    return res.json({
      status: "LEAD_CREATED",
      leadId: Number(leadId),
    });
  } catch (err) {
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: err.message,
    });
  }
};
