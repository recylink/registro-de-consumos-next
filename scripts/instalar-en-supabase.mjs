// Instala el esquema en el espacio principal (`public`) de la base de Supabase,
// de verdad y para quedarse. A diferencia de `db:supabase`, esto NO borra nada
// al terminar.
//
//   npm run db:instalar                 # solo las tablas, vacias
//   npm run db:instalar carga.sql       # tablas + los datos de la planilla
//   npm run db:instalar -- --reinstalar # borra lo instalado y vuelve a instalar
//
// Dos protecciones, porque esto escribe en una base real:
//
// 1. Se niega a correr si `public` ya tiene alguna de nuestras tablas. Instalar
//    dos veces no es "actualizar": es un choque de nombres a mitad de camino.
//    Con `--reinstalar` borra y vuelve a instalar, y eso a su vez se niega si
//    encuentra datos de cliente.
// 2. Todo va en UNA transaccion. En Postgres el DDL tambien es transaccional,
//    asi que si algo falla en la tabla 19 no queda media instalacion: no queda
//    nada. La base o pasa completa, o no cambia.
import { readFile } from "node:fs/promises";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Falta DATABASE_URL en .env.local.");
  process.exit(1);
}

const argumentos = process.argv.slice(2);
const reinstalar = argumentos.includes("--reinstalar");
const datos = argumentos.filter((a) => !a.startsWith("--"));

// Borra NUESTROS objetos de public, no el esquema. La diferencia importa: en
// `public` Supabase tiene configurados permisos por defecto (pg_default_acl) que
// son los que hacen que una tabla nueva nazca legible para `authenticated`. Esa
// configuracion apunta al esquema, asi que `DROP SCHEMA public` se la lleva, y
// las tablas siguientes naceran sin permisos: la app no podria leer nada y el
// motivo seria dificil de encontrar.
//
// Se niega a correr si hay UNA fila en cualquier tabla. Reinstalar es para un
// esquema que todavia no tiene datos; con datos adentro, lo que corresponde es
// una migracion, no un borron.
const LIMPIAR = `
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.tablename);
  END LOOP;
  FOR r IN SELECT p.proname AS nombre, pg_get_function_identity_arguments(p.oid) AS args
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS public.%I(%s) CASCADE', r.nombre, r.args);
  END LOOP;
  FOR r IN SELECT t.typname AS nombre, t.typtype AS clase
             FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd') LOOP
    IF r.clase = 'd' THEN
      EXECUTE format('DROP DOMAIN IF EXISTS public.%I CASCADE', r.nombre);
    ELSE
      EXECUTE format('DROP TYPE IF EXISTS public.%I CASCADE', r.nombre);
    END IF;
  END LOOP;
END $$;`;

// Cuenta las filas de DATOS DE CLIENTE, con un count() de verdad.
//
// Dos decisiones aqui, y las dos importan porque de esto depende no borrar algo
// que valia:
//
// 1. Se cuenta con `count(*)`, no con `reltuples` ni `n_live_tup`. Esos dos son
//    estimaciones del planificador y pueden decir cero con la tabla llena si
//    todavia no paso el recolector de estadisticas. Para decidir un borrado,
//    una estimacion no sirve.
// 2. Se cuentan las tablas con `empresa_id`, MAS `holding` y `empresa`. Las dos
//    ultimas hay que nombrarlas: `empresa` no tiene una columna `empresa_id`
//    —su identificador propio es `id`—, asi que la regla "tiene empresa_id" la
//    dejaba fuera. La primera version de este guardia hizo exactamente eso y
//    borro una fila de `empresa` sin detenerse; lo pillo la prueba de meter una
//    fila a proposito antes de confiar en el.
//    Los catalogos quedan fuera adrede: el propio esquema siembra los cuatro
//    tipos de consumo, y contarlos daria una falsa alarma en cada reinstalacion.
const CONTAR_DATOS = `
DO $$
DECLARE
  r record;
  n bigint;
  total bigint := 0;
  detalle text := '';
BEGIN
  FOR r IN
    SELECT c.relname AS tabla
      FROM pg_class c JOIN pg_namespace n2 ON n2.oid = c.relnamespace
     WHERE n2.nspname = 'public' AND c.relkind = 'r'
       AND (c.relname IN ('holding', 'empresa') OR EXISTS (
         SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname = 'empresa_id' AND a.attnum > 0))
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', r.tabla) INTO n;
    IF n > 0 THEN
      total := total + n;
      detalle := detalle || format('%s=%s ', r.tabla, n);
    END IF;
  END LOOP;
  IF total > 0 THEN
    RAISE EXCEPTION 'hay % filas de datos en public (%)', total, detalle
      USING HINT = 'Reinstalar borra; con datos adentro lo que corresponde es una migracion.';
  END IF;
END $$;`;

async function limpiar(cliente) {
  await cliente.query(CONTAR_DATOS); // lanza si hay datos de cliente
  await cliente.query(LIMPIAR);
  console.log("lo instalado antes fue borrado (public vacio, con sus permisos intactos)");
}

const cliente = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await cliente.connect();

const destino = new URL(url.replace(/^postgres(ql)?:/, "http:"));
console.log(`conectado a ${destino.hostname}${destino.pathname}`);

const { rows: yaEstan } = await cliente.query(
  `SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('empresa', 'holding', 'sucursal', 'registro_consumo')`,
);
if (yaEstan.length && reinstalar) {
  try {
    await limpiar(cliente);
  } catch (e) {
    // El guardia dice "no": eso es un final legitimo, no una falla del script.
    // Sin este catch la excepcion sube sin manejar y el usuario ve un volcado de
    // pila en vez del motivo.
    console.error(`\nNo se reinstalo: ${e.message}`);
    if (e.hint) console.error(e.hint);
    await cliente.end();
    process.exit(1);
  }
} else if (yaEstan.length) {
  console.error(
    `\nEn public ya existe: ${yaEstan.map((r) => r.table_name).join(", ")}.\n` +
      "No instalo encima. Para empezar de nuevo:\n" +
      "  npm run db:instalar -- --reinstalar\n" +
      "Eso borra lo instalado y vuelve a instalar, y se niega si hay datos.",
  );
  await cliente.end();
  process.exit(1);
}

const archivos = ["ESQUEMA-POSTGRES.sql", ...datos, "ESQUEMA-POSTGRES-RLS.sql"];

try {
  await cliente.query("BEGIN");
  for (const ruta of archivos) {
    await cliente.query(await readFile(ruta, "utf8"));
    console.log(`ok  ${ruta}`);
  }
  await cliente.query("COMMIT");
} catch (e) {
  await cliente.query("ROLLBACK");
  console.error(`\nFALLA: ${e.message}`);
  if (e.detail) console.error(`  ${e.detail}`);
  console.error("Se deshizo todo: la base quedo como estaba.");
  await cliente.end();
  process.exit(1);
}

const { rows: resumen } = await cliente.query(`
  SELECT (SELECT count(*) FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS tablas,
         (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS politicas,
         (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity) AS con_rls
`);
const r = resumen[0];
console.log(
  `\ninstalado en public: ${r.tablas} tablas, ${r.con_rls} con aislamiento activo, ` +
    `${r.politicas} politicas`,
);

// Las tablas de catalogo no llevan RLS a proposito: son compartidas.
const { rows: sinRls } = await cliente.query(`
  SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
   ORDER BY 1
`);
if (sinRls.length) {
  console.log(`sin aislamiento (catalogos compartidos): ${sinRls.map((x) => x.relname).join(", ")}`);
}

await cliente.end();
