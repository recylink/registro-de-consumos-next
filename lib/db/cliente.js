import "server-only";
import pg from "pg";

// La conexión a PostgreSQL. Por ahora sirve para UNA cosa: que /api/health pueda
// responder si la app alcanza la base. Todavía no lee ni escribe datos de la app
// —eso es `lib/db/` completo, con las mismas firmas que `lib/sheets/`— pero el
// pool vive aquí desde el principio para que después no haya dos.
//
// PENDIENTE, y no es un detalle: la app NO puede conectarse como `postgres`. Ese
// rol tiene BYPASSRLS, así que el aislamiento entre clientes dejaría de existir
// sin que nada avise. Mientras esto sea solo una sonda de conexión da lo mismo
// (pregunta la versión, no lee datos de nadie), pero antes de que pase UN dato
// de cliente por aquí hace falta un rol propio sin ese privilegio.

let pool;

export function dbConfigurado() {
  return Boolean(process.env.DATABASE_URL);
}

// Supabase presenta un certificado que no valida contra una CA pública. Se
// intenta primero con verificación estricta y solo se baja si falla, y el
// resultado viaja en la respuesta de /api/health como `certificadoVerificado`:
// una concesión de seguridad que se ve, no una que se esconde en el código.
let certificadoVerificado = null;

async function crearPool() {
  const connectionString = process.env.DATABASE_URL;
  let ultimo;
  for (const estricto of [true, false]) {
    const candidato = new pg.Pool({
      connectionString,
      ssl: { rejectUnauthorized: estricto },
      // Pequeño a propósito: cada instancia de la función es un proceso, y el
      // pooler de Supabase es el que reparte de verdad.
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
    });
    try {
      const c = await candidato.connect();
      c.release();
      certificadoVerificado = estricto;
      return candidato;
    } catch (err) {
      ultimo = err;
      await candidato.end().catch(() => {});
    }
  }
  throw ultimo;
}

/** El pool, creado una sola vez. Se memoriza la promesa, no el resultado: con el
 *  resultado, dos peticiones simultáneas al arrancar crearían dos pools. */
export function db() {
  pool ||= crearPool().catch((err) => {
    pool = undefined; // que el próximo intento pueda reintentar
    throw err;
  });
  return pool;
}

/** ¿Alcanzamos la base, y qué hay del otro lado? Solo lectura, sin datos de nadie. */
export async function dbPing() {
  const p = await db();
  const { rows } = await p.query(`
    SELECT current_setting('server_version') AS version,
           current_user                      AS usuario,
           to_regclass('public.tipo_consumo') IS NOT NULL AS esquema,
           (SELECT count(*)::int FROM information_schema.tables
             WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS tablas,
           (SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public') AS politicas
  `);
  const info = rows[0];

  const detalle = {
    version: info.version,
    usuario: info.usuario,
    esquemaInstalado: info.esquema,
    tablas: info.tablas,
    politicas: info.politicas,
    certificadoVerificado,
    // La app todavía no lee ni escribe: esto solo confirma que hay camino.
    leeDatos: false,
  };

  if (info.esquema) {
    const { rows: tipos } = await p.query(
      "SELECT id FROM tipo_consumo WHERE activo ORDER BY orden",
    );
    detalle.tipos = tipos.map((t) => t.id);
  }
  return detalle;
}

// ---------------------------------------------------------------------
// Contexto compartido por lecturas y escrituras
// ---------------------------------------------------------------------

import { EMPRESA } from "../instance";

/** 'm3' de la base -> 'm³' del dominio. */
export const unidadDominio = (u) => (u === "m3" ? "m³" : u || "");

/** 'm³' del dominio -> 'm3' del enum de la base. */
export const unidadBase = (u) => {
  const t = String(u || "").trim();
  return t === "m³" ? "m3" : t || null;
};

/** Un numero de la base al contrato de la planilla: NULL se leia como 0. */
export const num = (v) => (v == null ? 0 : Number(v));

let empresaCache;

/**
 * El id de la empresa de esta instancia. `EMPRESA` es la constante del deploy
 * ("NEXT"); en la base es una fila.
 *
 * Es el filtro de TODAS las consultas de lib/db. Hoy la app entra como
 * `postgres`, que se salta RLS, asi que el aislamiento entre clientes lo pone
 * esta funcion y nada mas: es el escenario que el esquema advierte, "que UNA
 * funcion lo ponga siempre".
 */
export async function empresaId() {
  if (empresaCache) return empresaCache;
  const p = await db();
  const { rows } = await p.query("SELECT id FROM empresa WHERE codigo = $1", [EMPRESA]);
  if (!rows.length) {
    throw new Error(
      `la empresa "${EMPRESA}" no existe en la base. ` +
        "Corre el volcado (npm run db:instalar carga.sql) antes de usarla.",
    );
  }
  empresaCache = rows[0].id;
  return empresaCache;
}

/** Consulta con el id de empresa ya puesto como $1. */
export async function consultar(sql, params = []) {
  const p = await db();
  const { rows } = await p.query(sql, [await empresaId(), ...params]);
  return rows;
}

/** Varias consultas en una transaccion, con el id de empresa a mano. */
export async function enTransaccion(fn) {
  const p = await db();
  const cliente = await p.connect();
  const emp = await empresaId();
  try {
    await cliente.query("BEGIN");
    const salida = await fn(cliente, emp);
    await cliente.query("COMMIT");
    return salida;
  } catch (err) {
    await cliente.query("ROLLBACK");
    throw err;
  } finally {
    cliente.release();
  }
}
