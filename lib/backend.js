import "server-only";
import { unstable_cache } from "next/cache";

import { TAGS } from "./apps-script";
import * as hojaRecords from "./sheets/records";
import * as hojaSucursales from "./sheets/sucursales";
import * as hojaMedidores from "./sheets/medidores";
import * as hojaEmisiones from "./sheets/emissions";
import * as hojaFotos from "./sheets/fotos";
import * as hojaConfig from "./sheets/config-store";

import * as bdLecturas from "./db/lecturas";
import * as bdEscrituras from "./db/escrituras";

// De dónde salen y a dónde van los datos de la app: la planilla de Google o
// PostgreSQL. UN solo lugar decide, y todo lo demás importa de aquí.
//
//   DATOS_BACKEND=postgres   -> PostgreSQL
//   (sin definir)            -> la planilla, como siempre
//
// Por qué una variable de entorno y no una bandera en la base: es por INSTANCIA.
// Hay varias versiones desplegadas del Registro de Consumos (NEXT, Ando, Obra
// Limpia…), cada una con su planilla y sus usuarios. Con esto NEXT pasa a
// PostgreSQL sin tocar a las demás, y volver atrás es cambiar una variable.
//
// **El cambio es de las dos cosas a la vez, lecturas y escrituras.** No se puede
// leer de la base y escribir en la planilla: registrarías un consumo y no
// aparecería en pantalla, porque quedó en el otro lado.
export const usarPostgres = process.env.DATOS_BACKEND === "postgres";

const fuente = usarPostgres ? "postgres" : "sheets";

/** Para diagnóstico: qué backend de datos está activo. */
export function backendDatos() {
  return fuente;
}

// --- Lecturas --------------------------------------------------------
//
// Las lecturas de PostgreSQL se envuelven con el MISMO tag y el mismo tiempo de
// vida que usa su gemela de la planilla en `lib/apps-script.js`.
//
// No es una optimización, es lo que hace que la pantalla se entere de que algo
// cambió. Las páginas se prerenderizan, y lo único que las vuelve a dibujar es
// el `revalidateTag()` que llaman los Server Actions al guardar. Las lecturas de
// la planilla pasan por `apiGet`, que ya las marca con su tag; las de `lib/db/`
// van directo al driver y no pasan por ahí. Sin este envoltorio, en modo
// PostgreSQL el `revalidateTag()` no invalida nada: el dato se guarda bien en la
// base y la pantalla sigue mostrando lo de antes, sin ningún error a la vista.
//
// El tag y el `revalidate` de cada una tienen que seguir coincidiendo con los de
// `lib/sheets/*`, o las dos fuentes se comportarían distinto ante el mismo
// guardado.
const conTag = (fn, tag, revalidate) =>
  unstable_cache(fn, [`db:${tag}`], { tags: [tag], revalidate });

export const readRecords = usarPostgres
  ? conTag(bdLecturas.readRecords, TAGS.records, 15)
  : hojaRecords.readRecords;
export const readSucursales = usarPostgres
  ? conTag(bdLecturas.readSucursales, TAGS.sucursales, 60)
  : hojaSucursales.readSucursales;
export const readMedidores = usarPostgres
  ? conTag(bdLecturas.readMedidores, TAGS.medidores, 30)
  : hojaMedidores.readMedidores;
export const readEmissions = usarPostgres
  ? conTag(bdLecturas.readEmissions, TAGS.emissions, 60)
  : hojaEmisiones.readEmissions;
export const readFotos = usarPostgres
  ? conTag(bdLecturas.readFotos, TAGS.fotos, 15)
  : hojaFotos.readFotos;
export const readFotoNotifEmails = usarPostgres
  ? conTag(bdLecturas.readFotoNotifEmails, TAGS.config, 300)
  : hojaConfig.readFotoNotifEmails;

// --- Escrituras ------------------------------------------------------
export const appendRecords = usarPostgres
  ? bdEscrituras.appendRecords
  : hojaRecords.appendRecords;
export const updateRecordField = usarPostgres
  ? bdEscrituras.updateRecordField
  : hojaRecords.updateRecordField;
export const renameSucursalInRecords = usarPostgres
  ? bdEscrituras.renameSucursalInRecords
  : hojaRecords.renameSucursalInRecords;
export const upsertSucursal = usarPostgres
  ? bdEscrituras.upsertSucursal
  : hojaSucursales.upsertSucursal;
export const deleteSucursal = usarPostgres
  ? bdEscrituras.deleteSucursal
  : hojaSucursales.deleteSucursal;
export const writeSucursales = usarPostgres
  ? bdEscrituras.writeSucursales
  : hojaSucursales.writeSucursales;
export const upsertMedidores = usarPostgres
  ? bdEscrituras.upsertMedidores
  : hojaMedidores.upsertMedidores;
export const upsertEmissions = usarPostgres
  ? bdEscrituras.upsertEmissions
  : hojaEmisiones.upsertEmissions;
export const uploadFoto = usarPostgres ? bdEscrituras.uploadFoto : hojaFotos.uploadFoto;
export const completeFoto = usarPostgres ? bdEscrituras.completeFoto : hojaFotos.completeFoto;
export const writeFotoNotifEmails = usarPostgres
  ? bdEscrituras.writeFotoNotifEmails
  : hojaConfig.writeFotoNotifEmails;

// El aviso por correo NO depende del backend de datos: manda un mail, no
// guarda nada. Sale siempre por el mismo camino.
export const notifyFotoPending = hojaFotos.notifyFotoPending;

// Las carpetas de Drive: en la planilla eran un JSON en la hoja `Config`; en
// PostgreSQL son filas de `drive_carpeta`. `lib/drive-folders.js` usa esto.
export const readDriveFoldersDb = bdLecturas.readDriveFolders;
