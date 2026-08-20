import "server-only";
import { apiGet, apiPost, TAGS } from "../apps-script";
import { SHEETS } from "../instance";
import { getDriveFolders } from "../drive-folders";
import { moveInDrive, uploadToDrive } from "../drive";
import { lastDayOfMonth } from "../domain/parse";
import { appendRecords } from "./records";

// Flujo "Tomar foto": la imagen se sube a la carpeta "por completar" y queda una
// fila pendiente en la hoja "Fotos". Cuando alguien completa los datos, la fila
// pasa a "procesado", el archivo se mueve a "procesados" y se escribe el
// Registro correspondiente en su hoja de consumo.
//
// Columnas de la hoja "Fotos" (1-based):
//   1 File ID | 2 Drive URL | 3 Fecha subida | 4 Tipo | 5 Sucursal
//   6 Subcategoría | 7 Período | 8 Status | 9 Fecha completado | 10 Consumo
//  11 Unidad | 12 Costo | 13 Proveedor | 14 Notas

const COLS = {
  fileId: 1, link: 2, fechaSubida: 3, tipo: 4, sucursal: 5, subcat: 6,
  periodo: 7, status: 8, fechaCompletado: 9, consumo: 10, unidad: 11,
  costo: 12, proveedor: 13, notas: 14,
};

export async function readFotos() {
  const data = await apiGet({ action: "getFotos" }, { tag: TAGS.fotos, revalidate: 15 });
  const rows = (data && data.rows) || [];
  return rows.map((r, i) => ({
    // Fila 1 es encabezado: el primer registro está en la fila 2.
    rowIndex: i + 2,
    // `id` para que la interfaz no dependa de la posición: en la planilla es la
    // fila, en PostgreSQL es la PK, y la pantalla no tiene que saber cuál es.
    id: String(i + 2),
    fileId: r[0] || "",
    link: r[1] || "",
    fechaSubida: r[2] || "",
    tipo: r[3] || "",
    sucursal: r[4] || "",
    subcat: r[5] || "",
    periodo: r[6] || "",
    status: String(r[7] || "").toLowerCase(),
    fechaCompletado: r[8] || "",
    consumo: r[9] || "",
    unidad: r[10] || "",
    costo: r[11] || "",
    proveedor: r[12] || "",
    notas: r[13] || "",
  }));
}

/**
 * Sube la foto y deja la fila pendiente. `uploadedAt` se pasa desde el llamador
 * para que el momento registrado sea el de la acción, no el del reintento.
 */
export async function uploadFoto({
  file, tipo, sucursal, periodo, subcat,
  consumo, unidad, costo, proveedor, notas,
  uploadedAt = new Date().toISOString(),
}) {
  const folders = await getDriveFolders();
  if (!folders.fotosPorCompletar) {
    throw new Error("Falta la carpeta de fotos por completar en la config de la instancia.");
  }
  const up = await uploadToDrive(file, folders.fotosPorCompletar);
  const row = [
    up.id, up.link, uploadedAt,
    tipo || "", sucursal || "", subcat || "",
    periodo || "", "pendiente", "",
    consumo || "", unidad || "", costo || "",
    proveedor || "", notas || "",
  ];
  await apiPost({ action: "append", sheet: SHEETS.FOTOS, values: [row] });
  return { fileId: up.id, link: up.link };
}

/**
 * Marca la fila como procesada, escribe el Registro de consumo y archiva el
 * archivo en Drive.
 *
 * A diferencia del prototipo (que armaba la fila de consumo a mano, con
 * etiquetas propias como "Electricidad" en vez de "⚡Energía kWh"), acá el
 * Registro se escribe con el mismo writer que el resto de la app, así las tres
 * vías de ingreso — manual, documento y foto — dejan filas idénticas.
 */
export async function completeFoto({ id, rowIndex, fotoRow, patch, completedAt = new Date().toISOString() }) {
  // `id` es la fila, en texto: es lo que manda la interfaz desde que las fotos
  // dejaron de identificarse por su posición en la lista.
  const fila = rowIndex || parseInt(id ?? fotoRow?.id, 10);
  if (!fila) throw new Error("Falta el id de la fila de la foto");
  rowIndex = fila;
  const f = fotoRow || {};

  // Incluye tipo/sucursal/período porque el formulario de Completar permite
  // corregirlos, no solo agregar los datos que faltaban.
  const cells = [
    { row: rowIndex, col: COLS.tipo, value: f.tipo || "" },
    { row: rowIndex, col: COLS.sucursal, value: f.sucursal || "" },
    { row: rowIndex, col: COLS.subcat, value: patch.subcat || "" },
    { row: rowIndex, col: COLS.periodo, value: f.periodo || "" },
    { row: rowIndex, col: COLS.status, value: "procesado" },
    { row: rowIndex, col: COLS.fechaCompletado, value: completedAt },
    { row: rowIndex, col: COLS.consumo, value: patch.consumo || "" },
    { row: rowIndex, col: COLS.unidad, value: patch.unidad || "" },
    { row: rowIndex, col: COLS.costo, value: patch.costo || "" },
    { row: rowIndex, col: COLS.proveedor, value: patch.proveedor || "" },
    { row: rowIndex, col: COLS.notas, value: patch.notas || "" },
  ];
  await apiPost({ action: "updateCells", sheet: SHEETS.FOTOS, cells });

  // El Registro de consumo se atribuye al cierre del período fotografiado.
  if (["combustible", "electricidad", "agua"].includes(f.tipo)) {
    await appendRecords([
      {
        type: f.tipo,
        date: lastDayOfMonth(f.periodo),
        sucursal: f.sucursal || "",
        subcat: patch.subcat || null,
        provider: patch.proveedor || "",
        cantidad: parseFloat(patch.consumo) || 0,
        costo: parseFloat(patch.costo) || 0,
        origen: "foto",
        estado: "activa",
        _driveLink: f.link || "",
      },
    ]);
  }

  const folders = await getDriveFolders();
  if (f.fileId && folders.fotosProcesados) {
    await moveInDrive(f.fileId, folders.fotosPorCompletar, folders.fotosProcesados);
  }
}

/**
 * Aviso por correo de que quedó una foto pendiente. No propaga el error: el
 * aviso no debe hacer fallar la subida.
 */
export async function notifyFotoPending(info) {
  try {
    await apiPost({ action: "notifyFotoPending", ...(info || {}) });
  } catch (err) {
    console.warn("[rc] notifyFotoPending falló:", err.message);
  }
}
