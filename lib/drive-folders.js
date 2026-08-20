import "server-only";
import { apiGet, TAGS } from "./apps-script";
// Se importa la lectura de la base directo y no `lib/backend.js` a proposito:
// backend importa `sheets/fotos`, que importa este archivo. Ir por backend
// cerraria un ciclo de imports y las constantes quedarian sin evaluar.
import { readDriveFolders } from "./db/lecturas";

// Los IDs de carpetas de Drive NO viven en el entorno: son ~25 valores y crecen
// con cada proveedor nuevo. Se guardan como un único JSON en la clave
// `driveFolders` de la hoja "Config", que el Apps Script crea con su acción
// `setup` a partir de una sola carpeta raíz. Así agregar un proveedor no obliga
// a redeployar la app.

const EMPTY = {
  // Flujo "Tomar foto".
  fotosPorCompletar: "",
  fotosProcesados: "",
  // Facturas adjuntas en registro manual.
  manualFacturas: "",
  // Fallback de "Subir documento" cuando el proveedor no tiene carpeta propia.
  uploadFacturas: "",
  // Módulo Medidores.
  medidorFacturas: "",
  medidorPagos: "",
  medidorRespaldos: {}, // { [tipo de consumo]: id }
  // { [providerId]: { porProcesar, procesados } }
  proveedores: {},
};

function normalize(value) {
  const v = value && typeof value === "object" ? value : {};
  return {
    ...EMPTY,
    ...v,
    medidorRespaldos: v.medidorRespaldos || {},
    proveedores: v.proveedores || {},
  };
}

/**
 * Mapa de carpetas de la instancia. Se cachea con la etiqueta de config: casi
 * nunca cambia, y `setup` la invalida cuando corre.
 */
export async function getDriveFolders() {
  // Con PostgreSQL las carpetas son filas de `drive_carpeta` en vez de un JSON
  // en la hoja `Config`. La forma que sale de aqui es la misma en los dos casos.
  if (process.env.DATOS_BACKEND === "postgres") {
    return normalize(await readDriveFolders());
  }
  const data = await apiGet(
    { action: "getConfig", key: "driveFolders" },
    { tag: TAGS.config, revalidate: 300 },
  );
  return normalize(data && data.value);
}

/**
 * Carpetas de origen/destino para un documento subido de un proveedor.
 * Sin par configurado, el archivo cae en la carpeta genérica y no se mueve a
 * "procesados" (destino null).
 */
export function providerFolders(folders, providerId) {
  const pf = (folders.proveedores || {})[providerId || ""] || null;
  return {
    origen: (pf && pf.porProcesar) || folders.uploadFacturas || folders.manualFacturas || null,
    destino: (pf && pf.procesados) || null,
  };
}

/** Carpeta destino de un documento de medidor según su tipo. */
export function medidorFolder(folders, kind, consumoType) {
  if (kind === "pago") return folders.medidorPagos || "";
  if (kind === "respaldo") return (folders.medidorRespaldos || {})[consumoType] || "";
  return folders.medidorFacturas || "";
}
