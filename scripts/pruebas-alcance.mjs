// Las comprobaciones que valen para cualquier Postgres: el alcance entre
// clientes y las reglas de la tabla homologada de consumos.
//
// Las usan los dos verificadores —el local (PGlite) y el de Supabase— para que
// midan exactamente lo mismo. Si se duplicaran, se separarían.
//
// El "adaptador" que reciben solo necesita dos cosas:
//   query(sql, params?)   -> { rows }
//   descartable(fn)       -> corre fn(tx) y SIEMPRE deshace lo que escriba

/** Siembra un holding con dos empresas y tres sucursales. ANTES de activar RLS. */
export async function sembrar(bd) {
  const { rows } = await bd.query(`
    WITH h AS (
      INSERT INTO holding (nombre) VALUES ('Holding de prueba') RETURNING id
    ), ea AS (
      INSERT INTO empresa (holding_id, codigo, nombre)
      SELECT id, 'PRUEBA-A', 'Empresa A' FROM h RETURNING id
    ), eb AS (
      INSERT INTO empresa (holding_id, codigo, nombre)
      SELECT id, 'PRUEBA-B', 'Empresa B' FROM h RETURNING id
    ), a1 AS (
      INSERT INTO sucursal (empresa_id, nombre) SELECT id, 'A1' FROM ea RETURNING id
    ), a2 AS (
      INSERT INTO sucursal (empresa_id, nombre) SELECT id, 'A2' FROM ea RETURNING id
    ), b1 AS (
      INSERT INTO sucursal (empresa_id, nombre) SELECT id, 'B1' FROM eb RETURNING id
    )
    SELECT (SELECT id FROM ea) AS empresa_a,
           (SELECT id FROM eb) AS empresa_b,
           (SELECT id FROM a1) AS suc_a1,
           (SELECT id FROM b1) AS suc_b1
  `);
  await bd.query(
    `INSERT INTO refrigerante_gas (id, label, gwp_ar5) VALUES ('r410a', 'R-410A', 2088)
     ON CONFLICT (id) DO NOTHING`,
  );
  return rows[0];
}

/**
 * Corre las comprobaciones. `rol` es un rol SIN privilegio de saltarse RLS: un
 * superusuario ve todo aunque las políticas digan lo contrario, así que probar
 * como superusuario da verde sin probar nada.
 * Devuelve la cantidad de fallas.
 */
export async function correrPruebas(bd, F, rol) {
  let fallas = 0;
  const comprobar = (nombre, ok) => {
    if (ok) return console.log(`  ok    ${nombre}`);
    fallas++;
    console.error(`  FALLA ${nombre}`);
  };

  /** Corre fn con un alcance puesto, como rol común, y deshace lo que escriba. */
  const conAlcance = ({ empresas = [], sucursales = [] }, fn) =>
    bd.descartable(async (tx) => {
      const lista = (ids) => (ids.length ? `{${ids.join(",")}}` : "");
      await tx.query("SELECT set_config('app.empresa_ids', $1, true)", [lista(empresas)]);
      await tx.query("SELECT set_config('app.sucursal_ids', $1, true)", [lista(sucursales)]);
      await tx.query("SELECT set_config('role', $1, true)", [rol]);
      return fn(tx);
    });

  /** true si la consulta falla, que es lo que se espera de una regla que sirve. */
  const rechaza = async (fn) => {
    try {
      await fn();
      return false;
    } catch {
      return true;
    }
  };

  // -------------------------------------------------------------------
  console.log("\nAlcance (quién ve qué):");

  const cuentaSucursales = (alcance) =>
    conAlcance(alcance, async (tx) => {
      const { rows } = await tx.query("SELECT count(*)::int AS n FROM sucursal");
      return rows[0].n;
    });

  comprobar(
    "usuario de holding ve las 3 sucursales de sus 2 empresas",
    (await cuentaSucursales({ empresas: [F.empresa_a, F.empresa_b] })) === 3,
  );
  comprobar(
    "usuario de empresa ve solo las 2 de la suya",
    (await cuentaSucursales({ empresas: [F.empresa_a] })) === 2,
  );
  comprobar(
    "usuario de sucursal ve solo la suya",
    (await cuentaSucursales({ empresas: [F.empresa_a], sucursales: [F.suc_a1] })) === 1,
  );
  comprobar("sin alcance puesto no se ve nada", (await cuentaSucursales({})) === 0);

  comprobar(
    "el nombre del holding no se filtra sin alcance",
    (await conAlcance({}, async (tx) => {
      const { rows } = await tx.query("SELECT count(*)::int AS n FROM holding");
      return rows[0].n;
    })) === 0,
  );

  comprobar(
    "no se puede escribir una fila de otra empresa (WITH CHECK)",
    await conAlcance({ empresas: [F.empresa_a] }, (tx) =>
      rechaza(() =>
        tx.query(
          `INSERT INTO registro_consumo (empresa_id, sucursal_id, tipo_consumo, fecha, consumo, unidad)
           VALUES ($1, $2, 'agua', '2026-03-07', 10, 'm3')`,
          [F.empresa_b, F.suc_b1],
        ),
      ),
    ),
  );

  // -------------------------------------------------------------------
  console.log("\nTabla homologada de consumos:");

  const alcanceA = { empresas: [F.empresa_a] };
  const insertar = (tx, campos, valores) =>
    tx.query(
      `INSERT INTO registro_consumo (empresa_id, sucursal_id, ${campos})
       VALUES ($1, $2, ${valores})`,
      [F.empresa_a, F.suc_a1],
    );

  comprobar(
    "el mes se deriva de la fecha sin que nadie lo escriba",
    (await conAlcance(alcanceA, async (tx) => {
      await insertar(tx, "tipo_consumo, fecha, consumo, unidad", "'agua', '2026-03-07', 10, 'm3'");
      const { rows } = await tx.query(
        "SELECT periodo FROM registro_consumo WHERE sucursal_id = $1",
        [F.suc_a1],
      );
      return rows[0].periodo;
    })) === "2026-03",
  );

  comprobar(
    "dos boletas de agua del mismo cliente y mes: la segunda se rechaza",
    await conAlcance(alcanceA, async (tx) => {
      await insertar(
        tx,
        "tipo_consumo, num_cliente, fecha, consumo, unidad",
        "'agua', '77', '2026-03-07', 10, 'm3'",
      );
      return rechaza(() =>
        insertar(
          tx,
          "tipo_consumo, num_cliente, fecha, consumo, unidad",
          "'agua', '77', '2026-03-22', 12, 'm3'",
        ),
      );
    }),
  );

  comprobar(
    "dos cargas de combustible el mismo mes: ambas pasan",
    await conAlcance(alcanceA, async (tx) => {
      await insertar(tx, "tipo_consumo, fecha, consumo, unidad", "'combustible', '2026-03-07', 40, 'L'");
      await insertar(tx, "tipo_consumo, fecha, consumo, unidad", "'combustible', '2026-03-22', 35, 'L'");
      const { rows } = await tx.query(
        "SELECT count(*)::int AS n FROM registro_consumo WHERE sucursal_id = $1",
        [F.suc_a1],
      );
      return rows[0].n === 2;
    }),
  );

  comprobar(
    "los refrigerantes entran a la misma tabla, con su gas",
    await conAlcance(alcanceA, async (tx) => {
      await insertar(
        tx,
        "tipo_consumo, refrigerante_gas_id, fecha, consumo, unidad",
        "'refrigerantes', 'r410a', '2026-03-01', 2.5, 'kg'",
      );
      const { rows } = await tx.query(
        "SELECT count(*)::int AS n FROM registro_consumo WHERE tipo_consumo = 'refrigerantes'",
      );
      return rows[0].n === 1;
    }),
  );

  comprobar(
    "un refrigerante sin gas se rechaza, y un gas en una fila de agua también",
    await conAlcance(alcanceA, async (tx) => {
      const sinGas = await rechaza(() =>
        insertar(tx, "tipo_consumo, fecha, consumo, unidad", "'refrigerantes', '2026-03-01', 2.5, 'kg'"),
      );
      const gasDeMas = await rechaza(() =>
        insertar(
          tx,
          "tipo_consumo, refrigerante_gas_id, fecha, consumo, unidad",
          "'agua', 'r410a', '2026-03-01', 10, 'm3'",
        ),
      );
      return sinGas && gasDeMas;
    }),
  );

  // -------------------------------------------------------------------
  console.log("\nTipos de consumo (la tabla que reemplazó al ENUM):");

  comprobar(
    "un tipo que no existe en el catalogo se rechaza",
    await conAlcance(alcanceA, (tx) =>
      rechaza(() =>
        insertar(tx, "tipo_consumo, fecha, consumo, unidad", "'papel', '2026-03-07', 10, 'kg'"),
      ),
    ),
  );

  comprobar(
    "agregar un tipo nuevo es un INSERT, sin migracion",
    await conAlcance(alcanceA, async (tx) => {
      await tx.query(
        `INSERT INTO tipo_consumo (id, label, unidad_default, orden)
         VALUES ('papel', 'Papel', 'kg', 50)`,
      );
      await insertar(tx, "tipo_consumo, fecha, consumo, unidad", "'papel', '2026-03-07', 10, 'kg'");
      const { rows } = await tx.query(
        "SELECT count(*)::int AS n FROM registro_consumo WHERE tipo_consumo = 'papel'",
      );
      return rows[0].n === 1;
    }),
  );

  comprobar(
    "no se puede borrar un tipo que esta en uso",
    await conAlcance(alcanceA, async (tx) => {
      await insertar(tx, "tipo_consumo, fecha, consumo, unidad", "'agua', '2026-03-07', 10, 'm3'");
      return rechaza(() => tx.query("DELETE FROM tipo_consumo WHERE id = 'agua'"));
    }),
  );

  return fallas;
}
