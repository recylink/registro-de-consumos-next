-- =====================================================================
-- Registro de Consumos — aislamiento entre clientes (RLS)
--
-- Se aplica DESPUÉS de ESQUEMA-POSTGRES.sql y DESPUÉS de cargar los datos:
-- con las políticas activas y sin alcance puesto, la propia carga no vería
-- nada.
--
-- QUÉ ES EL "ALCANCE", Y POR QUÉ NO ES UN TENANT
--
-- RECYLINK tiene tres niveles —holding → empresa → sucursal— y un usuario
-- está en UNO. Un usuario de holding ve varias empresas a la vez, así que lo
-- que hay que fijar en la sesión no es "el tenant" sino un CONJUNTO de
-- empresas y, opcionalmente, un subconjunto de sucursales:
--
--   usuario de holding:   empresa_ids = todas las del holding, sucursal_ids = vacío
--   usuario de empresa:   empresa_ids = {la suya},             sucursal_ids = vacío
--   usuario de sucursal:  empresa_ids = {la de su sucursal},   sucursal_ids = {la suya}
--
-- `sucursal_ids` vacío significa "todas las del alcance de empresa". Es la
-- traducción exacta de lo que pidió el producto: filtro de empresa cuando hay
-- más de una, filtro de sucursal deshabilitado cuando el alcance es global.
--
-- Se fija UNA vez al tomar la conexión, dentro de la transacción:
--
--   SELECT set_config('app.empresa_ids',  '{uuid,uuid}', true);
--   SELECT set_config('app.sucursal_ids', '',            true);
--
-- El tercer argumento `true` es lo que en SQL plano sería SET LOCAL: dura la
-- transacción y no más. En un pool de conexiones esa es la diferencia entre
-- aislar y entregarle a un cliente los datos de la request anterior.
--
-- SIN ALCANCE PUESTO NO SE VE NADA: `x = ANY(NULL)` es NULL, y una política
-- que no da verdadero no deja pasar la fila. El default es cerrado, no
-- abierto, que es la única forma correcta de equivocarse.
--
-- SI RECYLINK NO USA RLS: este archivo no se aplica y el filtro pasa a la
-- capa de datos. En ese caso el requisito es que UNA función construya toda
-- consulta con su filtro de alcance — nunca cada consulta por su cuenta,
-- porque la que se olvide no falla: devuelve datos de otro cliente.
--
-- Los catálogos (tipo_consumo, subcategoria, subcategoria_unidad, proveedor,
-- factor_emision, refrigerante_gas) NO llevan RLS: son compartidos entre
-- clientes, por decisión, y la consecuencia está anotada en la sección 2 del
-- otro archivo.
-- =====================================================================

CREATE FUNCTION empresas_actuales() RETURNS uuid[] AS $$
  SELECT nullif(current_setting('app.empresa_ids', true), '')::uuid[];
$$ LANGUAGE sql STABLE;

-- NULL = sin restricción de sucursal (todas las del alcance de empresa).
CREATE FUNCTION sucursales_actuales() RETURNS uuid[] AS $$
  SELECT nullif(current_setting('app.sucursal_ids', true), '')::uuid[];
$$ LANGUAGE sql STABLE;

DO $$
DECLARE
  item  text;
  tabla text;
  col   text;
  pred  text;
BEGIN
  -- ------------------------------------------------------------------
  -- Tablas de nivel empresa: no cuelgan de una sucursal, así que un
  -- usuario de sucursal las ve completas dentro de su empresa. Es
  -- correcto para la configuración (carpetas de Drive, factores de la
  -- empresa, metas, avisos), y es un hueco conocido en `archivo_drive`:
  -- el enlace a la factura de otra sucursal de la misma empresa queda
  -- visible. Si eso llega a importar, una columna `sucursal_id` en
  -- archivo_drive es el arreglo.
  -- ------------------------------------------------------------------
  FOREACH item IN ARRAY ARRAY[
    'archivo_drive', 'drive_carpeta', 'factor_emision_empresa',
    'meta_empresa', 'foto_notif_email', 'app_config'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', item);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', item);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (%s) WITH CHECK (%s)',
      item || '_alcance', item,
      'empresa_id = ANY (empresas_actuales())',
      'empresa_id = ANY (empresas_actuales())');
  END LOOP;

  -- ------------------------------------------------------------------
  -- Tablas con sucursal: filtran por empresa Y por sucursal. El formato
  -- es 'tabla:columna' porque en `sucursal` la columna es su propio `id`.
  -- ------------------------------------------------------------------
  FOREACH item IN ARRAY ARRAY[
    'sucursal:id', 'sucursal_subcategoria:sucursal_id',
    'registro_consumo:sucursal_id', 'medidor:sucursal_id',
    'precio_periodo:sucursal_id', 'factor_emision_sucursal:sucursal_id',
    'meta_sucursal:sucursal_id'
  ] LOOP
    tabla := split_part(item, ':', 1);
    col   := split_part(item, ':', 2);
    pred  := format(
      'empresa_id = ANY (empresas_actuales()) AND '
      '(sucursales_actuales() IS NULL OR %I = ANY (sucursales_actuales()))', col);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tabla);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tabla);
    EXECUTE format('CREATE POLICY %I ON %I USING (%s) WITH CHECK (%s)',
                   tabla || '_alcance', tabla, pred, pred);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- Las que no entran en ningún molde
-- ---------------------------------------------------------------------

-- `empresa`: su propio id es el que está en el alcance.
ALTER TABLE empresa ENABLE ROW LEVEL SECURITY;
ALTER TABLE empresa FORCE ROW LEVEL SECURITY;
CREATE POLICY empresa_alcance ON empresa
  USING      (id = ANY (empresas_actuales()))
  WITH CHECK (id = ANY (empresas_actuales()));

-- `holding`: visible si alguna de sus empresas está en el alcance. Guarda
-- solo un nombre, y el nombre de un cliente de otro holding no se muestra.
-- OJO: por lo mismo, un holding recién creado (todavía sin empresas) no se
-- puede insertar por esta vía. La sincronización de la jerarquía desde
-- RECYLINK tiene que correr con un rol BYPASSRLS.
ALTER TABLE holding ENABLE ROW LEVEL SECURITY;
ALTER TABLE holding FORCE ROW LEVEL SECURITY;
CREATE POLICY holding_alcance ON holding
  USING (EXISTS (
    SELECT 1 FROM empresa e
     WHERE e.holding_id = holding.id AND e.id = ANY (empresas_actuales())));

-- `foto`: la cola de trabajo. Una foto recién subida todavía no tiene
-- sucursal asignada —asignarla es parte de completarla—, así que
-- `sucursal_id IS NULL` tiene que ser visible o un usuario de sucursal no
-- podría procesar la cola, que es justo su trabajo.
ALTER TABLE foto ENABLE ROW LEVEL SECURITY;
ALTER TABLE foto FORCE ROW LEVEL SECURITY;
CREATE POLICY foto_alcance ON foto
  USING (
    empresa_id = ANY (empresas_actuales())
    AND (sucursales_actuales() IS NULL
         OR sucursal_id IS NULL
         OR sucursal_id = ANY (sucursales_actuales())))
  WITH CHECK (
    empresa_id = ANY (empresas_actuales())
    AND (sucursales_actuales() IS NULL
         OR sucursal_id IS NULL
         OR sucursal_id = ANY (sucursales_actuales())));

-- `lectura_medidor` y `lectura_adjunto`: llevan `empresa_id` pero no
-- `sucursal_id`, así que la sucursal se resuelve por su medidor. Es un
-- EXISTS sobre la PK de `medidor`, barato, y evita denormalizar otra
-- columna que después habría que mantener honesta con una FK compuesta.
-- Si el volumen de lecturas lo hiciera pesar, ese es el arreglo.
ALTER TABLE lectura_medidor ENABLE ROW LEVEL SECURITY;
ALTER TABLE lectura_medidor FORCE ROW LEVEL SECURITY;
CREATE POLICY lectura_medidor_alcance ON lectura_medidor
  USING (
    empresa_id = ANY (empresas_actuales())
    AND (sucursales_actuales() IS NULL OR EXISTS (
      SELECT 1 FROM medidor m
       WHERE m.id = lectura_medidor.medidor_id
         AND m.sucursal_id = ANY (sucursales_actuales()))))
  WITH CHECK (
    empresa_id = ANY (empresas_actuales())
    AND (sucursales_actuales() IS NULL OR EXISTS (
      SELECT 1 FROM medidor m
       WHERE m.id = lectura_medidor.medidor_id
         AND m.sucursal_id = ANY (sucursales_actuales()))));

ALTER TABLE lectura_adjunto ENABLE ROW LEVEL SECURITY;
ALTER TABLE lectura_adjunto FORCE ROW LEVEL SECURITY;
CREATE POLICY lectura_adjunto_alcance ON lectura_adjunto
  USING (
    empresa_id = ANY (empresas_actuales())
    AND (sucursales_actuales() IS NULL OR EXISTS (
      SELECT 1 FROM lectura_medidor l JOIN medidor m ON m.id = l.medidor_id
       WHERE l.id = lectura_adjunto.lectura_medidor_id
         AND m.sucursal_id = ANY (sucursales_actuales()))))
  WITH CHECK (
    empresa_id = ANY (empresas_actuales())
    AND (sucursales_actuales() IS NULL OR EXISTS (
      SELECT 1 FROM lectura_medidor l JOIN medidor m ON m.id = l.medidor_id
       WHERE l.id = lectura_adjunto.lectura_medidor_id
         AND m.sucursal_id = ANY (sucursales_actuales()))));

-- ---------------------------------------------------------------------
-- Permisos: lo que Supabase concede por defecto es demasiado
--
-- Supabase le da a `anon` y `authenticated` los siete privilegios sobre toda
-- tabla nueva de `public`. Para este modulo eso sobra, y en dos puntos es un
-- agujero que las politicas de arriba NO tapan:
--
-- 1. `anon` es el rol de la llave publica, la que viaja al navegador. Este
--    modulo no tiene superficie anonima: habla con la base por conexion
--    directa, no por la API REST de Supabase. Cualquier permiso de `anon` es
--    superficie regalada. Se le quita todo.
--
-- 2. `TRUNCATE` se salta RLS por diseno: vaciar una tabla no es "borrar filas
--    que puedo ver", es una operacion sobre la tabla entera. Un rol con
--    TRUNCATE puede dejar `registro_consumo` en cero por mucho que las
--    politicas digan que solo ve su empresa. Tampoco hacen falta TRIGGER ni
--    REFERENCES, que son permisos de definir el esquema, no de usarlo.
--
-- Los cinco catalogos compartidos son el caso mas claro: no llevan RLS a
-- proposito, asi que sin este bloque quedan legibles Y editables con la llave
-- publica. Ahi viven los factores de emision, que son el numero por el que se
-- multiplica todo el calculo de huella.
--
-- Va dentro de un DO porque `anon` y `authenticated` son roles de Supabase: en
-- un Postgres pelado (o en PGlite) no existen y un REVOKE a secas fallaria.
-- ---------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM authenticated;
  END IF;
END $$;
