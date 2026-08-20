"use server";

import { revalidateTag } from "next/cache";
import { TAGS } from "@/lib/apps-script";
import { run } from "@/lib/result";
import {
  deleteSucursal, renameSucursalInRecords, upsertEmissions, upsertSucursal,
  writeFotoNotifEmails, writeSucursales,
} from "@/lib/backend";
import { patchEmisionesVacio, resumenPatchEmisiones } from "@/lib/domain/emisiones-patch";

/**
 * Guarda una sola sucursal. Es la vía normal: no pisa lo que otra sesión haya
 * guardado sobre las demás sucursales.
 *
 * `renombrarDesde` (opcional) es el nombre anterior: si viene, los registros
 * históricos de esa sucursal quedan con el nombre nuevo. Se hace ANTES del
 * upsert, para que un fallo a mitad de camino deje la configuración vieja
 * coherente con las filas viejas.
 */
export async function saveSucursalAction(sucursal, { renombrarDesde } = {}) {
  return run(async () => {
    let renombrados = 0;
    if (renombrarDesde && renombrarDesde !== sucursal.nombre) {
      renombrados = await renameSucursalInRecords(renombrarDesde, sucursal.nombre);
    }
    await upsertSucursal(sucursal);
    revalidateTag(TAGS.sucursales);
    if (renombrados) revalidateTag(TAGS.records);
    return { renombrados };
  });
}

/**
 * Guarda varias sucursales de una vez: el wizard de puesta en marcha define un
 * conjunto completo. Es aditivo (upsert por id, una por una), no un reemplazo:
 * si ya había sucursales configuradas, no se pierden.
 *
 * Secuencial a propósito — el Apps Script serializa las mutaciones con un lock,
 * así que mandarlas en paralelo solo agrega espera.
 */
export async function saveSucursalesAction(sucursales) {
  return run(async () => {
    let guardadas = 0;
    for (const suc of sucursales || []) {
      await upsertSucursal(suc);
      guardadas++;
    }
    revalidateTag(TAGS.sucursales);
    return { guardadas };
  });
}

export async function deleteSucursalAction(id) {
  return run(async () => {
    await deleteSucursal(id);
    revalidateTag(TAGS.sucursales);
    return {};
  });
}

/**
 * Reescribe la tabla completa de sucursales. Reservado para el onboarding, que
 * define el conjunto inicial de una vez.
 */
export async function replaceSucursalesAction(sucursales) {
  return run(async () => {
    await writeSucursales(sucursales);
    revalidateTag(TAGS.sucursales);
    return {};
  });
}

// Techo de borrados por guardado, por lo mismo que en saveMedidoresPatchAction: un
// patch que pide borrar más filas que esto es casi seguro un cliente que perdió su
// estado de referencia. El número es holgado — la hoja completa de una instalación
// típica ronda las 100 filas.
const MAX_BORRADOS_EMISIONES = 150;

/**
 * Factores de emisión, overrides por sucursal, refrigerantes y metas.
 *
 * Recibe un patch, no el objeto completo. Antes recibía todo y reescribía la hoja
 * "Emisiones" entera, así que dos personas editando factores o metas se borraban el
 * trabajo sin aviso. Ver lib/domain/emisiones-patch.js.
 */
export async function saveEmissionsPatchAction(patch) {
  return run(async () => {
    if (patchEmisionesVacio(patch)) return { resumen: null };

    const resumen = resumenPatchEmisiones(patch);
    if (resumen.borradas > MAX_BORRADOS_EMISIONES) {
      throw new Error(
        `El guardado pedía borrar ${resumen.borradas} filas (máximo ` +
          `${MAX_BORRADOS_EMISIONES}). No se escribió nada. Recargá la pantalla ` +
          `para volver a partir de lo que tiene la planilla.`,
      );
    }

    const escrito = await upsertEmissions(patch);
    console.warn("[rc:emisiones] patch aplicado", JSON.stringify(escrito));
    revalidateTag(TAGS.emissions);
    return { resumen, escrito };
  });
}

export async function saveFotoNotifEmailsAction(emails) {
  return run(async () => {
    await writeFotoNotifEmails(emails);
    revalidateTag(TAGS.config);
    return {};
  });
}
