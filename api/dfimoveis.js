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
 *  - "Portal DF Imóveis" → renomeamos a fonte "E-mail", então SOURCE_ID = "EMAIL"
 */

const BITRIX_WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || null;

// (Opcional) responsável padrão para atividades/criação (evita hardcode 1)
const BITRIX_RESPONSIBLE_ID = process.env.BITRIX_RESPONSIBLE_ID
  ? Number(process.env.BITRIX_RESPONSIBLE_ID)
  : null;

// Fonte DF Imóveis (ID interno da fonte que você renomeou de "E-mail")
const SOURCE_DF_IMOVEIS = "EMAIL";

// Se quiser uma fonte separada para 62 Imóveis no futuro, pode trocar isso aqui:
const SOURCE_62_IMOVEIS = "EMAIL"; // ou "PORTAL_62IMOVEIS" se criar outra fonte

// --------------- Funções auxiliares ---------------

function normalizePhone(ddd, phone) {
  const digitsDDD = (ddd || "").toString().replace(/\D/g, "");
  const digitsPhone = (phone || "").toString().replace(/\D/g, "");

  if (!digitsPhone) return null;

  // Brasil (+55)
  if (digitsDDD) {
    return `+55${digitsDDD}${digitsPhone}`;
  }
  return `+55${digitsPhone}`;
}

async function bitrixCall(method, params) {
  if (!BITRIX_WEBHOOK_URL) {
    throw new Error("BITRIX_WEBHOOK_URL não definido nas variáveis de ambiente");
  }

  // ✅ Bitrix REST exige .json no final
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
    console.error(
      `Bitrix request FAILED [${method}]`,
      resp.status,
      JSON.stringify(data, null, 2)
    );
    throw new Error(
      `BITRIX_REQUEST_FAILED (${resp.status}) [${method}]: ${JSON.stringify(
        data
      )}`
    );
  }

  if (data && data.error) {
    throw new Error(
      `BITRIX_API_ERROR [${method}] ${data.error}: ${
        data.error_description || ""
      }`
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

function hasLeadDuplicate(duplicates) {
  if (!duplicates) return false;
  const leadIdsPhone = duplicates.PHONE?.LEAD || [];
  const leadIdsEmail = duplicates.EMAIL?.LEAD || [];
  return leadIdsPhone.length > 0 || leadIdsEmail.length > 0;
}

// --------------- Handler principal ---------------

module.exports = async (req, res) => {
  try {
    console.log("=== INÍCIO /api/dfimoveis ===");
    console.log("Method:", req.method);

    // ✅ CORS básico
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

    if (req.method === "OPTIONS") {
      return res.status(200).end();
    }

    // ✅ Aceita POST e GET (portais às vezes enviam GET)
    if (req.method !== "POST" && req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Autenticação via Authorization: Bearer <token>
    if (WEBHOOK_TOKEN) {
      const rawHeader =
        req.headers["authorization"] || req.headers["Authorization"] || "";

      const received = rawHeader.replace(/^Bearer\s+/i, "").trim();
      const expected = WEBHOOK_TOKEN.replace(/^Bearer\s+/i, "").trim();

      if (!received || received !== expected) {
        console.warn("Token inválido recebido em /api/dfimoveis");
        return res.status(401).json({ error: "INVALID_TOKEN" });
      }
    }

    // ✅ Normaliza payload
    let payload = {};

    if (req.method === "GET") {
      payload = req.query || {};
    } else {
      // POST
      if (!req.body) {
        // fallback (caso mandem parâmetros na query)
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

    console.log("Payload DF Imóveis recebido:", JSON.stringify(payload, null, 2));

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

    // ✅ trava anti-lead vazio
    if (!name && !email && !phone) {
      return res.status(400).json({
        error: "MISSING_IDENTITY",
        message: "Precisa de ao menos nome, e-mail ou telefone",
        receivedKeys: Object.keys(payload || {}),
      });
    }

    // Origem DFImoveis / 62imoveis
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

    let leadId = null;

    if (isDuplicate) {
      const leadFromPhone = duplicates.PHONE?.LEAD?.[0];
      const leadFromEmail = duplicates.EMAIL?.LEAD?.[0];
      leadId = leadFromPhone || leadFromEmail;

      const activityFields = {
        OWNER_ID: leadId,
        OWNER_TYPE_ID: 1, // Lead
        TYPE_ID: 4, // Task
        SUBJECT: `Novo contato ${portalNome} (duplicado) - ${codigoImovel}`,
        DESCRIPTION:
          `Novo contato vindo do portal ${portalNome}.\n\n` +
          `Mensagem: ${message || ""}\n\n` +
          `Telefone: ${fullPhone || "não informado"}\n` +
          `E-mail: ${email || "não informado"}\n\n` +
          `clientListingId: ${clientListingId || ""}\n` +
          `originListingId: ${originListingId || ""}\n` +
          `originLeadId: ${originLeadId || ""}\n` +
          `leadOrigin: ${leadOrigin || ""}\n` +
          `timestamp: ${timestamp || ""}`,
        COMPLETED: "N",
      };

      if (BITRIX_RESPONSIBLE_ID) {
        activityFields.RESPONSIBLE_ID = BITRIX_RESPONSIBLE_ID;
      }

      await bitrixCall("crm.activity.add", { fields: activityFields });

      return res.json({
        status: "DUPLICATE_ACTIVITY_CREATED",
        leadId,
      });
    }

    // Novo lead
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

      // ⚠️ Ajuste se os códigos de UF forem diferentes no seu Bitrix
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

    console.log(
      "LeadFields DF Imóveis enviados para crm.lead.add:",
      JSON.stringify(leadFields, null, 2)
    );

    const leadResult = await bitrixCall("crm.lead.add", { fields: leadFields });
    leadId = leadResult;

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
