module.exports = async function (context, req) {
  const apiKey = process.env.ClaudeApiKey_PDMA;
  if (!apiKey) {
    context.res = {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      body: { error: 'La variable ClaudeApiKey_PDMA no está configurada en Azure.' }
    };
    return;
  }

// 1. Validar que la petición venga de un usuario autenticado en Microsoft 365
  const graphToken = req.headers['x-graph-token'] || '';
  if (!graphToken) {
    context.res = {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
      body: { error: 'Sesión no autorizada.' }
    };
    return;
  }

  try {
    const graphCheck = await fetch('https://graph.microsoft.com/v1.0/me?$select=id', {
      headers: { Authorization: 'Bearer ' + graphToken }
    });
    if (!graphCheck.ok) {
      context.res = {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
        body: { error: 'Token de Microsoft inválido o expirado (HTTP ' + graphCheck.status + ').' }
      };
      return;
    }

    // 2. Leer la miniatura enviada desde el navegador
    const { imageBase64, mediaType, nombreArchivo, contexto } = req.body || {};
    if (!imageBase64) {
      context.res = {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: { error: 'No se recibió ninguna miniatura para analizar.' }
      };
      return;
    }

    const promptSistema =
      'Eres un especialista en catalogación de archivo audiovisual y conservación ambiental para la ONG Asociación Civil Armonía (Bolivia). ' +
      'Analiza la imagen y responde ÚNICAMENTE con un objeto JSON válido (sin bloques markdown ni texto adicional) con exactamente dos claves:\n' +
      '1. "etiquetas_ia": arreglo de 5 a 8 etiquetas descriptivas en español, en minúsculas (ej. fauna, flora, especie si es reconocible, hábitat, actividad de campo, comunidad, paisaje).\n' +
      '2. "descripcion_ia": una descripción breve, clara y objetiva en español (1 a 2 oraciones) de lo que se observa en la escena.';

    const textoUsuario =
      `Archivo: ${nombreArchivo || 'sin_nombre'}. ` +
      (contexto ? `Contexto del envío: ${contexto}. ` : '') +
      'Genera las etiquetas y la descripción en formato JSON.';

    // 3. Consultar a la API de Claude
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.ClaudeModel || 'claude-haiku-4-5-20251001',
        max_tokens: 350,
        system: promptSistema,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType || 'image/jpeg',
                  data: imageBase64
                }
              },
              {
                type: 'text',
                text: textoUsuario
              }
            ]
          }
        ]
      })
    });

    if (!claudeRes.ok) {
      const errTxt = await claudeRes.text();
      context.res = {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
        body: { error: 'Error al consultar Claude', detalle: errTxt.slice(0, 300) }
      };
      return;
    }

    const data = await claudeRes.json();
    const rawText = (data.content && data.content[0] && data.content[0].text) || '{}';
    const cleanJson = rawText.replace(/```json|```/gi, '').trim();
    const parsed = JSON.parse(cleanJson);

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {
        etiquetas_ia: Array.isArray(parsed.etiquetas_ia) ? parsed.etiquetas_ia : [],
        descripcion_ia: typeof parsed.descripcion_ia === 'string' ? parsed.descripcion_ia : ''
      }
    };
  } catch (err) {
    context.res = {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      body: { error: err.message || 'Error interno analizando el archivo.' }
    };
  }
};
