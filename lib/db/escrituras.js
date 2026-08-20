import "server-only";
import { consultar, enTransaccion, unidadBase } from "./cliente";
// Se lee de la base, no de `lib/drive-folders`: ese modulo elige backend y
// eligiendo backend importaria este archivo, cerrando un ciclo de imports.
import { readDriveFolders } from "./lecturas";
import { uploadToDrive, moveInDrive } from "../drive";
import { aguaSubcatFromConfig, combustibleSubcatFromConfig } from "../domain/sucursales";
import { TYPES } from "../domain/catalog";

// Las escrituras de la app contra PostgreSQL, con las mismas firmas que
// `lib/sheets/`. Lo que en una planilla era "agregar una fila" aquí es un
// INSERT, y lo que era "escribir la celda de la fila 14" es un UPDATE por id.
//
// Tres diferencias de fondo respecto de la planilla, y ninguna es cosmética:
//
// 1. **Las referencias son de verdad.** La planilla guardaba el NOMBRE de la
//    sucursal y el NOMBRE del proveedor dentro de cada fila de consumo. Aquí se
//    guarda su id, así que renombrar una sucursal ya no obliga a reescribir su
//    historial: por eso `renameSucursalInRecords` no hace nada.
// 2. **Todo lo que tiene que pasar junto pasa junto.** Guardar una sucursal son
//    varias escrituras (la sucursal y sus subcategorías); van en una
//    transacción, así que un fallo a mitad no deja una configuración partida.
// 3. **Los ids nuevos los pone la base.** La interfaz inventa un id al crear
//    una sucursal (`nextSucId()`); ese id se guarda como `legacy_id` y se
//    acepta después para encontrarla, así que un enlace viejo sigue sirviendo.

const esUuid = (v) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ""));

const slug = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

// ---------------------------------------------------------------------
// Resolver referencias: de nombre o id de la interfaz al id de la base
// ---------------------------------------------------------------------

/**
 * Una sucursal por uuid, por su id heredado, o por nombre. Los tres, porque la
 * interfaz manda cualquiera de ellos segun de donde venga el dato.
 *
 * `id::text = $2` y no `id = $2::uuid`: en la misma condicion se compara contra
 * `legacy_id`, que es texto. Al forzar el parametro a uuid, Postgres lo deduce
 * uuid para todas las comparaciones y la siguiente falla con
 * "operator does not exist: text = uuid". Comparar el uuid como texto evita el
 * problema de raiz; la tabla es chica y la condicion es un OR de todas formas.
 */
async function idSucursal(cli, emp, ref) {
  if (!ref) return null;
  const { rows } = await cli.query(
    `SELECT id FROM sucursal
      WHERE empresa_id = $1 AND ($2 IN (id::text, legacy_id, nombre))
      LIMIT 1`,
    [emp, String(ref)],
  );
  return rows[0]?.id || null;
}

/**
 * Un proveedor por nombre, dentro de su tipo. Si no está en el catálogo se
 * agrega: la planilla guardaba el texto libre, así que no encontrarlo aquí
 * significaría perder el dato. Queda con `slug` derivado del nombre.
 */
async function idProveedor(cli, nombre, tipo) {
  const n = String(nombre || "").trim();
  // "—" es el guion que la planilla usa como "ninguno", no un proveedor.
  if (!n || n === "—" || n === "-" || !tipo) return null;
  const { rows } = await cli.query(
    "SELECT id FROM proveedor WHERE tipo_consumo = $1 AND nombre = $2",
    [tipo, n],
  );
  if (rows[0]) return rows[0].id;
  const { rows: nuevo } = await cli.query(
    `INSERT INTO proveedor (slug, nombre, tipo_consumo) VALUES ($1, $2, $3)
     ON CONFLICT (tipo_consumo, slug) DO UPDATE SET nombre = EXCLUDED.nombre
     RETURNING id`,
    [slug(n) || "sin-nombre", n, tipo],
  );
  return nuevo[0].id;
}

/** Un archivo de Drive, por su enlace. Se crea si es la primera vez que se ve. */
async function idArchivo(cli, emp, { link, nombre, fileId }) {
  if (!link && !fileId) return null;
  // Cuando solo hay enlace, la clave es el enlace: es lo que hacía el volcado.
  const clave = fileId || `link:${link}`;
  const { rows } = await cli.query(
    `INSERT INTO archivo_drive (empresa_id, drive_file_id, url, nombre)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (empresa_id, drive_file_id)
       DO UPDATE SET url = COALESCE(EXCLUDED.url, archivo_drive.url)
     RETURNING id`,
    [emp, clave, link || null, nombre || null],
  );
  return rows[0].id;
}

/**
 * Asegura que una subcategoría exista en el catálogo antes de referenciarla.
 * Las que crea el usuario (`otro:<slug>`) no están de antemano, y la FK es
 * RESTRICT: sin esto, guardar una subcategoría propia fallaría.
 */
async function asegurarSubcategoria(cli, id, tipo, label, unidad) {
  if (!id) return null;
  await cli.query(
    `INSERT INTO subcategoria (id, tipo_consumo, label, origen, unidad_default)
     VALUES ($1, $2, $3, 'custom',
             COALESCE($4::unidad_medida,
                      (SELECT unidad_default FROM tipo_consumo WHERE id = $2)))
     ON CONFLICT (id) DO NOTHING`,
    [id, tipo, label || String(id).replace(/^otro:/, ""), unidadBase(unidad)],
  );
  return id;
}

// =====================================================================
// 1. Registros de consumo
// =====================================================================

export async function appendRecords(records) {
  const lista = (records || []).filter(Boolean);
  if (!lista.length) return 0;

  return enTransaccion(async (cli, emp) => {
    let escritos = 0;
    for (const r of lista) {
      const sucId = await idSucursal(cli, emp, r.sucursal);
      // Sin sucursal no hay fila, igual que en la planilla: la alternativa es
      // una fila huérfana que después nadie sabe de quién es.
      if (!sucId) continue;

      if (r.subcat) {
        await asegurarSubcategoria(cli, r.subcat, r.type, null, r.unit);
      }
      const provId = await idProveedor(cli, r.provider, r.type);
      const archId = r._driveLink ? await idArchivo(cli, emp, { link: r._driveLink }) : null;

      await cli.query(
        `INSERT INTO registro_consumo
           (empresa_id, sucursal_id, tipo_consumo, subcategoria_id, proveedor_id,
            num_cliente, fecha, consumo, unidad, costo, estado, origen, archivo_id,
            refrigerante_gas_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                 COALESCE($9::unidad_medida,
                          (SELECT unidad_default FROM subcategoria WHERE id = $4),
                          (SELECT unidad_default FROM tipo_consumo WHERE id = $3)),
                 $10, $11, $12, $13, $14)`,
        [
          emp,
          sucId,
          r.type,
          r.subcat || null,
          provId,
          r.numeroCliente || null,
          r.date,
          r.cantidad == null || r.cantidad === "" ? null : r.cantidad,
          unidadBase(r.unit),
          r.costo == null || r.costo === "" ? null : r.costo,
          r.estado || "activa",
          r.origen || "manual",
          archId,
          r.refrigeranteGas || null,
        ],
      );
      escritos++;
    }
    return escritos;
  });
}

// Qué columna toca cada campo editable del dashboard. Los tres que necesitan
// resolver una referencia van aparte, más abajo.
const COLUMNA = {
  date: "fecha",
  cantidad: "consumo",
  costo: "costo",
  estado: "estado",
  origen: "origen",
  subcat: "subcategoria_id",
  numeroCliente: "num_cliente",
};

export async function updateRecordField(id, field, value) {
  return enTransaccion(async (cli, emp) => {
    let columna = COLUMNA[field];
    let valor = value;

    if (field === "sucursal") {
      columna = "sucursal_id";
      valor = await idSucursal(cli, emp, value);
      if (!valor) throw new Error(`No existe la sucursal "${value}".`);
    } else if (field === "provider") {
      const { rows } = await cli.query(
        "SELECT tipo_consumo FROM registro_consumo WHERE empresa_id = $1 AND id = $2",
        [emp, id],
      );
      if (!rows[0]) throw new Error(`No se encontró el registro ${id}.`);
      columna = "proveedor_id";
      valor = await idProveedor(cli, value, rows[0].tipo_consumo);
    } else if (field === "link") {
      columna = "archivo_id";
      valor = await idArchivo(cli, emp, { link: value });
    } else if (field === "subcat" && value) {
      const { rows } = await cli.query(
        "SELECT tipo_consumo FROM registro_consumo WHERE empresa_id = $1 AND id = $2",
        [emp, id],
      );
      if (rows[0]) await asegurarSubcategoria(cli, value, rows[0].tipo_consumo);
    }

    if (!columna) throw new Error(`Campo no editable: ${field}`);

    const { rowCount } = await cli.query(
      `UPDATE registro_consumo SET ${columna} = $3 WHERE empresa_id = $1 AND id = $2`,
      [emp, id, valor === "" ? null : valor],
    );
    // Igual que en la planilla: que no se encuentre la fila es un error, no un
    // no-op silencioso. El usuario editó algo y hay que decirle que no quedó.
    if (!rowCount) throw new Error(`No se encontró el registro ${id}.`);
    return { porId: true, filas: rowCount, campo: columna };
  });
}

/**
 * No hace nada, y es correcto.
 *
 * En la planilla cada fila de consumo guardaba el NOMBRE de su sucursal, así que
 * renombrarla obligaba a reescribir todas sus filas históricas. Aquí la fila
 * apunta a la sucursal por id: al cambiarle el nombre, el historial ya quedó
 * actualizado. Devuelve 0 porque no reescribió nada, que es la verdad.
 */
export async function renameSucursalInRecords() {
  return 0;
}

/** En la planilla decía si las hojas ya tenían columna ID. Aquí siempre hay PK. */
export async function registrosConId() {
  return true;
}

// =====================================================================
// 2. Sucursales
// =====================================================================

/** La subcategoría configurada -> el id del catálogo, según el tipo. */
function subcatDeConfig(tipo, sc) {
  if (tipo === "agua") return aguaSubcatFromConfig(sc);
  if (tipo === "combustible") return combustibleSubcatFromConfig(sc);
  // Electricidad no tiene subcategoría; el resto usa el valor tal cual.
  if (tipo === "electricidad" || !sc?.tipo) return null;
  return { id: sc.tipo === "__otro" ? `otro:${slug(sc.tipoCustom)}` : sc.tipo, label: null };
}

export async function upsertSucursal(suc) {
  if (!suc || !suc.id) throw new Error("Sucursal sin id");

  return enTransaccion(async (cli, emp) => {
    let id = await idSucursal(cli, emp, suc.id);

    if (id) {
      await cli.query(
        `UPDATE sucursal SET nombre = $3, direccion = $4, activa = $5
          WHERE empresa_id = $1 AND id = $2`,
        [emp, id, suc.nombre || "", suc.direccion || null, suc.activa !== false],
      );
    } else {
      // Nueva: el id que trae la interfaz queda como clave heredada, para que
      // un enlace hecho con ese id siga encontrándola.
      const { rows } = await cli.query(
        `INSERT INTO sucursal (empresa_id, nombre, direccion, activa, legacy_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [emp, suc.nombre || "", suc.direccion || null, suc.activa !== false, String(suc.id)],
      );
      id = rows[0].id;
    }

    // Las subcategorías se reemplazan en bloque, no se van diferenciando: es lo
    // que la interfaz manda (el conjunto completo de la sucursal) y evita tener
    // que adivinar qué fila corresponde a cuál. Nada cuelga de estas filas —los
    // consumos apuntan al CATÁLOGO de subcategorías, no a esta tabla— así que
    // borrarlas y volver a crearlas no arrastra datos.
    await cli.query(
      "DELETE FROM sucursal_subcategoria WHERE empresa_id = $1 AND sucursal_id = $2",
      [emp, id],
    );

    for (const [tipo, item] of Object.entries(suc.items || {})) {
      if (!item?.activo) continue;
      for (const sc of item.subcats || []) {
        const opcion = subcatDeConfig(tipo, sc);
        if (opcion?.id) {
          await asegurarSubcategoria(
            cli,
            opcion.id,
            tipo,
            opcion.label,
            sc.unidad || (TYPES[tipo] ? TYPES[tipo].unit : null),
          );
        }
        await cli.query(
          `INSERT INTO sucursal_subcategoria
             (empresa_id, sucursal_id, tipo_consumo, subcategoria_id, proveedor_id,
              unidad, num_cliente, sistema_electrico, uso, legacy_id)
           VALUES ($1, $2, $3, $4, $5, $6::unidad_medida, $7, $8, $9, $10)`,
          [
            emp,
            id,
            tipo,
            opcion?.id || null,
            await idProveedor(cli, sc.proveedor === "__otro" ? sc.proveedorCustom : sc.proveedor, tipo),
            unidadBase(sc.unidad),
            sc.numCliente || null,
            sc.sistemaElectrico || null,
            sc.uso || null,
            esUuid(sc.id) ? null : sc.id || null,
          ],
        );
      }
    }
    return { id };
  });
}

export async function writeSucursales(sucursales) {
  for (const suc of sucursales || []) await upsertSucursal(suc);
  return (sucursales || []).length;
}

/**
 * Baja lógica, no borrado. La planilla borraba las filas de configuración pero
 * los consumos históricos quedaban; aquí un DELETE real fallaría por la FK de
 * `registro_consumo` (es RESTRICT a propósito: perder el historial de una
 * sucursal no puede ser el efecto de un clic). Se desactiva.
 */
export async function deleteSucursal(id) {
  if (!id) throw new Error("Falta el id de la sucursal");
  return enTransaccion(async (cli, emp) => {
    const sucId = await idSucursal(cli, emp, id);
    if (!sucId) throw new Error(`No se encontró la sucursal ${id}.`);
    await cli.query("UPDATE sucursal SET activa = false WHERE empresa_id = $1 AND id = $2", [
      emp,
      sucId,
    ]);
    await cli.query(
      "UPDATE sucursal_subcategoria SET activa = false WHERE empresa_id = $1 AND sucursal_id = $2",
      [emp, sucId],
    );
    return { id: sucId, desactivada: true };
  });
}

// =====================================================================
// 3. Medidores
// =====================================================================

export async function upsertMedidores(patch) {
  const p = patch || {};
  return enTransaccion(async (cli, emp) => {
    const out = {};

    // --- Medidores ---
    for (const m of p.meters?.upsert || []) {
      const sucId = await idSucursal(cli, emp, m.sucursal);
      if (!sucId) continue;
      // Mismo criterio que en idSucursal: el uuid se compara como texto.
      const existe = (
        await cli.query(
          "SELECT id FROM medidor WHERE empresa_id = $1 AND $2 IN (id::text, legacy_id)",
          [emp, String(m.id)],
        )
      ).rows[0]?.id;
      if (existe) {
        await cli.query(
          `UPDATE medidor SET sucursal_id = $3, tipo_consumo = $4, nombre = $5,
                              numero = $6, activo = $7, facturable = $8
            WHERE empresa_id = $1 AND id = $2`,
          [emp, existe, sucId, m.type, m.nombre || "", m.numero || null,
           m.activo !== false, m.facturable !== false],
        );
      } else {
        await cli.query(
          `INSERT INTO medidor (empresa_id, sucursal_id, tipo_consumo, nombre, numero,
                                activo, facturable, legacy_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [emp, sucId, m.type, m.nombre || "", m.numero || null,
           m.activo !== false, m.facturable !== false, String(m.id)],
        );
      }
    }
    for (const id of p.meters?.remove || []) {
      await cli.query(
        `UPDATE medidor SET activo = false
          WHERE empresa_id = $1 AND $2 IN (id::text, legacy_id)`,
        [emp, String(id)],
      );
    }

    // --- Lecturas y sus adjuntos ---
    for (const l of p.readings?.upsert || []) {
      const { rows } = await cli.query(
        `INSERT INTO lectura_medidor (empresa_id, medidor_id, periodo, lectura)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (medidor_id, periodo) DO UPDATE SET lectura = EXCLUDED.lectura
         RETURNING id`,
        [emp, l.meterId, l.month, l.lectura == null || l.lectura === "" ? null : l.lectura],
      );
      const lecturaId = rows[0].id;
      for (const rol of ["factura", "pago", "respaldo"]) {
        const doc = l[rol];
        if (!doc || !doc.link) continue;
        const archId = await idArchivo(cli, emp, {
          link: doc.link,
          nombre: doc.name,
          fileId: doc.fileId,
        });
        await cli.query(
          `INSERT INTO lectura_adjunto (empresa_id, lectura_medidor_id, rol, archivo_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (lectura_medidor_id, rol) DO UPDATE SET archivo_id = EXCLUDED.archivo_id`,
          [emp, lecturaId, rol, archId],
        );
      }
    }
    for (const r of p.readings?.remove || []) {
      await cli.query(
        "DELETE FROM lectura_medidor WHERE empresa_id = $1 AND medidor_id = $2 AND periodo = $3",
        [emp, r.meterId, r.month],
      );
    }

    // --- Precios ---
    for (const pr of p.prices?.upsert || []) {
      const sucId = await idSucursal(cli, emp, pr.sucursal);
      if (!sucId) continue;
      await cli.query(
        `INSERT INTO precio_periodo (empresa_id, sucursal_id, tipo_consumo, periodo, precio)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (sucursal_id, tipo_consumo, periodo)
           DO UPDATE SET precio = EXCLUDED.precio`,
        [emp, sucId, pr.type, pr.month, pr.precio],
      );
    }
    for (const pr of p.prices?.remove || []) {
      const sucId = await idSucursal(cli, emp, pr.sucursal);
      if (!sucId) continue;
      await cli.query(
        `DELETE FROM precio_periodo
          WHERE empresa_id = $1 AND sucursal_id = $2 AND tipo_consumo = $3 AND periodo = $4`,
        [emp, sucId, pr.type, pr.month],
      );
    }

    out.ok = true;
    return out;
  });
}

// =====================================================================
// 4. Emisiones
// =====================================================================

const CAMPO_META = {
  absoluta: "absoluta",
  relativa: "relativa",
  anioBase: "anio_base",
  baseEmissions: "base_emissions",
  baseMode: "base_mode",
};

export async function upsertEmissions(patch) {
  const filas = patch?.filas || {};
  const grupos = patch?.grupos || [];

  return enTransaccion(async (cli, emp) => {
    for (const e of filas.upsert || []) {
      const sucId = e.sucId ? await idSucursal(cli, emp, e.sucId) : null;

      if (e.scope === "factor-empresa") {
        await cli.query(
          `INSERT INTO factor_emision_empresa (empresa_id, factor_emision_id, valor)
           VALUES ($1, $2, $3)
           ON CONFLICT (empresa_id, factor_emision_id) DO UPDATE SET valor = EXCLUDED.valor`,
          [emp, e.key, e.value],
        );
      } else if (e.scope === "factor-sucursal" && sucId) {
        await cli.query(
          `INSERT INTO factor_emision_sucursal
             (empresa_id, sucursal_id, factor_emision_id, valor, pending_review)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (sucursal_id, factor_emision_id)
             DO UPDATE SET valor = EXCLUDED.valor, pending_review = EXCLUDED.pending_review`,
          [emp, sucId, e.key, e.value, Boolean(e.pendingReview)],
        );
      } else if (e.scope === "meta-empresa" || e.scope === "meta-sucursal") {
        const col = CAMPO_META[e.key];
        if (!col) continue;
        if (e.scope === "meta-empresa") {
          await cli.query(
            `INSERT INTO meta_empresa (empresa_id, ${col}) VALUES ($1, $2)
             ON CONFLICT (empresa_id) DO UPDATE SET ${col} = EXCLUDED.${col}`,
            [emp, e.value === "" ? null : e.value],
          );
        } else if (sucId) {
          await cli.query(
            `INSERT INTO meta_sucursal (empresa_id, sucursal_id, ${col}) VALUES ($1, $2, $3)
             ON CONFLICT (sucursal_id) DO UPDATE SET ${col} = EXCLUDED.${col}`,
            [emp, sucId, e.value === "" ? null : e.value],
          );
        }
      }
    }

    for (const e of filas.remove || []) {
      const sucId = e.sucId ? await idSucursal(cli, emp, e.sucId) : null;
      if (e.scope === "factor-empresa") {
        await cli.query(
          "DELETE FROM factor_emision_empresa WHERE empresa_id = $1 AND factor_emision_id = $2",
          [emp, e.key],
        );
      } else if (e.scope === "factor-sucursal" && sucId) {
        await cli.query(
          `DELETE FROM factor_emision_sucursal
            WHERE empresa_id = $1 AND sucursal_id = $2 AND factor_emision_id = $3`,
          [emp, sucId, e.key],
        );
      } else if (e.scope === "meta-empresa" && CAMPO_META[e.key]) {
        await cli.query(
          `UPDATE meta_empresa SET ${CAMPO_META[e.key]} = NULL WHERE empresa_id = $1`,
          [emp],
        );
      } else if (e.scope === "meta-sucursal" && sucId && CAMPO_META[e.key]) {
        await cli.query(
          `UPDATE meta_sucursal SET ${CAMPO_META[e.key]} = NULL
            WHERE empresa_id = $1 AND sucursal_id = $2`,
          [emp, sucId],
        );
      }
    }

    // Los refrigerantes llegan como GRUPO: la lista completa de una sucursal
    // reemplaza a la anterior. Antes era porque el `uid` de la planilla no era
    // estable; aquí se mantiene porque es lo que manda la pantalla de Factores.
    // Ahora son filas de consumo, así que se borran y se reescriben.
    for (const g of grupos) {
      const sucId = await idSucursal(cli, emp, g.sucId);
      if (!sucId) continue;
      await cli.query(
        `DELETE FROM registro_consumo
          WHERE empresa_id = $1 AND sucursal_id = $2 AND tipo_consumo = 'refrigerantes'`,
        [emp, sucId],
      );
      for (const rf of g.items || []) {
        if (!rf.tipo || !rf.mes) continue;
        await cli.query(
          `INSERT INTO registro_consumo
             (empresa_id, sucursal_id, tipo_consumo, refrigerante_gas_id, fecha,
              consumo, unidad, estado, origen)
           VALUES ($1, $2, 'refrigerantes', $3, ($4 || '-01')::date, $5, 'kg', 'activa', 'manual')`,
          [emp, sucId, rf.tipo, rf.mes, rf.cargaKg == null ? null : rf.cargaKg],
        );
      }
    }
    return { ok: true };
  });
}

// =====================================================================
// 5. Fotos
// =====================================================================

export async function uploadFoto({
  file, tipo, sucursal, periodo, subcat,
  consumo, unidad, costo, proveedor, notas,
  uploadedAt = new Date().toISOString(),
}) {
  // Drive no cambia: la imagen sigue yendo a la carpeta "por completar".
  const folders = await readDriveFolders();
  if (!folders.fotosPorCompletar) {
    throw new Error("Falta la carpeta de fotos por completar en la config de la instancia.");
  }
  const up = await uploadToDrive(file, folders.fotosPorCompletar);

  await enTransaccion(async (cli, emp) => {
    const archId = await idArchivo(cli, emp, { link: up.link, fileId: up.id });
    const sucId = sucursal ? await idSucursal(cli, emp, sucursal) : null;
    if (subcat && tipo) await asegurarSubcategoria(cli, subcat, tipo, null, unidad);
    await cli.query(
      `INSERT INTO foto (empresa_id, archivo_id, sucursal_id, tipo_consumo, subcategoria_id,
                         periodo, status, consumo, unidad, costo, proveedor_id, notas, subida_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pendiente', $7, $8::unidad_medida, $9, $10, $11, $12)`,
      [
        emp, archId, sucId, tipo || null, subcat || null, periodo || null,
        consumo === "" || consumo == null ? null : consumo,
        unidadBase(unidad),
        costo === "" || costo == null ? null : costo,
        proveedor ? await idProveedor(cli, proveedor, tipo) : null,
        notas || null,
        uploadedAt,
      ],
    );
  });
  return { fileId: up.id, link: up.link };
}

/**
 * Cierra una foto: marca la fila, escribe el consumo y archiva el archivo.
 *
 * El `rowIndex` de la planilla ya no existe —era la posición de la fila— así
 * que se acepta el `id` de la foto. Y hay una garantía nueva que la planilla no
 * podía dar: la foto y su consumo se escriben en la MISMA transacción, con el
 * enlace entre los dos guardado en `foto.registro_id`. Antes eran dos
 * escrituras sueltas y nada impedía completar la misma foto dos veces.
 */
export async function completeFoto({ id, fotoRow, patch, completedAt = new Date().toISOString() }) {
  const fotoId = id || fotoRow?.id;
  if (!fotoId) throw new Error("Falta el id de la foto");
  const f = fotoRow || {};
  const p = patch || {};

  const { registroEscrito, fileId } = await enTransaccion(async (cli, emp) => {
    const sucId = f.sucursal ? await idSucursal(cli, emp, f.sucursal) : null;
    if (p.subcat && f.tipo) await asegurarSubcategoria(cli, p.subcat, f.tipo, null, p.unidad);

    let registroId = null;
    // Solo los tipos que son un consumo dejan fila de consumo. El CHECK del
    // esquema exige gas para refrigerantes, así que no entran por aquí.
    if (sucId && f.tipo && f.tipo !== "refrigerantes" && f.periodo) {
      const { rows } = await cli.query(
        `INSERT INTO registro_consumo
           (empresa_id, sucursal_id, tipo_consumo, subcategoria_id, proveedor_id, fecha,
            consumo, unidad, costo, estado, origen, archivo_id)
         SELECT $1, $2, $3, $4, $5,
                (date_trunc('month', ($6 || '-01')::date) + interval '1 month - 1 day')::date,
                $7,
                COALESCE($8::unidad_medida,
                         (SELECT unidad_default FROM subcategoria WHERE id = $4),
                         (SELECT unidad_default FROM tipo_consumo WHERE id = $3)),
                $9, 'activa', 'foto', f.archivo_id
           FROM foto f WHERE f.empresa_id = $1 AND f.id = $10
         RETURNING id`,
        [
          emp, sucId, f.tipo, p.subcat || null,
          p.proveedor ? await idProveedor(cli, p.proveedor, f.tipo) : null,
          f.periodo,
          p.consumo === "" || p.consumo == null ? null : p.consumo,
          unidadBase(p.unidad),
          p.costo === "" || p.costo == null ? null : p.costo,
          fotoId,
        ],
      );
      registroId = rows[0]?.id || null;
    }

    const { rows: fot } = await cli.query(
      `UPDATE foto
          SET status = 'procesado', completada_at = $3, subcategoria_id = $4,
              consumo = $5, unidad = COALESCE($6::unidad_medida, unidad), costo = $7,
              notas = $8, registro_id = $9, sucursal_id = COALESCE($10, sucursal_id),
              tipo_consumo = COALESCE($11, tipo_consumo), periodo = COALESCE($12, periodo)
        WHERE empresa_id = $1 AND id = $2
        RETURNING (SELECT drive_file_id FROM archivo_drive WHERE id = foto.archivo_id) AS file_id`,
      [
        emp, fotoId, completedAt, p.subcat || null,
        p.consumo === "" || p.consumo == null ? null : p.consumo,
        unidadBase(p.unidad),
        p.costo === "" || p.costo == null ? null : p.costo,
        p.notas || null, registroId, sucId, f.tipo || null, f.periodo || null,
      ],
    );
    if (!fot.length) throw new Error(`No se encontró la foto ${fotoId}.`);
    return { registroEscrito: Boolean(registroId), fileId: fot[0].file_id };
  });

  // Mover el archivo va DESPUÉS y fuera de la transacción: Drive no participa
  // de ella, y si falla el movimiento los datos ya quedaron bien guardados.
  const folders = await readDriveFolders();
  const real = fileId && !String(fileId).startsWith("link:") ? fileId : null;
  if (real && folders.fotosProcesados) {
    await moveInDrive(real, folders.fotosPorCompletar, folders.fotosProcesados);
  }
  return { registroEscrito };
}

// =====================================================================
// 6. Config: destinatarios del aviso y carpetas de Drive
// =====================================================================

export async function writeFotoNotifEmails(emails) {
  const limpios = [
    ...new Set(
      (emails || [])
        .map((e) => String(e || "").trim())
        .filter((e) => e && e.includes("@")),
    ),
  ];
  return enTransaccion(async (cli, emp) => {
    await cli.query("DELETE FROM foto_notif_email WHERE empresa_id = $1", [emp]);
    for (const email of limpios) {
      await cli.query(
        "INSERT INTO foto_notif_email (empresa_id, email) VALUES ($1, $2)",
        [emp, email],
      );
    }
    return limpios.length;
  });
}

/** El almacén clave/valor de la hoja `Config`, ahora tabla. */
export async function getConfigValue(key) {
  if (!key) return null;
  const rows = await consultar(
    "SELECT valor FROM app_config WHERE empresa_id = $1 AND clave = $2",
    [key],
  );
  return rows[0] ? rows[0].valor : null;
}

export async function setConfigValue(key, value) {
  if (!key) throw new Error("Falta la clave de config");
  return enTransaccion(async (cli, emp) => {
    await cli.query(
      `INSERT INTO app_config (empresa_id, clave, valor) VALUES ($1, $2, $3)
       ON CONFLICT (empresa_id, clave) DO UPDATE SET valor = EXCLUDED.valor`,
      [emp, key, JSON.stringify(value ?? null)],
    );
  });
}
