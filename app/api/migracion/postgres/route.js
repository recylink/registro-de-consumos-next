import { NextResponse } from "next/server";
import { EMPRESA } from "@/lib/instance";
import { readSucursales } from "@/lib/sheets/sucursales";
import { readRecords } from "@/lib/sheets/records";
import { readMedidores } from "@/lib/sheets/medidores";
import { readEmissions } from "@/lib/sheets/emissions";
import { readFotos } from "@/lib/sheets/fotos";
import { readFotoNotifEmails } from "@/lib/sheets/config-store";
import { getDriveFolders } from "@/lib/drive-folders";
import { toNumber } from "@/lib/domain/parse";
import {
  FUEL_SUBCATS_CATALOG,
  INITIAL_SUBCATS,
  PROVIDERS,
  TYPES,
} from "@/lib/domain/catalog";
import { EMISSION_FACTOR_CATALOG, REFRIGERANTES_CATALOG } from "@/lib/domain/emisiones";

// Volcado de la planilla a PostgreSQL, según ESQUEMA-POSTGRES.sql.
//
//   curl -s localhost:3000/api/migracion/postgres > carga.sql
//   psql "$DATABASE_URL" -f ESQUEMA-POSTGRES.sql
//   psql "$DATABASE_URL" -1 -f carga.sql
//   curl -s 'localhost:3000/api/migracion/postgres?informe=si' | jq   # solo el resumen
//
// NO ESCRIBE NADA, ni en la planilla ni en la base: emite texto. La decisión de
// aplicarlo es del que corre `psql`, y el archivo se puede leer antes.
//
// POR QUÉ UN VOLCADO Y NO UN INSERT DIRECTO
//
// Escribir a Postgres desde acá exige un driver (`pg`) y credenciales de base en
// el entorno del deploy, para una operación que se corre una vez. El volcado
// evita las dos cosas y además deja un artefacto revisable: se puede hacer diff,
// grep y correr en una base de prueba antes de la definitiva.
//
// El archivo va envuelto en BEGIN/COMMIT, así que o entra todo o no entra nada.
// Con `-1` psql aborta al primer error y deja la base intacta.
//
// LO QUE ESTA MIGRACIÓN ARREGLA AL PASAR
//
// - Las tablas que referenciaban la sucursal por NOMBRE (registros, medidores,
//   precios, fotos) pasan a FK por id. La resolución nombre → id se hace acá, y
//   lo que no calza sale listado en `sucursalesSinResolver` en vez de entrar mal.
// - Las subcategorías vuelven a ser ids: `readRecords` ya las devuelve así
//   (deshace las etiquetas con emoji), y las que no estén en el catálogo se
//   emiten como filas `otro:<slug>` de `subcategoria`.
// - Los adjuntos de una lectura pasan de tres tríos de columnas a filas de
//   `lectura_adjunto`.
//
// LO QUE NO SE PUEDE RECUPERAR, Y POR QUÉ SE DICE EN VEZ DE INVENTARSE
//
// - Autoría: ninguna fila de la planilla dice quién la escribió. `creado_por`
//   queda NULL en todo.
// - `toNumber` ya colapsó los ilegibles en 0 antes de que este código los vea,
//   así que un 0 migrado puede haber sido "s/i". No es recuperable desde acá:
//   se distingue mirando la planilla con /api/migracion/lectura-cruda.
// - El registro que produjo cada foto: la hoja `Fotos` no lo guarda, así que
//   `foto.registro_id` queda NULL incluso en las procesadas. El CHECK del
//   esquema exige registro para `status='procesado'`, por eso las procesadas se
//   migran con `status='pendiente'` y `completada_at` puesto — y se cuentan
//   aparte en el informe, porque es una mentira controlada que hay que revisar.

// SOLO EN DESARROLLO, como el resto de /api/migracion/: la respuesta es un
// volcado completo de los datos de la planilla, y eso no tiene por qué estar
// disponible en el deploy.

export const dynamic = "force-dynamic";

// ----- Utilidades de SQL ---------------------------------------------------

/** Literal de texto, o NULL. Duplica la comilla simple, el único escape que hace falta. */
function q(v) {
  if (v == null || v === "") return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Literal numérico, o NULL. `""` y lo no finito son NULL, no 0. */
function n(v) {
  if (v == null || v === "") return "NULL";
  const num = typeof v === "number" ? v : toNumber(v);
  return Number.isFinite(num) ? String(num) : "NULL";
}

const bool = (v) => (v ? "true" : "false");

/** Enum: el valor tiene que estar en la lista o va NULL. Nada de inventar variantes. */
function enumOf(v, permitidos) {
  const s = String(v ?? "").trim();
  return permitidos.includes(s) ? `'${s}'` : "NULL";
}

const TIPOS = ["electricidad", "combustible", "agua", "refrigerantes"];
const UNIDADES = ["kWh", "L", "gal", "m3", "kg", "t"];
const SUPERINDICE_3 = String.fromCharCode(0x00b3);

/** 'm³' del dominio → 'm3' del enum unidad_medida. */
function unidad(v) {
  const s = String(v ?? "")
    .trim()
    .split(SUPERINDICE_3)
    .join("3");
  return enumOf(s, UNIDADES);
}

/**
 * Nombre → slug. Los diacríticos se quitan filtrando los combining marks
 * (U+0300–U+036F) en vez de con una clase de caracteres, que en un archivo
 * fuente es invisible y se corrompe al reencodear.
 */
function slug(s) {
  const sinTildes = String(s || "")
    .normalize("NFD")
    .split("")
    .filter((ch) => {
      const c = ch.codePointAt(0);
      return c < 0x300 || c > 0x36f;
    })
    .join("");
  return sinTildes
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Subselects: el volcado no fija uuids, los resuelve por clave natural. Así el
// archivo se puede leer y no depende de ningún id generado acá.
const EMP = `(SELECT id FROM empresa WHERE codigo = ${q(EMPRESA)})`;
const suc = (nombre) =>
  `(SELECT id FROM sucursal WHERE empresa_id = ${EMP} AND nombre = ${q(nombre)})`;
// Los subselects por clave heredada van acotados por empresa: `legacy_id` y
// `drive_file_id` son únicos POR empresa, no globales, porque en RECYLINK
// conviven los datos de todos los clientes en la misma base.
const sucPorLegacy = (legacyId) =>
  `(SELECT id FROM sucursal WHERE empresa_id = ${EMP} AND legacy_id = ${q(legacyId)})`;
const arch = (fileId) =>
  `(SELECT id FROM archivo_drive WHERE empresa_id = ${EMP} AND drive_file_id = ${q(fileId)})`;
const prov = (tipo, nombre) =>
  nombre
    ? `(SELECT id FROM proveedor WHERE tipo_consumo = '${tipo}' AND slug = ${q(slug(nombre))})`
    : "NULL";

const ES_PERIODO = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function GET(req) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "solo disponible en desarrollo" }, { status: 404 });
  }
  const soloInforme = new URL(req.url).searchParams.get("informe") === "si";

  const [sucursales, records, medidores, emissions, fotos, notifEmails, folders] =
    await Promise.all([
      readSucursales(),
      readRecords(),
      readMedidores(),
      readEmissions(),
      readFotos(),
      readFotoNotifEmails(),
      getDriveFolders().catch(() => ({})),
    ]);

  const avisos = [];
  const sucursalesSinResolver = new Set();
  // Duplicados de la planilla que el esquema no acepta. Una hoja no tiene
  // UNIQUE, así que existen; si se emitieran, el primer choque aborta la
  // transacción entera y no migra nada. Se omiten y se listan.
  const duplicados = { medidores: [], registros: [], fotos: [] };
  const vistos = { medidores: new Set(), registros: new Set(), fotos: new Set() };
  const out = [];
  const w = (linea) => out.push(linea);
  const seccion = (titulo) => w(`\n-- ${"-".repeat(68)}\n-- ${titulo}\n-- ${"-".repeat(68)}\n`);

  // Nombres de sucursal que existen en `Config Sucursales`. Todo lo que las
  // hojas de datos referencien y no esté acá es una fila huérfana: la planilla
  // no tiene FK, así que existen.
  const nombresValidos = new Set(sucursales.map((s) => s.nombre).filter(Boolean));
  function refSucursal(nombre, donde) {
    if (!nombre || !nombresValidos.has(nombre)) {
      sucursalesSinResolver.add(`${nombre || "(vacio)"} - ${donde}`);
      return null;
    }
    return suc(nombre);
  }

  // Archivos de Drive: una sola fila por archivo, aunque lo referencien varias.
  // La planilla a veces trae el link sin el File ID (las hojas de registro solo
  // guardan el link), y `drive_file_id` es NOT NULL UNIQUE: en ese caso la clave
  // sintética es 'link:<url>'.
  const archivos = new Map(); // driveFileId -> { url, nombre }
  function archivo(fileId, url, nombre) {
    const id = fileId || (url ? `link:${url}` : "");
    if (!id) return null;
    if (!archivos.has(id)) archivos.set(id, { url: url || "", nombre: nombre || "" });
    return arch(id);
  }

  // Subcategorías: el catálogo, más las que aparezcan en los datos y no estén.
  const subcats = new Map(); // id -> { tipo, label, origen, unidadDefault, units }
  for (const [id, cat] of Object.entries(FUEL_SUBCATS_CATALOG)) {
    subcats.set(id, {
      tipo: "combustible",
      label: cat.label,
      origen: "predef",
      unidadDefault: cat.defaultUnit,
      units: cat.units,
    });
  }
  for (const [tipo, lista] of Object.entries(INITIAL_SUBCATS)) {
    for (const sc of lista) {
      if (subcats.has(sc.id)) continue;
      subcats.set(sc.id, {
        tipo,
        label: sc.label,
        origen: sc.source === "custom" ? "custom" : "predef",
        unidadDefault: TYPES[tipo] ? TYPES[tipo].unit : "L",
        units: null,
      });
    }
  }
  function subcat(tipo, id, label) {
    if (!id) return "NULL";
    if (!subcats.has(id)) {
      subcats.set(id, {
        tipo,
        label: label || String(id).replace(/^otro:/, ""),
        origen: "custom",
        unidadDefault: TYPES[tipo] ? TYPES[tipo].unit : "L",
        units: null,
      });
    }
    return q(id);
  }

  // Proveedores: el catálogo, más los nombres que aparezcan escritos en datos.
  const proveedores = new Map(); // `${tipo}|${slug}` -> { tipo, slug, nombre }
  function proveedor(tipo, nombre) {
    if (!nombre || !TIPOS.includes(tipo)) return "NULL";
    // Un nombre sin ningún alfanumérico ("-", "s/i") no da slug, y emitir
    // `slug = NULL` sería un subselect que nunca calza: peor que un NULL, porque
    // parece una referencia.
    const s = slug(nombre);
    if (!s) {
      avisos.push(`proveedor "${nombre}" (${tipo}) no da slug: la fila queda sin proveedor`);
      return "NULL";
    }
    const clave = `${tipo}|${s}`;
    if (!proveedores.has(clave)) proveedores.set(clave, { tipo, slug: s, nombre });
    return prov(tipo, nombre);
  }
  for (const [tipo, lista] of Object.entries(PROVIDERS)) {
    for (const nombre of lista) proveedor(tipo, nombre);
  }

  // Los INSERT de datos se acumulan acá y se emiten DESPUÉS de los catálogos:
  // recorrer los datos es lo que descubre subcategorías, proveedores y archivos
  // que no estaban en el catálogo, y esas filas tienen que existir antes por FK.
  const cuerpo = [];
  const c = (linea) => cuerpo.push(linea);

  // ----- Sucursales y su configuración -----
  c(`\n-- sucursal: ${sucursales.length} filas`);
  for (const s of sucursales) {
    if (!s.nombre) {
      avisos.push(`sucursal ${s.id} sin nombre: se omite`);
      continue;
    }
    c(
      `INSERT INTO sucursal (empresa_id, nombre, direccion, activa, legacy_id) VALUES (` +
        `${EMP}, ${q(s.nombre)}, ${q(s.direccion)}, ${bool(s.activa)}, ${q(s.id)});`,
    );
  }

  let nSubcatFilas = 0;
  c(`\n-- sucursal_subcategoria`);
  for (const s of sucursales) {
    if (!s.nombre) continue;
    for (const tipo of TIPOS) {
      const item = s.items && s.items[tipo];
      if (!item || !item.activo) continue;
      for (const sc of item.subcats || []) {
        // En `Config Sucursales` el id de subcategoría del dominio está en
        // `tipo` (o en `tipoCustom` si la escribió una persona); `sc.id` es el
        // id de la fila, que se conserva como legacy_id.
        const scId = sc.tipo || (sc.tipoCustom ? `otro:${slug(sc.tipoCustom)}` : "");
        const nombreProv = sc.proveedor === "otro" ? sc.proveedorCustom : sc.proveedor;
        nSubcatFilas++;
        c(
          `INSERT INTO sucursal_subcategoria (empresa_id, sucursal_id, tipo_consumo, subcategoria_id, proveedor_id, unidad, num_cliente, sistema_electrico, uso, activa, legacy_id) VALUES (` +
            `${EMP}, ${suc(s.nombre)}, '${tipo}', ${scId ? subcat(tipo, scId, sc.tipoCustom) : "NULL"}, ` +
            `${proveedor(tipo, nombreProv)}, ${unidad(sc.unidad)}, ${q(sc.numCliente)}, ` +
            `${q(sc.sistemaElectrico)}, ${q(sc.uso)}, true, ${q(sc.id)});`,
        );
      }
    }
  }

  // ----- Registros de consumo -----
  let nRegistros = 0;
  const registrosOmitidos = [];
  c(`\n-- registro_consumo`);
  for (const r of records) {
    const refSuc = refSucursal(r.sucursal, `${r.type} ${r.id}`);
    if (!refSuc) continue;
    if (!r.date) {
      registrosOmitidos.push(`${r.id}: sin fecha legible`);
      continue;
    }
    const u = unidad(r.unit);
    if (u === "NULL") {
      registrosOmitidos.push(`${r.id}: unidad "${r.unit}" fuera del enum`);
      continue;
    }
    // `registro_consumo.legacy_id` es UNIQUE: dos filas con el mismo ID en la
    // planilla son un duplicado real, y hoy nada lo impide.
    if (vistos.registros.has(r.id)) {
      duplicados.registros.push(r.id);
      continue;
    }
    vistos.registros.add(r.id);
    nRegistros++;
    const refArch = r._driveLink ? archivo("", r._driveLink, "") : null;
    c(
      `INSERT INTO registro_consumo (empresa_id, sucursal_id, tipo_consumo, subcategoria_id, proveedor_id, num_cliente, fecha, consumo, unidad, costo, estado, origen, archivo_id, legacy_id) VALUES (` +
        `${EMP}, ${refSuc}, '${r.type}', ${subcat(r.type, r.subcat)}, ` +
        `${proveedor(r.type, r.provider)}, ${q(r.numeroCliente)}, ${q(r.date)}, ` +
        `${n(r.cantidad)}, ${u}, ${n(r.costo)}, ` +
        `${enumOf(r.estado, ["activa", "eliminada"])}, ` +
        `${enumOf(r.origen, ["manual", "documento", "foto", "sheets"])}, ` +
        `${refArch || "NULL"}, ${q(r.id)});`,
    );
  }

  // ----- Medidores, lecturas, adjuntos, precios -----
  // Los medidores que efectivamente entran. Lo que se salte acá arrastra sus
  // lecturas: sin la fila del medidor, el subselect de `medidor_id` daría NULL
  // y la lectura reventaría el NOT NULL.
  const medidoresEmitidos = new Set();
  c(`\n-- medidor: ${medidores.meters.length} filas`);
  for (const m of medidores.meters) {
    const refSuc = refSucursal(m.sucursal, `medidor ${m.id}`);
    if (!refSuc) continue;
    // UNIQUE (sucursal_id, tipo_consumo, numero): dos medidores del mismo tipo
    // con el mismo número en una sucursal no pueden coexistir. Los sin número
    // no chocan (en Postgres dos NULL son distintos).
    if (m.numero) {
      const clave = `${m.sucursal}|${m.type}|${m.numero}`;
      if (vistos.medidores.has(clave)) {
        duplicados.medidores.push(`${m.id} (${clave})`);
        continue;
      }
      vistos.medidores.add(clave);
    }
    medidoresEmitidos.add(m.id);
    c(
      `INSERT INTO medidor (empresa_id, sucursal_id, tipo_consumo, nombre, numero, activo, facturable, legacy_id) VALUES (` +
        `${EMP}, ${refSuc}, ${enumOf(m.type, TIPOS)}, ${q(m.nombre || m.id)}, ${q(m.numero)}, ` +
        `${bool(m.activo)}, ${bool(m.facturable)}, ${q(m.id)});`,
    );
  }

  const med = (legacyId) =>
    `(SELECT id FROM medidor WHERE empresa_id = ${EMP} AND legacy_id = ${q(legacyId)})`;
  const lect = (meterId, periodo) =>
    `(SELECT lm.id FROM lectura_medidor lm JOIN medidor m ON m.id = lm.medidor_id` +
    ` WHERE m.empresa_id = ${EMP} AND m.legacy_id = ${q(meterId)}` +
    ` AND lm.periodo = ${q(periodo)})`;

  // Una fila de `Lecturas Medidor` puede traer solo adjuntos, solo lectura, o
  // las dos cosas, y la app las parte en `readings` y `docs`. Acá se vuelven a
  // juntar: la fila de `lectura_medidor` tiene que existir para que sus
  // adjuntos la puedan referenciar.
  const clavesLectura = new Map(); // `${meterId}__${periodo}` -> { meterId, periodo, lectura }
  for (const r of medidores.readings) {
    clavesLectura.set(`${r.meterId}__${r.month}`, {
      meterId: r.meterId,
      periodo: r.month,
      lectura: r.lectura,
    });
  }
  for (const clave of Object.keys(medidores.docs || {})) {
    if (clavesLectura.has(clave)) continue;
    const [meterId, periodo] = clave.split("__");
    clavesLectura.set(clave, { meterId, periodo, lectura: null });
  }

  const lecturasHuerfanas = [];
  c(`\n-- lectura_medidor: ${clavesLectura.size} filas`);
  for (const l of clavesLectura.values()) {
    if (!medidoresEmitidos.has(l.meterId)) {
      lecturasHuerfanas.push(`${l.meterId} ${l.periodo}`);
      continue;
    }
    if (!ES_PERIODO.test(l.periodo || "")) {
      avisos.push(`lectura de ${l.meterId} con periodo "${l.periodo}": se omite`);
      continue;
    }
    c(
      `INSERT INTO lectura_medidor (empresa_id, medidor_id, periodo, lectura) VALUES (` +
        `${EMP}, ${med(l.meterId)}, ${q(l.periodo)}, ${n(l.lectura)});`,
    );
  }

  let nAdjuntos = 0;
  c(`\n-- lectura_adjunto`);
  for (const [clave, docs] of Object.entries(medidores.docs || {})) {
    const [meterId, periodo] = clave.split("__");
    if (!medidoresEmitidos.has(meterId) || !ES_PERIODO.test(periodo || "")) continue;
    for (const rol of ["factura", "pago", "respaldo"]) {
      const d = docs[rol];
      if (!d || !d.link) continue;
      const refArch = archivo(d.fileId, d.link, d.name);
      if (!refArch) continue;
      nAdjuntos++;
      c(
        `INSERT INTO lectura_adjunto (empresa_id, lectura_medidor_id, rol, archivo_id) VALUES (` +
          `${EMP}, ${lect(meterId, periodo)}, '${rol}', ${refArch});`,
      );
    }
  }

  c(`\n-- precio_periodo: ${medidores.prices.length} filas`);
  for (const p of medidores.prices) {
    const refSuc = refSucursal(p.sucursal, `precio ${p.type} ${p.month}`);
    if (!refSuc) continue;
    const tipo = enumOf(p.type, TIPOS);
    if (tipo === "NULL" || !ES_PERIODO.test(p.month || "")) {
      avisos.push(`precio de ${p.sucursal} (${p.type} ${p.month}): tipo o periodo invalido, se omite`);
      continue;
    }
    c(
      `INSERT INTO precio_periodo (empresa_id, sucursal_id, tipo_consumo, periodo, precio) VALUES (` +
        `${EMP}, ${refSuc}, ${tipo}, ${q(p.month)}, ${n(p.precio)});`,
    );
  }

  // ----- Emisiones: la hoja con la columna `Scope` se parte en cinco tablas ---
  const em = emissions || {
    factoresEmpresa: {},
    factoresSucursal: {},
    refrigerantesSucursal: {},
    metas: { empresa: {}, sucursales: {} },
  };
  if (!emissions) avisos.push("la hoja Emisiones no tiene filas: no se migra nada de emisiones");

  c(`\n-- factor_emision_empresa`);
  for (const [key, v] of Object.entries(em.factoresEmpresa || {})) {
    if (!EMISSION_FACTOR_CATALOG[key]) {
      avisos.push(`factor de empresa "${key}" fuera del catalogo: se omite`);
      continue;
    }
    c(
      `INSERT INTO factor_emision_empresa (empresa_id, factor_emision_id, valor) VALUES (` +
        `${EMP}, ${q(key)}, ${n(v.value)});`,
    );
  }

  c(`\n-- factor_emision_sucursal (overrides de la empresa)`);
  for (const [sucId, factores] of Object.entries(em.factoresSucursal || {})) {
    for (const [key, v] of Object.entries(factores || {})) {
      if (!EMISSION_FACTOR_CATALOG[key]) {
        avisos.push(`factor de sucursal "${key}" fuera del catalogo: se omite`);
        continue;
      }
      c(
        `INSERT INTO factor_emision_sucursal (empresa_id, sucursal_id, factor_emision_id, valor, pending_review) VALUES (` +
          `${EMP}, ${sucPorLegacy(sucId)}, ${q(key)}, ${n(v.value)}, ${bool(v.pendingReview)});`,
      );
    }
  }

  const gasesValidos = new Set(REFRIGERANTES_CATALOG.map((g) => g.id));
  c(`\n-- refrigerante_carga`);
  for (const [sucId, cargas] of Object.entries(em.refrigerantesSucursal || {})) {
    for (const rf of cargas || []) {
      if (!gasesValidos.has(rf.tipo)) {
        avisos.push(`carga de refrigerante con gas "${rf.tipo}" fuera del catalogo: se omite`);
        continue;
      }
      if (!ES_PERIODO.test(rf.mes || "")) {
        avisos.push(`carga de ${rf.tipo} en ${sucId} con mes "${rf.mes}": se omite`);
        continue;
      }
      c(
        `INSERT INTO refrigerante_carga (empresa_id, sucursal_id, refrigerante_gas_id, periodo, carga_kg) VALUES (` +
          `${EMP}, ${sucPorLegacy(sucId)}, ${q(rf.tipo)}, ${q(rf.mes)}, ${n(rf.cargaKg)});`,
      );
    }
  }

  // META_FIELDS deja de ser key/value y pasa a cinco columnas.
  const metaCols = "absoluta, relativa, anio_base, base_emissions, base_mode";
  function metaValores(m) {
    const v = (k) => (m && m[k] != null && m[k] !== "" ? m[k] : null);
    return [
      n(v("absoluta")),
      n(v("relativa")),
      n(v("anioBase")),
      n(v("baseEmissions")),
      enumOf(v("baseMode"), ["manual", "auto"]),
    ].join(", ");
  }

  if (em.metas && Object.keys(em.metas.empresa || {}).length) {
    c(`\n-- meta_empresa`);
    c(
      `INSERT INTO meta_empresa (empresa_id, ${metaCols}) VALUES (` +
        `${EMP}, ${metaValores(em.metas.empresa)});`,
    );
  }
  const metasSuc = Object.entries((em.metas && em.metas.sucursales) || {});
  if (metasSuc.length) {
    c(`\n-- meta_sucursal`);
    for (const [sucId, m] of metasSuc) {
      c(
        `INSERT INTO meta_sucursal (sucursal_id, empresa_id, ${metaCols}) VALUES (` +
          `${sucPorLegacy(sucId)}, ${EMP}, ${metaValores(m)});`,
      );
    }
  }

  // ----- Fotos -----
  let nFotosProcesadas = 0;
  c(`\n-- foto: ${fotos.length} filas`);
  for (const f of fotos) {
    if (!f.fileId && !f.link) {
      avisos.push(`foto de la fila ${f.rowIndex} sin File ID ni link: se omite`);
      continue;
    }
    // `foto.archivo_id` es UNIQUE: el mismo archivo no puede estar en dos filas
    // de la cola. La planilla lo permite (subir dos veces la misma foto).
    const claveArch = f.fileId || `link:${f.link}`;
    if (vistos.fotos.has(claveArch)) {
      duplicados.fotos.push(`fila ${f.rowIndex} (${claveArch})`);
      continue;
    }
    vistos.fotos.add(claveArch);
    const refArch = archivo(f.fileId, f.link, "");
    if (f.status === "procesado") nFotosProcesadas++;
    const tipoId = TIPOS.includes(String(f.tipo || "").trim()) ? String(f.tipo).trim() : null;
    // La columna Sucursal de `Fotos` es texto libre: puede no existir.
    let refSuc = "NULL";
    if (f.sucursal && nombresValidos.has(f.sucursal)) refSuc = suc(f.sucursal);
    else if (f.sucursal) sucursalesSinResolver.add(`${f.sucursal} - foto fila ${f.rowIndex}`);
    c(
      `INSERT INTO foto (empresa_id, archivo_id, sucursal_id, tipo_consumo, subcategoria_id, periodo, status, consumo, unidad, costo, proveedor_id, notas, registro_id, subida_at, completada_at) VALUES (` +
        `${EMP}, ${refArch}, ${refSuc}, ${tipoId ? `'${tipoId}'` : "NULL"}, ` +
        `${tipoId && f.subcat ? subcat(tipoId, f.subcat) : "NULL"}, ` +
        `${ES_PERIODO.test(f.periodo || "") ? q(f.periodo) : "NULL"}, ` +
        // Sin registro_id no se puede declarar 'procesado': lo impide el CHECK
        // del esquema, y la hoja no guarda ese id.
        `'pendiente', ${n(f.consumo)}, ${unidad(f.unidad)}, ${n(f.costo)}, ` +
        `${tipoId ? proveedor(tipoId, f.proveedor) : "NULL"}, ${q(f.notas)}, NULL, ` +
        `${f.fechaSubida ? `${q(f.fechaSubida)}::timestamptz` : "now()"}, ` +
        `${f.fechaCompletado ? `${q(f.fechaCompletado)}::timestamptz` : "NULL"});`,
    );
  }

  if ((notifEmails || []).length) {
    c(`\n-- foto_notif_email`);
    for (const email of notifEmails) {
      c(`INSERT INTO foto_notif_email (empresa_id, email) VALUES (${EMP}, ${q(email)});`);
    }
  }

  // ----- Carpetas de Drive: el objeto `driveFolders` de la hoja `Config` -----
  c(`\n-- drive_carpeta`);
  const SIMPLES = {
    fotosPorCompletar: "fotos_por_completar",
    fotosProcesados: "fotos_procesados",
    manualFacturas: "manual_facturas",
    uploadFacturas: "upload_facturas",
    medidorFacturas: "medidor_facturas",
    medidorPagos: "medidor_pagos",
  };
  for (const [clave, rol] of Object.entries(SIMPLES)) {
    const id = folders && folders[clave];
    if (!id) continue;
    c(`INSERT INTO drive_carpeta (empresa_id, rol, folder_id) VALUES (${EMP}, '${rol}', ${q(id)});`);
  }
  for (const [tipo, id] of Object.entries((folders && folders.medidorRespaldos) || {})) {
    if (!id || !TIPOS.includes(tipo)) continue;
    c(
      `INSERT INTO drive_carpeta (empresa_id, rol, tipo_consumo, folder_id) VALUES (` +
        `${EMP}, 'medidor_respaldos', '${tipo}', ${q(id)});`,
    );
  }
  // Las carpetas de proveedor están indexadas por providerId, que no dice de
  // qué tipo de consumo es. Se resuelven contra los proveedores ya descubiertos;
  // lo que no calce queda fuera y se avisa.
  const porSlug = new Map();
  for (const p of proveedores.values()) porSlug.set(p.slug, p);
  for (const [providerId, carpetas] of Object.entries((folders && folders.proveedores) || {})) {
    const clave = slug(providerId);
    // Los providerId de `driveFolders` están abreviados a mano ("iconstruye-pet"
    // por "Iconstruye Petróleo"), así que el calce exacto no alcanza: se prueba
    // por prefijo, y solo si es inequívoco.
    let p = porSlug.get(clave);
    if (!p) {
      const candidatos = [...porSlug.keys()].filter((s) => s.startsWith(clave));
      if (candidatos.length === 1) p = porSlug.get(candidatos[0]);
      else if (candidatos.length > 1) {
        avisos.push(`providerId "${providerId}" calza con ${candidatos.length} proveedores: se omite`);
      }
    }
    if (!p) {
      avisos.push(`carpetas del proveedor "${providerId}" sin proveedor conocido: se omiten`);
      continue;
    }
    for (const [campo, rol] of [
      ["porProcesar", "proveedor_por_procesar"],
      ["procesados", "proveedor_procesados"],
    ]) {
      const id = carpetas && carpetas[campo];
      if (!id) continue;
      c(
        `INSERT INTO drive_carpeta (empresa_id, rol, proveedor_id, folder_id) VALUES (` +
          `${EMP}, '${rol}', ${prov(p.tipo, p.nombre)}, ${q(id)});`,
      );
    }
  }

  // ----- Armado final: encabezado, catálogos, cuerpo -----

  w(`-- Carga de datos: planilla de "${EMPRESA}" -> PostgreSQL`);
  w(`-- Generado por /api/migracion/postgres. Correr DESPUES de ESQUEMA-POSTGRES.sql:`);
  w(`--   psql "$DATABASE_URL" -1 -f este-archivo.sql`);
  w(`--`);
  w(`-- Sucursales: ${sucursales.length} · registros: ${nRegistros} de ${records.length} leidos`);
  w(`-- Medidores: ${medidores.meters.length} · lecturas: ${clavesLectura.size} · adjuntos: ${nAdjuntos}`);
  w(`-- Precios: ${medidores.prices.length} · fotos: ${fotos.length} · archivos: ${archivos.size}`);
  if (avisos.length) w(`-- AVISOS: ${avisos.length}. Verlos con ?informe=si ANTES de aplicar.`);
  w(`\nBEGIN;\n`);

  seccion("Empresa (el tenant)");
  w(`-- ON CONFLICT porque en RECYLINK la base es una y los clientes muchos:`);
  w(`-- este volcado se corre una vez por instancia y todos caen en la misma`);
  w(`-- base. Si la empresa ya está, se reusa su fila.`);
  w(
    `INSERT INTO empresa (codigo, nombre) VALUES (${q(EMPRESA)}, ${q(EMPRESA)}) ` +
      `ON CONFLICT (codigo) DO NOTHING;`,
  );
  w(`-- Falta ligarla al cliente de RECYLINK, que este código no conoce:`);
  w(`--   UPDATE empresa SET recylink_tenant_id = '<uuid>' WHERE codigo = ${q(EMPRESA)};`);

  seccion("Catalogos (hoy en lib/domain/, aca filas)");
  for (const [id, s] of subcats) {
    w(
      `INSERT INTO subcategoria (id, tipo_consumo, label, origen, unidad_default) VALUES (` +
        `${q(id)}, '${s.tipo}', ${q(s.label)}, '${s.origen}', ${unidad(s.unidadDefault)});`,
    );
  }
  w("");
  for (const [id, s] of subcats) {
    const units = s.units && s.units.length ? s.units : [s.unidadDefault];
    for (const u of units) {
      const val = unidad(u);
      if (val === "NULL") continue;
      w(
        `INSERT INTO subcategoria_unidad (subcategoria_id, unidad) VALUES (${q(id)}, ${val}) ON CONFLICT DO NOTHING;`,
      );
    }
  }
  w("");
  for (const p of proveedores.values()) {
    w(
      `INSERT INTO proveedor (slug, nombre, tipo_consumo) VALUES (` +
        `${q(p.slug)}, ${q(p.nombre)}, '${p.tipo}');`,
    );
  }
  w("");
  for (const [id, f] of Object.entries(EMISSION_FACTOR_CATALOG)) {
    // La clave del factor de combustible es también el id de la subcategoría;
    // en electricidad y agua no hay subcategoría a la que apuntar.
    const scId = f.type === "combustible" && subcats.has(id) ? q(id) : "NULL";
    w(
      `INSERT INTO factor_emision (id, label, unidad, alcance, tipo_consumo, subcategoria_id, fuente) VALUES (` +
        `${q(id)}, ${q(f.label)}, ${q(f.unit)}, ${f.scope}, '${f.type}', ${scId}, ${q(f.fuente)});`,
    );
  }
  w("");
  for (const g of REFRIGERANTES_CATALOG) {
    w(
      `INSERT INTO refrigerante_gas (id, label, gwp_ar5) VALUES (${q(g.id)}, ${q(g.label)}, ${g.gwp});`,
    );
  }

  seccion("Archivos de Drive");
  w(`-- Los que solo tienen link llevan 'link:<url>' como drive_file_id: la`);
  w(`-- columna es NOT NULL UNIQUE y las hojas de registro no guardan el File ID.`);
  for (const [fileId, a] of archivos) {
    w(
      `INSERT INTO archivo_drive (empresa_id, drive_file_id, url, nombre) VALUES (` +
        `${EMP}, ${q(fileId)}, ${q(a.url)}, ${q(a.nombre)});`,
    );
  }

  seccion("Datos");
  for (const linea of cuerpo) w(linea);

  w(`\nCOMMIT;`);

  const informe = {
    modo: soloInforme ? "informe" : "volcado",
    escribe: false,
    conteos: {
      sucursales: sucursales.length,
      sucursalSubcategoria: nSubcatFilas,
      registrosLeidos: records.length,
      registros: nRegistros,
      medidores: medidores.meters.length,
      lecturas: clavesLectura.size,
      adjuntos: nAdjuntos,
      precios: medidores.prices.length,
      fotos: fotos.length,
      archivosDrive: archivos.size,
      subcategorias: subcats.size,
      proveedores: proveedores.size,
    },
    // Lo que hay que mirar antes de dar la migración por buena.
    sucursalesSinResolver: [...sucursalesSinResolver],
    registrosOmitidos,
    lecturasHuerfanas,
    // Filas que la planilla acepta y el esquema no. Se omiten para que la
    // transacción entre; cada una es una decisión pendiente.
    duplicados,
    fotosProcesadasSinRegistro: nFotosProcesadas,
    avisos,
    pendienteDeRevision: [
      "Cada entrada de sucursalesSinResolver es una fila que NO se migra: o se corrige el nombre en la planilla, o se acepta perderla.",
      `${nFotosProcesadas} fotos ya procesadas entran como 'pendiente': la hoja no guarda el ID del registro que produjeron.`,
      "creado_por / completada_por quedan NULL: la planilla no registra autoria.",
      "Un consumo 0 puede haber sido un valor ilegible (toNumber). Contrastar con /api/migracion/lectura-cruda.",
      "Los duplicados listados NO se migran: la planilla los acepta y el esquema no. Decidir cual queda antes de dar la carga por completa.",
    ],
  };

  if (soloInforme) return NextResponse.json(informe);

  return new NextResponse(out.join("\n") + "\n", {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": 'attachment; filename="carga-postgres.sql"',
      // Los conteos viajan en un header para no ensuciar el SQL: `curl -i` los muestra.
      "X-Migracion-Conteos": JSON.stringify(informe.conteos),
    },
  });
}
