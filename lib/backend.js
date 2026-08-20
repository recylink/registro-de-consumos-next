import "server-only";

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
export const readRecords = usarPostgres ? bdLecturas.readRecords : hojaRecords.readRecords;
export const readSucursales = usarPostgres
  ? bdLecturas.readSucursales
  : hojaSucursales.readSucursales;
export const readMedidores = usarPostgres
  ? bdLecturas.readMedidores
  : hojaMedidores.readMedidores;
export const readEmissions = usarPostgres
  ? bdLecturas.readEmissions
  : hojaEmisiones.readEmissions;
export const readFotos = usarPostgres ? bdLecturas.readFotos : hojaFotos.readFotos;
export const readFotoNotifEmails = usarPostgres
  ? bdLecturas.readFotoNotifEmails
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
