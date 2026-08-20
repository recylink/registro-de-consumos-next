import "server-only";
import { apiPost } from "./apps-script";
import { getDriveFolders, providerFolders } from "./drive-folders";
import { moveInDrive, uploadToDrive } from "./drive";
import { appendRecords, updateRecordField } from "./backend";

// Flujos de escritura que combinan Drive + Sheets. Equivalen a rcHandleConfirm
// del prototipo, partido por caso de uso en vez de discriminar por `source`
// dentro de un solo handler de eventos del DOM.

/**
 * Registro manual: sube la factura adjunta de cada registro (si trae) y escribe
 * las filas. Una subida fallida no aborta el lote — el registro se guarda sin
 * link, que es preferible a perder el dato que el usuario ya digitó.
 *
 * @param records  Registros del dominio.
 * @param facturas [{ recordId, file }] — a lo más una por registro.
 */
export async function submitManual({ records, facturas = [] }) {
  const folders = await getDriveFolders();
  const problemas = [];

  if (facturas.length && folders.manualFacturas) {
    for (const { recordId, file } of facturas) {
      if (!file) continue;
      try {
        const up = await uploadToDrive(file, folders.manualFacturas);
        const target = (records || []).find((r) => r.id === recordId);
        if (target) target._driveLink = up.link;
      } catch (err) {
        problemas.push(`No se pudo subir ${file.name}: ${err.message}`);
      }
    }
  } else if (facturas.length) {
    problemas.push("Carpeta de facturas no configurada — los adjuntos no se subieron.");
  }

  const written = await appendRecords(records);
  return { written, problemas };
}

/**
 * Documentos subidos (boletas de proveedor). Cada archivo se sube una sola vez
 * aunque haya generado varios registros; los registros se enlazan por
 * `sourceFile`. Si el proveedor tiene par de carpetas configurado, el archivo se
 * mueve a "procesados" recién después de escribir las filas: si el append falla,
 * el documento queda en la cola por procesar.
 */
export async function submitUpload({ providerId, records, files = [] }) {
  const folders = await getDriveFolders();
  const { origen, destino } = providerFolders(folders, providerId);
  const problemas = [];
  const uploads = new Map(); // nombre lógico → { id, link }

  if (!origen && files.length) {
    problemas.push("Carpeta de documentos no configurada — los archivos no se subieron.");
  }

  if (origen) {
    for (const { name, file } of files) {
      if (!file || uploads.has(name)) continue;
      try {
        uploads.set(name, await uploadToDrive(file, origen));
      } catch (err) {
        problemas.push(`No se pudo subir ${name}: ${err.message}`);
      }
    }
  }

  for (const r of records || []) {
    const up = r.sourceFile && uploads.get(r.sourceFile);
    if (up) r._driveLink = up.link;
  }

  const written = await appendRecords(records);

  if (destino) {
    for (const up of uploads.values()) {
      try {
        await moveInDrive(up.id, origen, destino);
      } catch (err) {
        problemas.push(`Archivo subido pero no archivado en procesados: ${err.message}`);
      }
    }
  }

  return { written, problemas };
}

/**
 * Adjunta un documento a un registro que ya existe en la planilla y actualiza su
 * celda Link. Devuelve { id, link } del archivo en Drive.
 */
export async function attachDocument({ recordId, file }) {
  const folders = await getDriveFolders();
  if (!folders.manualFacturas) throw new Error("Carpeta de facturas no configurada.");
  const up = await uploadToDrive(file, folders.manualFacturas);
  // Antes esto resolvía la celda por posición y escribía por su cuenta, duplicando
  // el camino de escritura de `updateRecordField`. Ahora es una sola vía, así que
  // adjuntar un documento también localiza la fila por su ID cuando la tiene.
  await updateRecordField(recordId, "link", up.link);
  return up;
}
