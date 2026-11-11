const MODELO_IA = process.env.ClaudeModel || 'claude-sonnet-5';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

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
    const { imageBase64, mediaType } = req.body || {};
    if (!imageBase64) {
      context.res = {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: { error: 'No se recibió ninguna miniatura para analizar.' }
      };
      return;
    }

    // 3. Consultar a la API de Claude con el mismo formato del Runbook
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
                  media_type: mediaType || 'image/jpeg',
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

    const etiquetas = Array.isArray(parsed.etiquetas) ? parsed.etiquetas : (parsed.etiquetas_ia || []);
    const descripcion = typeof parsed.descripcion === 'string' ? parsed.descripcion : (parsed.descripcion_ia || '');

    context.res = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: {
        etiquetas_ia: etiquetas,
        descripcion_ia: descripcion
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