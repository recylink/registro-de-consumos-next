// Corre el esquema contra el Postgres de verdad de Supabase, dentro de un
// esquema desechable que se borra al terminar. Mismas comprobaciones que
// `npm run db:check`, pero en el motor real: PGlite es Postgres, no es EL
// Postgres de producción, y las diferencias que importan (versión, extensiones,
// roles, permisos) solo aparecen aquí.
//
//   npm run db:supabase                  # arma, prueba y borra
//   npm run db:supabase carga.sql        # además carga el volcado de la planilla
//   npm run db:supabase -- --conservar   # NO borra al final, para poder mirar
//
// Necesita DATABASE_URL en .env.local (la cadena URI del panel de Supabase).
// Nunca se imprime: del enlace solo se muestran servidor y base.
import { readFile } from "node:fs/promises";
import pg from "pg";
import { sembrar, correrPruebas } from "./pruebas-alcance.mjs";

const ESQUEMA = "prueba_esquema";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    "Falta DATABASE_URL. Copiala del panel de Supabase (Project Settings →\n" +
      "Database → Connection string → URI) y pegala en .env.local:\n" +
      "  DATABASE_URL=postgresql://postgres:CLAVE@...supabase.com:5432/postgres",
  );
  process.exit(1);
}

const argumentos = process.argv.slice(2);
const conservar = argumentos.includes("--conservar");
const archivos = argumentos.filter((a) => !a.startsWith("--"));

// Primero con verificación estricta del certificado; si el servidor usa una CA
// propia, se reintenta sin verificar y se avisa. No se calla la diferencia.
async function conectar() {
  for (const ssl of [{ rejectUnauthorized: true }, { rejectUnauthorized: false }]) {
    const cliente = new pg.Client({ connectionString: url, ssl });
    try {
      await cliente.connect();
      if (!ssl.rejectUnauthorized) {
        console.log("aviso: certificado del servidor no verificado (CA propia de Supabase).");
      }
      return cliente;
    } catch (e) {
      await cliente.end().catch(() => {});
      if (ssl.rejectUnauthorized) continue;
      throw e;
    }
  }
}

const cliente = await conectar();
const destino = new URL(url.replace(/^postgres(ql)?:/, "http:"));
console.log(`conectado a ${destino.hostname}${destino.pathname}`);

const bd = {
  query: (sql, params) => cliente.query(sql, params),
  async descartable(fn) {
    await cliente.query("BEGIN");
    try {
      return await fn(cliente);
    } finally {
      await cliente.query("ROLLBACK");
    }
  },
};

async function aplicar(ruta) {
  await cliente.query(await readFile(ruta, "utf8"));
  console.log(`ok  ${ruta}`);
}

let fallas = 0;
try {
  const { rows: quien } = await cliente.query(
    `SELECT current_user AS usuario, version() AS version,
            rolsuper AS es_super, rolbypassrls AS salta_rls
       FROM pg_roles WHERE rolname = current_user`,
  );
  const yo = quien[0];
  console.log(`${yo.version.split(" ").slice(0, 2).join(" ")} · usuario ${yo.usuario}`);

  // Un rol que se salta RLS ve todo aunque las políticas digan lo contrario, así
  // que probar el aislamiento con él daría verde sin probar nada. `authenticated`
  // es el rol con el que Supabase atiende a un usuario con sesión: es
  // exactamente el que va a leer estos datos en producción.
  const { rows: candidato } = await cliente.query(
    `SELECT rolname FROM pg_roles
      WHERE rolname = 'authenticated' AND NOT rolbypassrls AND NOT rolsuper`,
  );
  const rol = candidato[0]?.rolname;
  if (!rol) {
    console.error(
      "No existe un rol 'authenticated' sin privilegio de saltarse RLS.\n" +
        "Sin él las pruebas de aislamiento no prueban nada, así que no se corren.",
    );
    process.exit(1);
  }
  if (yo.es_super || yo.salta_rls) {
    console.log(`(${yo.usuario} se salta RLS; el aislamiento se prueba como ${rol})`);
  }

  await cliente.query(`CREATE SCHEMA ${ESQUEMA}`);
  await cliente.query(`SET search_path TO ${ESQUEMA}`);
  console.log(`esquema desechable ${ESQUEMA} creado`);

  await aplicar("ESQUEMA-POSTGRES.sql");
  for (const extra of archivos) await aplicar(extra);

  const F = await sembrar(bd);

  await aplicar("ESQUEMA-POSTGRES-RLS.sql");
  await cliente.query(`GRANT USAGE ON SCHEMA ${ESQUEMA} TO ${rol}`);
  await cliente.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${ESQUEMA} TO ${rol}`,
  );

  fallas = await correrPruebas(bd, F, rol);

  const { rows: tablas } = await cliente.query(
    `SELECT table_name AS tabla FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY 1`,
    [ESQUEMA],
  );
  console.log(`\n${tablas.length} tablas: ${tablas.map((r) => r.tabla).join(", ")}`);
} catch (e) {
  fallas++;
  console.error(`\nFALLA: ${e.message}`);
  if (e.detail) console.error(`  ${e.detail}`);
} finally {
  if (conservar) {
    console.log(`\nEl esquema ${ESQUEMA} queda en pie. Para borrarlo:`);
    console.log(`  DROP SCHEMA ${ESQUEMA} CASCADE;`);
  } else {
    await cliente.query(`DROP SCHEMA IF EXISTS ${ESQUEMA} CASCADE`);
    console.log(`\nesquema desechable ${ESQUEMA} borrado; la base queda como estaba`);
  }
  await cliente.end();
}

if (fallas) {
  console.error(`${fallas} comprobación(es) fallaron.`);
  process.exit(1);
}
console.log("Todo en verde, en Supabase.");
