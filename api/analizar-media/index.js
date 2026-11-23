const MODELO_IA = process.env.ClaudeModel || 'claude-sonnet-5';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const TENANT_PERMITIDO = 'a81c5bcd-4124-475d-a58d-0ac4b49bb1bf';
const DOMINIO_PERMITIDO = '@armonia-bo.org';
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB máximo para miniaturas

// Control básico de tasa en memoria por instancia (60 solicitudes cada 10 minutos por usuario)
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX_REQ = 60;
const rateStore = new Map();

const PROMPT_ANALISIS = `
# Rol
Eres especialista en catalogación de fotografías ambientales y biodiversidad del Portafolio Digital de Medio Ambiente (PDMA) de la Asociación Civil Armonía, Bolivia.

# Objetivo
Analiza únicamente el contenido visible de la imagen y devuelve una descripción breve y entre 3 y 5 etiquetas útiles para buscar la fotografía en SharePoint. Piensa como catalogador documental, no como narrador.

# Reglas
- Ignora nombre del archivo, ruta, carpetas, metadatos y cualquier información externa.
- No inventes ubicación, proyecto, institución, profesión, actividad ni especie.
- Prioriza elementos específicos y distintivos sobre términos genéricos.
- La descripción debe ser una sola oración objetiva de máximo 15 palabras.
- No repitas etiquetas ni uses sinónimos redundantes.
- Evita como etiquetas: naturaleza, exterior, foto, verde, negro, blanco, animal y persona.
- Evita vegetación, paisaje, maquinaria o herramientas cuando puedas nombrar algo más específico.
- Describe acciones solo cuando sean visibles.
- Si aparece una herramienta u objeto reconocible EN PRIMER PLANO o asociado directamente al sujeto principal, usa su nombre específico: picota, pala, machete, GPS, binoculares, cámara, cámara trampa, dron o caja nido.
- Si aparece un vehículo o maquinaria reconocible EN PRIMER PLANO o como parte central de la escena, usa el tipo específico: tractor de orugas, camioneta, motocicleta, bote o excavadora.
- Ignora elementos incidentales de fondo (vehículos, estructuras, personas) que no formen parte del sujeto o la acción principal de la fotografía.
- Usa "trabajo de campo" cuando se observe a personas realizando labores prácticas al aire libre, sin inventar el propósito.
- Usa "capacitación" o "reunión" solo cuando la escena lo evidencie.
- Usa "anidación" únicamente si son visibles un nido, caja nido, huevos o pichones.
- Para grupos de cuatro o más aves en vuelo, usa "bandada" sin contar individuos.
- Cuando exista interacción visible, incluye el elemento asociado: ave con cactus, ave con nido, persona con picota, etc.

# Fauna
- Identifica una especie solo con alta confianza basada en rasgos visibles.
- Si no hay certeza, usa una categoría segura: ave, paraba, mamífero, reptil, anfibio o insecto.
- Nunca uses las palabras "loro", "cotorra" ni "perico".
- Ave grande con cola larga: puede etiquetarse como "paraba" si los rasgos son claros.
- Ave pequeña o identificación incierta: usa "ave".

# Especies prioritarias de Armonía
Solo usa estos nombres cuando coincidan claramente los rasgos visibles:
- Paraba Frente Roja: frente roja, cuerpo verde, hombros anaranjados y cola larga azul verdosa.
- Paraba Barba Azul: garganta azul turquesa, pecho amarillo o anaranjado y alas azules.
- Palkachupa: ave pequeña, tonos grisáceos y amarillos, cola larga con terminaciones ensanchadas.

# Prioridad de etiquetas
1. Sujeto o especie principal.
2. Acción o comportamiento visible.
3. Objeto, herramienta o elemento asociado.
4. Entorno específico.
5. Categoría general, solo si aporta valor.

Antes de responder, selecciona mentalmente los términos que un usuario escribiría para encontrar esta fotografía.

# Salida
Responde exclusivamente con un JSON válido, sin Markdown, comentarios ni texto adicional:
{
  "etiquetas": ["Etiqueta 1", "Etiqueta 2", "Etiqueta 3"],
  "descripcion": "Descripción objetiva de máximo 15 palabras."
}
`.trim();

function jsonRes(context, status, body, extraHeaders = {}) {
  context.res = {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body
  };
}

function decodificarClaimsJwt(token) {
  try {
    const partes = String(token).split('.');
    if (partes.length !== 3) return null;
    const b64 = partes[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    return JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function validarCabeceraImagen(buf, mediaType) {
  if (!buf || buf.length < 12) return false;
  if (mediaType === 'image/jpeg') return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
  if (mediaType === 'image/png') return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
  if (mediaType === 'image/gif') return buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38;
  if (mediaType === 'image/webp') {
    return buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}

function verificarRateLimit(userId) {
  const ahora = Date.now();
  const prev = rateStore.get(userId) || [];
  const recientes = prev.filter(ts => ahora - ts < RATE_WINDOW_MS);
  if (recientes.length >= RATE_MAX_REQ) {
    const retryAfter = Math.max(1, Math.ceil((RATE_WINDOW_MS - (ahora - recientes[0])) / 1000));
    return { permitido: false, retryAfter };
  }
  recientes.push(ahora);
  rateStore.set(userId, recientes);
  return { permitido: true, retryAfter: 0 };
}

module.exports = async function (context, req) {
  const apiKey = process.env.ClaudeApiKey_PDMA;
  if (!apiKey) {
    return jsonRes(context, 500, { error: 'El servicio de análisis IA no está configurado en el servidor.' });
  }

  // 1. Verificar presencia y claims estructurales del token Bearer sin registrar el secreto
  const graphToken = (req.headers['x-graph-token'] || '').trim();
  if (!graphToken) {
    return jsonRes(context, 401, { error: 'Sesión no autorizada.' });
  }

  const claims = decodificarClaimsJwt(graphToken);
  const ahoraSeg = Math.floor(Date.now() / 1000);
  if (!claims || (claims.exp && claims.exp <= ahoraSeg)) {
    return jsonRes(context, 401, { error: 'Token de sesión inválido o expirado.' });
  }
  if (claims.tid && claims.tid !== TENANT_PERMITIDO) {
    return jsonRes(context, 403, { error: 'Inquilino no autorizado.' });
  }

  try {
    // 2. Confirmar identidad activa con Microsoft Graph
    const graphCheck = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,userPrincipalName,mail,accountEnabled', {
      headers: { Authorization: 'Bearer ' + graphToken }
    });
    if (!graphCheck.ok) {
      return jsonRes(context, 401, { error: 'No se pudo validar la sesión con Microsoft 365 (HTTP ' + graphCheck.status + ').' });
    }

    const perfil = await graphCheck.json();
    const upn = String(perfil.userPrincipalName || perfil.mail || '').toLowerCase();
    if (perfil.accountEnabled === false || !upn.endsWith(DOMINIO_PERMITIDO)) {
      return jsonRes(context, 403, { error: 'Cuenta sin autorización institucional para este servicio.' });
    }

    // 3. Control de tasa por usuario autenticado
    const rl = verificarRateLimit(perfil.id || upn);
    if (!rl.permitido) {
      return jsonRes(context, 429, { error: 'Demasiadas solicitudes de análisis. Espera unos segundos e intenta de nuevo.' }, { 'Retry-After': String(rl.retryAfter) });
    }

    // 4. Validar tipo MIME, contenido Base64, tamaño y firma binaria de imagen
    const { imageBase64, mediaType } = req.body || {};
    const mimesPermitidos = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    const mimeFinal = String(mediaType || 'image/jpeg').toLowerCase().trim();
    if (!mimesPermitidos.has(mimeFinal)) {
      return jsonRes(context, 400, { error: 'Formato de miniatura no admitido.' });
    }
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return jsonRes(context, 400, { error: 'No se recibió ninguna miniatura para analizar.' });
    }

    const imgBuf = Buffer.from(imageBase64, 'base64');
    if (imgBuf.length === 0 || imgBuf.length > MAX_IMAGE_BYTES) {
      return jsonRes(context, 413, { error: 'La miniatura supera el tamaño máximo permitido (2 MB).' });
    }
    if (!validarCabeceraImagen(imgBuf, mimeFinal)) {
      return jsonRes(context, 400, { error: 'El contenido enviado no corresponde a una imagen válida.' });
    }

    // 5. Consultar a la API de Claude
    const claudeRes = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODELO_IA,
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mimeFinal,
                  data: imageBase64
                }
              },
              {
                type: 'text',
                text: PROMPT_ANALISIS
              }
            ]
          }
        ]
      })
    });

    if (!claudeRes.ok) {
      const errTxt = await claudeRes.text();
      return jsonRes(context, 502, { error: 'Error al consultar el servicio de IA', detalle: errTxt.slice(0, 200) });
    }

    const data = await claudeRes.json();
    const rawText = (data.content && data.content[0] && data.content[0].text) || '{}';
    const cleanJson = rawText.replace(/```json|```/gi, '').trim();
    const parsed = JSON.parse(cleanJson);

    const etiquetas = Array.isArray(parsed.etiquetas) ? parsed.etiquetas.map(x => String(x).trim()).filter(Boolean) : [];
    const descripcion = typeof parsed.descripcion === 'string' ? parsed.descripcion.trim() : '';

    return jsonRes(context, 200, {
      etiquetas_ia: etiquetas,
      descripcion_ia: descripcion
    });
  } catch (err) {
    return jsonRes(context, 500, { error: 'Error interno procesando la imagen.' });
  }
};
