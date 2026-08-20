// Corre el esquema en un Postgres real (PGlite = Postgres compilado a
// WebAssembly), sin docker ni psql. Es la prueba de que el DDL compila y de que
// el aislamiento entre clientes hace lo que dice.
//
//   npm run db:check                 # esquema + RLS + pruebas de alcance
//   npm run db:check volcado.sql     # además aplica el volcado de la planilla
//
// El orden es el de producción: esquema → datos → RLS. Al revés, la carga no
// vería nada. Para la misma prueba contra Supabase: scripts/probar-en-supabase.mjs
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { sembrar, correrPruebas } from "./pruebas-alcance.mjs";

const db = await new PGlite();

// En PGlite somos superusuario, y un superusuario se salta RLS incluso con
// FORCE. Sin un rol común, las pruebas de alcance darían verde sin probar nada.
const ROL = "app_alcance";

const ROLLBACK = Symbol("rollback");

const bd = {
  query: (sql, params) => db.query(sql, params),
  async descartable(fn) {
    let salida;
    try {
      await db.transaction(async (tx) => {
        salida = await fn(tx);
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
    return salida;
  },
};

async function aplicar(ruta) {
  try {
    await db.exec(await readFile(ruta, "utf8"));
    console.log(`ok  ${ruta}`);
  } catch (e) {
    console.error(`FALLA  ${ruta}\n  ${e.message}`);
    process.exit(1);
  }
}

await aplicar("ESQUEMA-POSTGRES.sql");
for (const extra of process.argv.slice(2)) await aplicar(extra);

const F = await sembrar(bd);

await aplicar("ESQUEMA-POSTGRES-RLS.sql");
await db.exec(`
  CREATE ROLE ${ROL};
  GRANT USAGE ON SCHEMA public TO ${ROL};
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROL};
`);

const fallas = await correrPruebas(bd, F, ROL);

const { rows: tablas } = await db.query(
  `SELECT table_name AS tabla FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`,
);
console.log(`\n${tablas.length} tablas: ${tablas.map((r) => r.tabla).join(", ")}`);

if (fallas) {
  console.error(`\n${fallas} comprobación(es) fallaron.`);
  process.exit(1);
}
console.log("\nTodo en verde.");
