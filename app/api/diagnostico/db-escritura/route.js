import { NextResponse } from "next/server";
import { usarPostgres } from "@/lib/backend";
import * as datos from "@/lib/backend";
import { enTransaccion } from "@/lib/db/cliente";

// Prueba de escritura de punta a punta contra PostgreSQL, por el MISMO camino
// que usa la app: no toca SQL, llama a las funciones que llaman las pantallas.
//
//   curl -s -X POST http://localhost:3000/api/diagnostico/db-escritura | jq
//
// Escribe de verdad y **borra lo que escribió** al terminar, incluso si algo
// falla a mitad de camino. Todo lo que crea lleva el prefijo `ZZ prueba` para
// que sea reconocible si alguna vez quedara algo.
//
// Es POST y no GET a propósito: un GET lo dispararía cualquier prefetch del
// navegador, y esto escribe.

export const dynamic = "force-dynamic";

const MARCA = "ZZ prueba escritura";

/** Borra por SQL lo que la prueba creó. Es limpieza, no parte de la prueba. */
async function limpiar({ registroId, sucursalId }) {
  await enTransaccion(async (cli, emp) => {
    if (registroId) {
      await cli.query("DELETE FROM registro_consumo WHERE empresa_id = $1 AND id = $2", [
        emp,
        registroId,
      ]);
    }
    if (sucursalId) {
      await cli.query(
        "DELETE FROM sucursal_subcategoria WHERE empresa_id = $1 AND sucursal_id = $2",
        [emp, sucursalId],
      );
      await cli.query("DELETE FROM sucursal WHERE empresa_id = $1 AND id = $2", [
        emp,
        sucursalId,
      ]);
    }
  });
}

export async function POST() {
  if (!usarPostgres) {
    return NextResponse.json(
      { error: "Solo sirve con DATOS_BACKEND=postgres; ahora la app usa la planilla." },
      { status: 400 },
    );
  }

  const pasos = [];
  const anotar = (paso, ok, detalle) => pasos.push({ paso, ok, ...(detalle ? { detalle } : {}) });
  const creado = { registroId: null, sucursalId: null };
  let correosPrevios = null;

  try {
    // --- 1. Crear una sucursal ---------------------------------------
    const nombreSuc = `${MARCA} sucursal`;
    await datos.upsertSucursal({
      id: "suc_prueba_escritura",
      nombre: nombreSuc,
      direccion: "Calle de prueba 123",
      activa: true,
      items: {
        agua: { activo: true, subcats: [{ id: "sc0", tipo: "potable", proveedor: "Esval" }] },
      },
    });
    const sucursales = await datos.readSucursales();
    const suc = sucursales.find((s) => s.nombre === nombreSuc);
    creado.sucursalId = suc?.id || null;
    anotar("crear sucursal con una subcategoría", Boolean(suc), {
      subcategorias: suc?.items?.agua?.subcats?.length ?? 0,
      proveedorGuardado: suc?.items?.agua?.subcats?.[0]?.proveedor ?? null,
    });

    // --- 2. Escribir un consumo -------------------------------------
    const escritos = await datos.appendRecords([
      {
        type: "agua",
        date: "2026-05-11",
        sucursal: nombreSuc,
        subcat: "potable",
        provider: "Esval",
        cantidad: 12.5,
        unit: "m³",
        costo: 9990,
        origen: "manual",
        estado: "activa",
        numeroCliente: "PRUEBA-1",
      },
    ]);
    const registros = await datos.readRecords();
    const reg = registros.find((r) => r.sucursal === nombreSuc);
    creado.registroId = reg?.id || null;
    anotar("escribir un consumo", escritos === 1 && Boolean(reg), {
      leidoDeVuelta: reg
        ? { cantidad: reg.cantidad, unidad: reg.unit, costo: reg.costo, proveedor: reg.provider }
        : null,
    });

    // --- 3. Editar una celda ----------------------------------------
    if (reg) {
      await datos.updateRecordField(reg.id, "costo", 12345);
      const despues = (await datos.readRecords()).find((r) => r.id === reg.id);
      anotar("editar el costo de ese consumo", despues?.costo === 12345, {
        antes: reg.costo,
        despues: despues?.costo,
      });

      // El mes es una columna generada: cambiar la fecha tiene que moverlo solo.
      await datos.updateRecordField(reg.id, "date", "2026-08-03");
      const conFecha = (await datos.readRecords()).find((r) => r.id === reg.id);
      anotar("cambiar la fecha", conFecha?.date === "2026-08-03", { fecha: conFecha?.date });
    }

    // --- 4. Renombrar la sucursal: el historial NO se reescribe ------
    if (suc) {
      const nuevoNombre = `${MARCA} renombrada`;
      const reescritos = await datos.renameSucursalInRecords(nombreSuc, nuevoNombre);
      await datos.upsertSucursal({ ...suc, nombre: nuevoNombre });
      const reg2 = (await datos.readRecords()).find((r) => r.id === creado.registroId);
      anotar(
        "renombrar la sucursal y que su consumo la siga",
        reescritos === 0 && reg2?.sucursal === nuevoNombre,
        { filasReescritas: reescritos, sucursalDelConsumo: reg2?.sucursal },
      );
    }

    // --- 5. Destinatarios del aviso de fotos ------------------------
    correosPrevios = await datos.readFotoNotifEmails();
    await datos.writeFotoNotifEmails(["prueba@example.com", "no-es-un-correo", "prueba@example.com"]);
    const correos = await datos.readFotoNotifEmails();
    anotar(
      "guardar destinatarios, filtrando basura y repetidos",
      correos.length === 1 && correos[0] === "prueba@example.com",
      { guardados: correos },
    );
  } catch (err) {
    anotar("ERROR", false, { mensaje: err.message });
  } finally {
    try {
      await limpiar(creado);
      if (correosPrevios) await datos.writeFotoNotifEmails(correosPrevios);
      anotar("limpieza: se borró todo lo que creó la prueba", true);
    } catch (err) {
      anotar("limpieza", false, { mensaje: err.message });
    }
  }

  const fallidos = pasos.filter((p) => !p.ok);
  return NextResponse.json(
    {
      veredicto: fallidos.length ? `${fallidos.length} paso(s) fallaron` : "escritura verificada",
      pasos,
    },
    { status: fallidos.length ? 500 : 200 },
  );
}
