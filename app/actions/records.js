"use server";

import { revalidateTag } from "next/cache";
import { TAGS } from "@/lib/apps-script";
import { run } from "@/lib/result";
import { updateRecordField } from "@/lib/backend";
import { attachDocument, submitManual, submitUpload } from "@/lib/flows";

// Los archivos llegan por FormData: es la única forma de mandar un File a un
// Server Action sin cargarlo entero en memoria del cliente como base64.
// Convención de claves: `factura:<recordId>` y `file:<nombre lógico>`.

function collectFiles(formData, prefix) {
  const out = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith(prefix) || typeof value === "string") continue;
    out.push({ key: key.slice(prefix.length), file: value });
  }
  return out;
}

/** Registro manual: escribe las filas y sube las facturas adjuntas. */
export async function submitManualAction(formData) {
  return run(async () => {
    const records = JSON.parse(formData.get("records") || "[]");
    const facturas = collectFiles(formData, "factura:").map(({ key, file }) => ({
      recordId: key,
      file,
    }));
    const res = await submitManual({ records, facturas });
    revalidateTag(TAGS.records);
    return res;
  });
}

/** Documentos de proveedor ya extraídos y revisados en la tabla de preview. */
export async function submitUploadAction(formData) {
  return run(async () => {
    const records = JSON.parse(formData.get("records") || "[]");
    const providerId = formData.get("providerId") || "";
    const files = collectFiles(formData, "file:").map(({ key, file }) => ({ name: key, file }));
    const res = await submitUpload({ providerId, records, files });
    revalidateTag(TAGS.records);
    return res;
  });
}

/** Edición inline de una celda del dashboard. */
export async function editRecordAction({ id, field, value }) {
  return run(async () => {
    const target = await updateRecordField(id, field, value);
    revalidateTag(TAGS.records);
    return { target };
  });
}

/** Adjunta un documento a un registro existente. */
export async function attachDocumentAction(formData) {
  return run(async () => {
    const recordId = formData.get("recordId");
    const file = formData.get("file");
    if (!file || typeof file === "string") throw new Error("Falta el archivo");
    const up = await attachDocument({ recordId, file });
    revalidateTag(TAGS.records);
    return { file: up };
  });
}

/** Fuerza relectura de la planilla (botón "actualizar" del dashboard). */
export async function refreshRecordsAction() {
  return run(async () => {
    revalidateTag(TAGS.records);
    return {};
  });
}
