// PDMA · Formulario de ingreso de material inédito · configuración pública (no contiene secretos)
// App registrada en Entra ID: PDMA-POC-Formulario (09-11-2026)
window.PDMA_CONFIG = {
  clientId: '029ae1ff-9010-4bf2-9a84-b830de5a8d32',
  tenantId: 'a81c5bcd-4124-475d-a58d-0ac4b49bb1bf',
  // Único punto de configuración para la identificación visible del entorno (cambiar al pasar a producción)
  entorno: {
    esPruebas: true,
    nombreVisible: 'Entorno de pruebas'
  },
  // Vínculo compartido de recepción en OneDrive (requiere sesión autenticada de Armonía)
  carpetaVinculo: 'https://armoniabolivia-my.sharepoint.com/:f:/g/personal/afcampos_armonia-bo_org/IgDWkNB17TEaS5TrLYDaefy6AdaXhRnq-jFMWAYJeH9yc5c?e=jNL0T6'
};
