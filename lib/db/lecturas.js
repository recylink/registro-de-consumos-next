import "server-only";
import { consultar, unidadDominio, num } from "./cliente";

// Las seis lecturas de la app, contra PostgreSQL, con las MISMAS firmas y las
// mismas formas que `lib/sheets/`. Ese es el punto: las pantallas y las Server
// Actions no cambian, solo cambia de dónde salen los datos.
//
// Tres reglas que se respetan en todo el archivo:
//
// 1. TODA consulta filtra por `empresa_id`. Hoy la app entra como `postgres`,
//    que se salta RLS, así que el aislamiento entre clientes lo pone este
//    archivo y nada más. Es exactamente el escenario que el esquema advierte:
//    "que UNA funcion lo ponga siempre". Aquí esa función es `empresaId()`, y
//    ninguna consulta se escribe sin ella.
// 2. Los ids que se devuelven son los uuid de la base, no los `Sucursal ID` ni
//    los `comb_...` de la planilla. La interfaz los trata como texto opaco.
//    Los de la planilla siguen guardados en `legacy_id`, para poder rastrear
//    una fila hasta su origen.
// 3. Las unidades se devuelven como las escribe el dominio (`m³`), no como las
//    guarda la base (`m3`). El dashboard agrupa por ese texto, así que la
//    diferencia no es cosmética.

// =====================================================================
// 1. Registros de consumo
// =====================================================================

/**
 * Las tres hojas de consumo eran una sola lista al leer; ahora son una sola
 * tabla, así que esto es un SELECT en vez de un aplanado.
 *
 * `_driveLink` se conserva porque el dashboard lo usa para el enlace a la
 * factura (components/views/dashboard-tabla.jsx). Los otros campos con guion
 * bajo de la version de planilla (`_sheetRow`, `_sheetName`, `_porPosicion`,
 * `_estadoCol`) NO se devuelven: eran la posicion de la fila, y aqui no
 * existe tal cosa. Se comprobó que ninguna pantalla los lee.
 */
export async function readRecords() {
  const rows = await consultar(`
    SELECT rc.id, rc.tipo_consumo, rc.subcategoria_id, rc.fecha, rc.consumo,
           rc.unidad, rc.costo, rc.estado, rc.origen, rc.num_cliente,
           s.nombre  AS sucursal,
           pv.nombre AS proveedor,
           ad.url    AS drive_link
      FROM registro_consumo rc
      JOIN sucursal s        ON s.id  = rc.sucursal_id
      LEFT JOIN proveedor pv ON pv.id = rc.proveedor_id
      LEFT JOIN archivo_drive ad ON ad.id = rc.archivo_id
     WHERE rc.empresa_id = $1
     ORDER BY rc.fecha, rc.created_at
  `);

  return rows.map((r) => {
    const rec = {
      id: r.id,
      date: r.fecha instanceof Date ? r.fecha.toISOString().slice(0, 10) : String(r.fecha),
      sucursal: r.sucursal || "",
      type: r.tipo_consumo,
      subcat: r.subcategoria_id || null,
      provider: r.proveedor || "",
      cantidad: num(r.consumo),
      unit: unidadDominio(r.unidad),
      costo: num(r.costo),
      origen: r.origen,
      estado: r.estado,
      _driveLink: r.drive_link || "",
    };
    // La version de planilla solo incluye este campo en electricidad y agua,
    // porque son las unicas hojas que tienen la columna.
    if (r.tipo_consumo === "electricidad" || r.tipo_consumo === "agua") {
      rec.numeroCliente = r.num_cliente || "";
    }
    return rec;
  });
}

// =====================================================================
// 2. Sucursales y su configuración
// =====================================================================

/** El molde vacío de `items`, igual que `emptyItems()` del dominio. */
const itemsVacios = () => ({
  electricidad: { activo: false, subcats: [] },
  combustible: { activo: false, subcats: [] },
  agua: { activo: false, subcats: [] },
  refrigerantes: { activo: false, subcats: [] },
});

export async function readSucursales() {
  const rows = await consultar(`
    SELECT s.id, s.nombre, s.direccion, s.activa,
           ss.id AS sub_id, ss.tipo_consumo, ss.subcategoria_id, ss.unidad,
           ss.num_cliente, ss.sistema_electrico, ss.uso,
           pv.nombre AS proveedor
      FROM sucursal s
      LEFT JOIN sucursal_subcategoria ss
             ON ss.sucursal_id = s.id AND ss.activa
      LEFT JOIN proveedor pv ON pv.id = ss.proveedor_id
     WHERE s.empresa_id = $1
     ORDER BY s.created_at, ss.created_at
  `);

  const porId = new Map();
  for (const r of rows) {
    if (!porId.has(r.id)) {
      porId.set(r.id, {
        id: r.id,
        nombre: r.nombre || "",
        direccion: r.direccion || "",
        activa: r.activa,
        items: itemsVacios(),
      });
    }
    if (!r.tipo_consumo) continue; // sucursal sin subcategorías
    const item = porId.get(r.id).items[r.tipo_consumo];
    if (!item) continue; // un tipo que la UI ya no configura (refrigerantes)
    item.activo = true;
    // Solo se agregan las claves que existen, igual que `unflatten`: la UI
    // distingue "no tiene proveedor" de "proveedor vacío".
    const sc = { id: r.sub_id };
    if (r.sistema_electrico) sc.sistemaElectrico = r.sistema_electrico;
    if (r.subcategoria_id) sc.tipo = r.subcategoria_id;
    if (r.uso) sc.uso = r.uso;
    if (r.unidad) sc.unidad = unidadDominio(r.unidad);
    if (r.proveedor) sc.proveedor = r.proveedor;
    if (r.num_cliente) sc.numCliente = r.num_cliente;
    item.subcats.push(sc);
  }
  return [...porId.values()];
}

// =====================================================================
// 3. Módulo Medidores
// =====================================================================

export async function readMedidores() {
  const [meters, lecturas, adjuntos, prices] = await Promise.all([
    consultar(`
      SELECT m.id, m.tipo_consumo, m.nombre, m.numero, m.activo, m.facturable,
             s.nombre AS sucursal
        FROM medidor m JOIN sucursal s ON s.id = m.sucursal_id
       WHERE m.empresa_id = $1
       ORDER BY m.created_at`),
    consultar(`
      SELECT id, medidor_id, periodo, lectura
        FROM lectura_medidor
       WHERE empresa_id = $1 AND lectura IS NOT NULL
       ORDER BY periodo`),
    consultar(`
      SELECT la.rol, lm.medidor_id, lm.periodo,
             ad.url AS link, ad.nombre, ad.drive_file_id
        FROM lectura_adjunto la
        JOIN lectura_medidor lm ON lm.id = la.lectura_medidor_id
        JOIN archivo_drive ad   ON ad.id = la.archivo_id
       WHERE la.empresa_id = $1`),
    consultar(`
      SELECT s.nombre AS sucursal, pp.tipo_consumo, pp.periodo, pp.precio
        FROM precio_periodo pp JOIN sucursal s ON s.id = pp.sucursal_id
       WHERE pp.empresa_id = $1
       ORDER BY pp.periodo`),
  ]);

  // Los adjuntos se indexan igual que en la planilla: `${medidor}__${mes}`.
  const docs = {};
  for (const a of adjuntos) {
    const clave = `${a.medidor_id}__${a.periodo}`;
    docs[clave] ||= {};
    docs[clave][a.rol] = {
      link: a.link || "",
      name: a.nombre || "",
      fileId: a.drive_file_id || "",
    };
  }

  return {
    meters: meters.map((m) => ({
      id: m.id,
      sucursal: m.sucursal || "",
      type: m.tipo_consumo,
      nombre: m.nombre || "",
      numero: m.numero == null ? "" : String(m.numero),
      activo: m.activo,
      facturable: m.facturable,
    })),
    readings: lecturas.map((l) => ({
      id: l.id,
      meterId: l.medidor_id,
      month: l.periodo,
      lectura: num(l.lectura),
    })),
    prices: prices.map((p) => ({
      sucursal: p.sucursal,
      type: p.tipo_consumo,
      month: p.periodo,
      precio: num(p.precio),
    })),
    docs,
  };
}

// =====================================================================
// 4. Emisiones
// =====================================================================

/**
 * La hoja `Emisiones` guardaba cinco cosas discriminadas por una columna
 * `Scope`; aquí son cuatro tablas más una consulta a `registro_consumo`.
 *
 * Los refrigerantes son el caso interesante: dejaron de tener tabla propia y
 * son filas de consumo con `tipo_consumo = 'refrigerantes'`. Esta función los
 * vuelve a presentar con la forma que la pantalla de Factores espera, así que
 * la homologación no obliga a tocar esa pantalla.
 */
export async function readEmissions() {
  const [fEmpresa, fSucursal, refrigerantes, mEmpresa, mSucursal] = await Promise.all([
    consultar(
      "SELECT factor_emision_id AS key, valor FROM factor_emision_empresa WHERE empresa_id = $1",
    ),
    consultar(`
      SELECT sucursal_id, factor_emision_id AS key, valor, pending_review
        FROM factor_emision_sucursal WHERE empresa_id = $1`),
    consultar(`
      SELECT id, sucursal_id, refrigerante_gas_id, consumo, periodo
        FROM registro_consumo
       WHERE empresa_id = $1 AND tipo_consumo = 'refrigerantes' AND estado = 'activa'
       ORDER BY periodo, created_at`),
    consultar(`
      SELECT absoluta, relativa, anio_base, base_emissions, base_mode
        FROM meta_empresa WHERE empresa_id = $1`),
    consultar(`
      SELECT sucursal_id, absoluta, relativa, anio_base, base_emissions, base_mode
        FROM meta_sucursal WHERE empresa_id = $1`),
  ]);

  const out = {
    factoresEmpresa: {},
    factoresSucursal: {},
    refrigerantesSucursal: {},
    metas: { empresa: {}, sucursales: {} },
  };

  for (const f of fEmpresa) out.factoresEmpresa[f.key] = { value: Number(f.valor) };

  for (const f of fSucursal) {
    out.factoresSucursal[f.sucursal_id] ||= {};
    out.factoresSucursal[f.sucursal_id][f.key] = {
      value: Number(f.valor),
      pendingReview: f.pending_review,
    };
  }

  for (const r of refrigerantes) {
    out.refrigerantesSucursal[r.sucursal_id] ||= [];
    out.refrigerantesSucursal[r.sucursal_id].push({
      // El `uid` inestable de la planilla pasa a ser la PK de la fila.
      uid: r.id,
      tipo: r.refrigerante_gas_id,
      cargaKg: num(r.consumo),
      mes: r.periodo,
    });
  }

  // META_FIELDS volvió a ser cinco columnas; la UI las quiere como clave/valor.
  const metaObjeto = (m) => {
    const o = {};
    if (m.absoluta != null) o.absoluta = Number(m.absoluta);
    if (m.relativa != null) o.relativa = Number(m.relativa);
    if (m.anio_base != null) o.anioBase = Number(m.anio_base);
    if (m.base_emissions != null) o.baseEmissions = Number(m.base_emissions);
    if (m.base_mode != null) o.baseMode = m.base_mode;
    return o;
  };
  if (mEmpresa.length) out.metas.empresa = metaObjeto(mEmpresa[0]);
  for (const m of mSucursal) out.metas.sucursales[m.sucursal_id] = metaObjeto(m);

  return out;
}

// =====================================================================
// 5. Fotos y 6. destinatarios del aviso
// =====================================================================

export async function readFotos() {
  const rows = await consultar(`
    SELECT f.id, f.periodo, f.status, f.consumo, f.unidad, f.costo, f.notas,
           f.subida_at, f.completada_at, f.tipo_consumo, f.subcategoria_id,
           s.nombre  AS sucursal,
           pv.nombre AS proveedor,
           ad.drive_file_id, ad.url
      FROM foto f
      JOIN archivo_drive ad  ON ad.id = f.archivo_id
      LEFT JOIN sucursal s   ON s.id  = f.sucursal_id
      LEFT JOIN proveedor pv ON pv.id = f.proveedor_id
     WHERE f.empresa_id = $1
     ORDER BY f.subida_at
  `);

  const iso = (v) => (v ? new Date(v).toISOString() : "");
  // Los campos numéricos viajan como TEXTO, igual que los daba el Sheet: la UI
  // los pone tal cual en un <input> y ahí un número y un "" se comportan
  // distinto. `rowIndex` no existe aquí —era la posición de la fila— y se
  // reemplaza por `id`, que es lo que la escritura va a usar.
  return rows.map((f) => ({
    id: f.id,
    fileId: f.drive_file_id || "",
    link: f.url || "",
    fechaSubida: iso(f.subida_at),
    tipo: f.tipo_consumo || "",
    sucursal: f.sucursal || "",
    subcat: f.subcategoria_id || "",
    periodo: f.periodo || "",
    status: String(f.status || "").toLowerCase(),
    fechaCompletado: iso(f.completada_at),
    consumo: f.consumo == null ? "" : String(f.consumo),
    unidad: unidadDominio(f.unidad),
    costo: f.costo == null ? "" : String(f.costo),
    proveedor: f.proveedor || "",
    notas: f.notas || "",
  }));
}

export async function readFotoNotifEmails() {
  const rows = await consultar(
    "SELECT email FROM foto_notif_email WHERE empresa_id = $1 ORDER BY email",
  );
  return rows.map((r) => r.email);
}

// =====================================================================
// 7. Carpetas de Drive
//
// En la planilla eran UN json en la clave `driveFolders` de la hoja `Config`;
// aquí son filas de `drive_carpeta`, una por rol. Esta función las vuelve a
// armar con la forma que espera `lib/drive-folders.js`, para que el resto de la
// app no note la diferencia.
// =====================================================================

const CLAVE_POR_ROL = {
  fotos_por_completar: "fotosPorCompletar",
  fotos_procesados: "fotosProcesados",
  manual_facturas: "manualFacturas",
  upload_facturas: "uploadFacturas",
  medidor_facturas: "medidorFacturas",
  medidor_pagos: "medidorPagos",
};

export async function readDriveFolders() {
  const rows = await consultar(`
    SELECT dc.rol, dc.tipo_consumo, dc.folder_id, pv.slug AS proveedor
      FROM drive_carpeta dc
      LEFT JOIN proveedor pv ON pv.id = dc.proveedor_id
     WHERE dc.empresa_id = $1
  `);

  const out = {
    fotosPorCompletar: "", fotosProcesados: "", manualFacturas: "", uploadFacturas: "",
    medidorFacturas: "", medidorPagos: "", medidorRespaldos: {}, proveedores: {},
  };

  for (const r of rows) {
    const simple = CLAVE_POR_ROL[r.rol];
    if (simple) {
      out[simple] = r.folder_id;
    } else if (r.rol === "medidor_respaldos" && r.tipo_consumo) {
      out.medidorRespaldos[r.tipo_consumo] = r.folder_id;
    } else if (r.proveedor) {
      out.proveedores[r.proveedor] ||= { porProcesar: "", procesados: "" };
      const campo = r.rol === "proveedor_por_procesar" ? "porProcesar" : "procesados";
      out.proveedores[r.proveedor][campo] = r.folder_id;
    }
  }
  return out;
}
