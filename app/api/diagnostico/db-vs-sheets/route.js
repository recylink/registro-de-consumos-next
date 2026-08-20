import { NextResponse } from "next/server";
import * as hoja from "@/lib/sheets/records";
import * as hojaSuc from "@/lib/sheets/sucursales";
import * as hojaMed from "@/lib/sheets/medidores";
import * as hojaEmi from "@/lib/sheets/emissions";
import * as hojaFoto from "@/lib/sheets/fotos";
import * as hojaCfg from "@/lib/sheets/config-store";
import * as bd from "@/lib/db/lecturas";

// Lee lo MISMO de la planilla y de PostgreSQL y exige que coincida.
//
//   curl -s http://localhost:3000/api/diagnostico/db-vs-sheets | jq
//
// Es la única prueba que sirve de que `lib/db/` es un reemplazo y no una
// reescritura con criterio propio: las pantallas no se enteran de dónde vienen
// los datos, así que la garantía tiene que ser que los datos son los mismos.
//
// Qué se ignora al comparar, y por qué:
//
// - Los **ids**. En la planilla son `comb_lz3k...` y `sc0`; en la base son uuid.
//   Son distintos a proposito, y ninguna pantalla depende de su forma.
// - Los campos de posicion de fila (`_sheetRow`, `_sheetName`, `_porPosicion`,
//   `_estadoCol`, `rowIndex`). Existen solo porque una planilla no tiene clave
//   primaria. En la base no significan nada.
//
// Todo lo demas se compara literal. Solo lectura: no escribe en ningun lado.

export const dynamic = "force-dynamic";

const SIN_ID = new Set([
  "id", "uid", "_sheetRow", "_sheetName", "_porPosicion", "_estadoCol", "rowIndex",
]);

/**
 * Copia sin los campos que son identidad o posición, a CUALQUIER profundidad.
 *
 * Recursiva y no de un nivel: la configuración de una sucursal lleva un `id` por
 * subcategoría, anidado dentro de `items`. La primera versión de esto solo
 * limpiaba el nivel de arriba y reportaba las sucursales como distintas
 * comparando justo los ids que decía ignorar.
 *
 * Ojo con `fileId`: NO se toca. Es el archivo en Drive, un dato de verdad, no
 * una identidad interna.
 */
function limpiar(o) {
  if (Array.isArray(o)) return o.map(limpiar);
  if (o === null || typeof o !== "object") return o;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (SIN_ID.has(k)) continue;
    out[k] = limpiar(v);
  }
  return out;
}

/** Orden estable e independiente de la fuente: por el contenido mismo. */
const ordenar = (lista) =>
  [...lista].map(limpiar).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

/**
 * Compara dos listas y devuelve el veredicto. Si no coinciden, dice CUÁLES
 * sobran de cada lado — un "no coinciden" a secas no sirve para arreglar nada.
 */
function comparar(nombre, deHoja, deBd) {
  const a = ordenar(deHoja);
  const b = ordenar(deBd);
  const textoA = a.map((x) => JSON.stringify(x));
  const textoB = b.map((x) => JSON.stringify(x));

  const soloHoja = textoA.filter((x) => !textoB.includes(x));
  const soloBd = textoB.filter((x) => !textoA.includes(x));

  const igual = soloHoja.length === 0 && soloBd.length === 0;
  const res = { nombre, igual, enHoja: a.length, enBd: b.length };
  if (!igual) {
    res.soloEnHoja = soloHoja.slice(0, 3).map((x) => JSON.parse(x));
    res.soloEnBd = soloBd.slice(0, 3).map((x) => JSON.parse(x));
    if (soloHoja.length > 3) res.masEnHoja = soloHoja.length - 3;
    if (soloBd.length > 3) res.masEnBd = soloBd.length - 3;
  }
  return res;
}

/**
 * Reindexa un objeto {idDeSucursal: valor} por NOMBRE de sucursal, para poder
 * comparar los dos lados: uno usa el `Sucursal ID` de la planilla y el otro el
 * uuid de la base.
 */
function porNombre(obj, nombrePorId) {
  const out = {};
  for (const [id, v] of Object.entries(obj || {})) out[nombrePorId[id] || `?${id}`] = v;
  return out;
}

export async function GET() {
  const [
    recHoja, sucHoja, medHoja, emiHoja, fotoHoja, mailHoja,
    recBd, sucBd, medBd, emiBd, fotoBd, mailBd,
  ] = await Promise.all([
    hoja.readRecords(), hojaSuc.readSucursales(), hojaMed.readMedidores(),
    hojaEmi.readEmissions(), hojaFoto.readFotos(), hojaCfg.readFotoNotifEmails(),
    bd.readRecords(), bd.readSucursales(), bd.readMedidores(),
    bd.readEmissions(), bd.readFotos(), bd.readFotoNotifEmails(),
  ]);

  // Nombre por id de sucursal, en cada lado, para las claves de emisiones.
  const nombresHoja = Object.fromEntries(sucHoja.map((s) => [s.id, s.nombre]));
  const nombresBd = Object.fromEntries(sucBd.map((s) => [s.id, s.nombre]));

  // Las lecturas y los adjuntos apuntan a un medidor por id; para comparar hay
  // que cambiar ese id por algo que signifique lo mismo en las dos fuentes.
  const claveMedidor = (meters) =>
    Object.fromEntries(meters.map((m) => [m.id, `${m.sucursal}|${m.type}|${m.numero}`]));
  const kHoja = claveMedidor(medHoja.meters);
  const kBd = claveMedidor(medBd.meters);

  const lecturasCon = (readings, mapa) =>
    readings.map((r) => ({ medidor: mapa[r.meterId] || `?${r.meterId}`, month: r.month, lectura: r.lectura }));

  const docsCon = (docs, mapa) =>
    Object.entries(docs || {}).map(([clave, roles]) => {
      const [meterId, mes] = clave.split("__");
      return { medidor: mapa[meterId] || `?${meterId}`, mes, roles };
    });

  const comparaciones = [
    comparar("registros", recHoja, recBd),
    comparar("sucursales", sucHoja, sucBd),
    comparar("medidores", medHoja.meters, medBd.meters),
    comparar("lecturas", lecturasCon(medHoja.readings, kHoja), lecturasCon(medBd.readings, kBd)),
    comparar("adjuntos", docsCon(medHoja.docs, kHoja), docsCon(medBd.docs, kBd)),
    comparar("precios", medHoja.prices, medBd.prices),
    comparar("fotos", fotoHoja, fotoBd),
    comparar(
      "avisosFoto",
      (mailHoja || []).map((e) => ({ email: e })),
      (mailBd || []).map((e) => ({ email: e })),
    ),
    // Emisiones no es una lista: se compara como un objeto, reindexado por
    // nombre de sucursal para que las claves signifiquen lo mismo.
    comparar(
      "emisiones",
      [
        {
          factoresEmpresa: (emiHoja || {}).factoresEmpresa || {},
          factoresSucursal: porNombre((emiHoja || {}).factoresSucursal, nombresHoja),
          refrigerantes: porNombre((emiHoja || {}).refrigerantesSucursal, nombresHoja),
          metaEmpresa: ((emiHoja || {}).metas || {}).empresa || {},
          metaSucursales: porNombre(((emiHoja || {}).metas || {}).sucursales, nombresHoja),
        },
      ],
      [
        {
          factoresEmpresa: emiBd.factoresEmpresa,
          factoresSucursal: porNombre(emiBd.factoresSucursal, nombresBd),
          refrigerantes: porNombre(emiBd.refrigerantesSucursal, nombresBd),
          metaEmpresa: emiBd.metas.empresa,
          metaSucursales: porNombre(emiBd.metas.sucursales, nombresBd),
        },
      ],
    ),
  ];

  const distintas = comparaciones.filter((c) => !c.igual);
  return NextResponse.json(
    {
      veredicto: distintas.length ? `${distintas.length} conjunto(s) no coinciden` : "todo coincide",
      comparaciones,
    },
    { status: distintas.length ? 409 : 200 },
  );
}
