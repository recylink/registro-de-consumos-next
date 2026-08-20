"use server";

import { revalidateTag } from "next/cache";
import { TAGS } from "@/lib/apps-script";
import { run } from "@/lib/result";
import { completeFoto, notifyFotoPending, uploadFoto } from "@/lib/backend";

/**
 * Sube una foto de boleta y deja la fila pendiente de completar. El aviso por
 * correo se dispara después de que la fila ya existe, y no puede hacer fallar la
 * subida.
 */
export async function uploadFotoAction(formData) {
  return run(async () => {
    const file = formData.get("file");
    if (!file || typeof file === "string") throw new Error("Falta la foto");

    const campos = {};
    for (const k of ["tipo", "sucursal", "periodo", "subcat", "consumo", "unidad", "costo", "proveedor", "notas"]) {
      campos[k] = formData.get(k) || "";
    }

    const res = await uploadFoto({ file, ...campos });
    revalidateTag(TAGS.fotos);
    await notifyFotoPending({ ...campos, link: res.link });
    return res;
  });
}

/**
 * Completa una foto pendiente: cierra la fila, escribe el Registro de consumo y
 * archiva el archivo en Drive. Invalida también los registros porque la fila
 * nueva tiene que aparecer en el dashboard.
 */
export async function completeFotoAction({ id, fotoRow, patch }) {
  return run(async () => {
    await completeFoto({ id, fotoRow, patch });
    revalidateTag(TAGS.fotos);
    revalidateTag(TAGS.records);
    return {};
  });
}
