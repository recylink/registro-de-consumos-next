import "server-only";

// Configuración de la instancia. A diferencia del prototipo (donde RC_CONFIG
// vivía en proto/sync.jsx y viajaba al navegador con endpoint e IDs de Drive a
// la vista), acá nada de esto sale del servidor: `server-only` hace fallar el
// build si algún componente cliente importa este módulo.

// Esta instancia no pertenece a un cliente: es la versión formal de referencia.
// El valor se escribe en la columna "Empresa" de cada fila del Sheet.
export const EMPRESA = "NEXT";

export const SHEETS = {
  COMBUSTIBLE: "Combustible",
  ELECTRICIDAD: "Electricidad",
  AGUA: "Agua",
  FOTOS: "Fotos",
  // Módulo Medidores (lecturas físicas).
  MED_MEDIDORES: "Medidores",
  MED_LECTURAS: "Lecturas Medidor",
  MED_PRECIOS: "Precios Medidor",
  // Estas tres las tenía el Apps Script en variables sueltas (CONFIG_SUC_SHEET,
  // EMISSIONS_SHEET, y "Config" escrito a mano en cuatro lugares). Al migrar al
  // SDK pasan acá, para que el nombre de la hoja tenga un solo dueño.
  CONFIG: "Config",
  CONFIG_SUCURSALES: "Config Sucursales",
  EMISIONES: "Emisiones",
};

/** Las tres hojas de Registros, en el orden en que las leía `readAll`. */
export const HOJAS_REGISTROS = [SHEETS.COMBUSTIBLE, SHEETS.ELECTRICIDAD, SHEETS.AGUA];

export function appsScriptUrl() {
  return String(process.env.APPS_SCRIPT_URL || "").trim();
}

/**
 * ID de la planilla, para el SDK de Google APIs. El Apps Script no lo necesitaba
 * porque operaba sobre la planilla que lo contenía; el SDK habla desde afuera y
 * tiene que decir sobre cuál.
 *
 * Se acepta la URL completa por comodidad: es lo que uno copia del navegador.
 */
export function spreadsheetId() {
  const raw = String(process.env.SPREADSHEET_ID || "").trim();
  if (!raw) return "";
  const m = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : raw;
}

// URL de la planilla, solo para el link "ver planilla" de la UI. Opcional.
export function spreadsheetUrl() {
  return String(process.env.SPREADSHEET_URL || "").trim();
}

/**
 * ¿Está configurado el Apps Script? Lo usa su transporte (`lib/apps-script.js`)
 * para fallar con un mensaje claro en vez de pegarle a una URL vacía.
 *
 * Ojo: esto NO significa "hay backend". Para eso está `hayBackend()`.
 */
export function appsScriptConfigurado() {
  return appsScriptUrl().includes("script.google.com");
}

// ----- Credenciales del SDK de Google -------------------------------------
// Viven acá y no en lib/google/auth.js porque leer el entorno es el trabajo de
// este módulo, y porque `hayBackend()` las necesita: si auth.js las tuviera,
// instance.js tendría que importarlo y auth.js ya importa a instance.js — un
// ciclo. `auth.js` las reexporta para quien las venía usando desde ahí.

export function clientEmail() {
  return String(process.env.GOOGLE_CLIENT_EMAIL || "").trim();
}

/**
 * La clave privada viaja en una env var de una sola línea, con los saltos como
 * `\n` literales — es como la guardan tanto dotenv como el panel de Vercel. Sin
 * deshacer ese escape, googleapis falla al parsear el PEM con un
 * `error:1E08010C:DECODER routines::unsupported` que no menciona la causa.
 */
export function privateKey() {
  return String(process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();
}

/** Qué falta para poder usar el SDK. Vacío = configurado. */
export function sdkFaltantes() {
  const faltan = [];
  if (!clientEmail()) faltan.push("GOOGLE_CLIENT_EMAIL");
  if (!privateKey()) faltan.push("GOOGLE_PRIVATE_KEY");
  if (!spreadsheetId()) faltan.push("SPREADSHEET_ID");
  return faltan;
}

export function isSdkConfigured() {
  return sdkFaltantes().length === 0;
}

/**
 * ¿Hay ALGÚN backend capaz de servir datos?
 *
 * Hasta la migración al SDK esta pregunta y `appsScriptConfigurado()` eran la
 * misma, y una sola función respondía las dos. Dejaron de serlo: con la service
 * account configurada y sin `APPS_SCRIPT_URL`, 20 de las 24 actions funcionan
 * perfectamente. Mientras las dos preguntas compartieron función, ese caso mostraba
 * TODAS las pantallas vacías —con el backend nuevo respondiendo bien— porque
 * `lib/data.js` cortaba antes de leer.
 */
export function hayBackend() {
  return bdConfigurada() || appsScriptConfigurado() || isSdkConfigured();
}

/**
 * Con `DATOS_BACKEND=postgres` los datos salen de la base, no de la planilla, así
 * que hay backend aunque no haya credenciales de Google.
 *
 * Se lee el entorno acá en vez de importar `lib/backend.js` a propósito: ese
 * módulo importa `lib/sheets/*`, que importan este archivo. El import sería un
 * ciclo.
 */
function bdConfigurada() {
  return process.env.DATOS_BACKEND === "postgres" && !!process.env.DATABASE_URL;
}

// `isConfigured()` existía acá y respondía las dos preguntas a la vez. Se
// reemplazó por `appsScriptConfigurado()` y `hayBackend()` y no quedó ningún
// consumidor, así que no se deja como alias: un nombre ambiguo sin usos solo
// invita a volver a confundirlas.
