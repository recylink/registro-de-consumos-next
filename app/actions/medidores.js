"use server";

import { revalidateTag } from "next/cache";
import { TAGS } from "@/lib/apps-script";
import { run } from "@/lib/result";
import { upsertMedidores } from "@/lib/backend";
import { patchVacio, resumenPatch } from "@/lib/domain/medidores-patch";
import { getDriveFolders, medidorFolder } from "@/lib/drive-folders";
import { meterFolderName, trashInDrive, uploadToDrive } from "@/lib/drive";
import { loadRecords } from "@/lib/data";
import { medidoresWorkbook } from "@/lib/reportes/medidores-excel";

// Techo de borrados por guardado. No es una política de producto, es un fusible:
// ninguna edición humana borra tantas filas de una vez —la operación más amplia,
// `applyPriceFrom`, limpia los meses de UNA (sucursal, tipo)—, así que un patch que
// pide más que esto es casi seguro un cliente que perdió su estado de referencia y
// está pidiendo borrar lo que en realidad nunca vio.
//
// Falla ruidoso a propósito. El fusible sirve si el usuario se entera y recarga;
// recortar el patch en silencio dejaría la planilla a medio camino y sin rastro.
const MAX_BORRADOS = 200;

/**
 * Aplica un patch del módulo Medidores: solo las filas que cambiaron.
 *
 * Recibe un patch y NO el módulo completo, que es el punto. Mientras el cliente
 * mandara la tabla entera, ninguna defensa del servidor alcanzaba: "esta fila no
 * viene en lo que mandé" es ambiguo entre "la borré" y "nunca la vi", y con esa
 * ambigüedad cualquier escritura podía borrar el trabajo de otro dispositivo. Ver
 * lib/domain/medidores-patch.js.
 */
export async function saveMedidoresPatchAction(patch) {
  return run(async () => {
    if (patchVacio(patch)) return { resumen: {} };

    const resumen = resumenPatch(patch);
    const borrados = Object.values(resumen).reduce((n, r) => n + r.borradas, 0);
    if (borrados > MAX_BORRADOS) {
      throw new Error(
        `El guardado pedía borrar ${borrados} filas (máximo ${MAX_BORRADOS}). ` +
          `No se escribió nada. Recargá la pantalla para volver a partir de lo que ` +
          `tiene la planilla.`,
      );
    }

    const escrito = await upsertMedidores(patch);
    // Un guardado no dejaba ningún rastro: si escribía 3 filas o 300, en el log se
    // veía igual. Los conteos vienen de la planilla, no del patch.
    console.warn("[rc:medidores] patch aplicado", JSON.stringify(escrito));
    revalidateTag(TAGS.medidores);
    return { resumen, escrito };
  });
}

/**
 * Sube un documento de medidor. `kind` es "factura" | "pago" | "respaldo".
 * Los respaldos se ordenan en subcarpetas <medidor>/<mes> dentro de la carpeta
 * del tipo de consumo; el Apps Script las crea si faltan.
 */
export async function uploadMedidorDocAction(formData) {
  return run(async () => {
    const file = formData.get("file");
    if (!file || typeof file === "string") throw new Error("Falta el archivo");
    const kind = formData.get("kind") || "factura";
    const month = formData.get("month") || "";
    const meter = JSON.parse(formData.get("meter") || "null");

    const folders = await getDriveFolders();
    const folderId = medidorFolder(folders, kind, meter && meter.type);
    if (!folderId) throw new Error(`Carpeta de Drive no configurada para "${kind}".`);

    const subfolders = kind === "respaldo" && meter ? [meterFolderName(meter), month] : [];
    const up = await uploadToDrive(file, folderId, subfolders);
    revalidateTag(TAGS.medidores);
    return { doc: { fileId: up.id, link: up.link, name: file.name } };
  });
}

/** Manda el archivo a la papelera de Drive. La fila se limpia por separado. */
export async function deleteMedidorDocAction(fileId) {
  return run(async () => {
    await trashInDrive(fileId);
    revalidateTag(TAGS.medidores);
    return {};
  });
}

/**
 * Arma el Excel del módulo y lo devuelve en base64.
 *
 * El módulo (`M`) llega del cliente y no se lee de la planilla a propósito: la
 * pantalla guarda con debounce, así que exportar justo después de escribir una
 * lectura tomaría el valor viejo. Los registros globales sí salen del servidor,
 * porque esta pantalla no los edita.
 */
export async function exportMedidoresExcelAction({ M, sucursal, tipo, meses }) {
  return run(async () => {
    const records = await loadRecords();
    return medidoresWorkbook({ M, records: records.data, sucursal, tipo, meses });
  });
}
