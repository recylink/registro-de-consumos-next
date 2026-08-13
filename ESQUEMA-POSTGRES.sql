-- =====================================================================
-- Registro de Consumos — esquema relacional PostgreSQL
-- Derivado de MODELO-DE-DATOS.md (once hojas de Google Sheets).
--
-- Requiere PostgreSQL 13+ (gen_random_uuid vía pgcrypto).
-- Convención: snake_case, singular en tablas, PK `id`, FK `<tabla>_id`.
--
-- Las siete "deudas del modelo" del documento se resuelven acá:
--   1. sucursal siempre por FK a sucursal.id, nunca por nombre.
--   2. foto tiene PK propia, no posición de fila.
--   3. foto.registro_id enlaza la foto con el registro que produjo.
--   4. subcategoría se guarda como id (FK a catálogo), no como etiqueta.
--   5. unidad se persiste en la fila, no se deriva.
--   6. consumo/costo son numeric NULL-ables: "ilegible" ≠ 0.
--   7. hay columnas de autoría (creado_por, completada_por).
--
-- MULTI-TENANT: ESTO ES UN MÓDULO DEL SAAS RECYLINK
--
-- Los usuarios entran por RECYLINK y cada cliente ve solo su versión de la
-- herramienta. O sea: una sola base con las filas de todos los clientes, no
-- un deploy por cliente. Hoy `EMPRESA` es una constante del deploy
-- (`lib/instance.js`); acá es una columna con muchos valores, y la propiedad
-- que hay que garantizar es que ninguna consulta cruce clientes.
--
-- Cómo se garantiza, y por qué así:
--
-- 1. `empresa` es el tenant. Si RECYLINK ya tiene una tabla de clientes,
--    `empresa.recylink_tenant_id` la referencia y esta tabla queda como
--    proyección local; si no, es la tabla de tenants.
-- 2. TODA tabla de datos lleva `empresa_id`, incluso las que podrían
--    deducirlo por FK. Es redundante a propósito: sin la columna, una
--    política de aislamiento necesita un JOIN de tres niveles para saber de
--    quién es una fila de `lectura_adjunto`.
-- 3. Esa redundancia se mantiene honesta con FK COMPUESTAS: `medidor`
--    referencia `(empresa_id, sucursal_id)`, no solo `sucursal_id`. Así la
--    base rechaza un medidor cuya empresa no sea la de su sucursal, en vez
--    de confiar en que la app no se equivoque. Es lo que hace que el
--    `empresa_id` denormalizado no pueda mentir.
-- 4. Las claves naturales heredadas de la planilla (`legacy_id`) son únicas
--    POR empresa, no globales: dos clientes migrados desde planillas
--    distintas pueden tener el mismo `comb_...`.
-- 5. El aislamiento efectivo se activa al final del archivo (sección 10):
--    RLS con `app.empresa_id`. Si RECYLINK no usa RLS, esa sección se omite
--    y el filtro pasa a ser responsabilidad de la capa de datos — pero
--    entonces es UNA función la que tiene que ponerlo siempre, no cada
--    consulta.
--
-- Los catálogos (`subcategoria`, `proveedor`, `factor_emision`,
-- `refrigerante_gas`) son COMPARTIDOS entre clientes, sin `empresa_id`.
-- Ver la nota en la sección 2: es una decisión, con una consecuencia.
--
-- SOBRE LA AUTENTICACIÓN
-- No hay tabla de usuarios: los trae RECYLINK. Las columnas de autoría son
-- uuid sin FK. Al integrar, una línea por columna:
--   ALTER TABLE registro_consumo
--     ADD CONSTRAINT registro_consumo_creado_por_fkey
--     FOREIGN KEY (creado_por) REFERENCES <tabla_de_usuarios> (id);
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- Dominios y tipos
-- ---------------------------------------------------------------------

-- Período mensual "YYYY-MM", igual que en la planilla.
CREATE DOMAIN periodo_mes AS char(7)
  CHECK (VALUE ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

CREATE TYPE tipo_consumo AS ENUM (
  'electricidad', 'combustible', 'agua', 'refrigerantes'
);

CREATE TYPE unidad_medida AS ENUM (
  'kWh', 'L', 'gal', 'm3', 'kg', 't'
);

CREATE TYPE registro_estado AS ENUM ('activa', 'eliminada');

-- 'sheets' = fila preexistente (columna Origen vacía en la planilla).
CREATE TYPE registro_origen AS ENUM ('manual', 'documento', 'foto', 'sheets');

CREATE TYPE foto_status AS ENUM ('pendiente', 'procesado');

CREATE TYPE adjunto_rol AS ENUM ('factura', 'pago', 'respaldo');

CREATE TYPE subcategoria_origen AS ENUM ('predef', 'custom');

-- 'auto' usa las emisiones ya registradas del año base; 'manual', el número
-- que se escribió a mano (seedEmissions en lib/domain/emisiones.js).
CREATE TYPE meta_base_mode AS ENUM ('manual', 'auto');

CREATE TYPE drive_carpeta_rol AS ENUM (
  'fotos_por_completar', 'fotos_procesados',
  'manual_facturas', 'upload_facturas',
  'medidor_facturas', 'medidor_pagos', 'medidor_respaldos',
  'proveedor_por_procesar', 'proveedor_procesados'
);

-- ---------------------------------------------------------------------
-- Utilidad: updated_at
-- ---------------------------------------------------------------------

CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- 1. El tenant
-- =====================================================================

-- La columna `Empresa` de las hojas era un discriminante de instancia
-- (constante EMPRESA en lib/instance.js, "NEXT"). Acá es una fila, y es el
-- tenant: todo lo demás cuelga de ella.
CREATE TABLE empresa (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo             text NOT NULL,     -- 'NEXT': el valor que quedó escrito en la planilla
  nombre             text NOT NULL,
  -- El cliente en RECYLINK. Queda sin FK hasta conocer esa tabla; cuando se
  -- conozca, es una línea y esta tabla pasa a ser proyección de aquella.
  recylink_tenant_id uuid,
  activa             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT empresa_codigo_key   UNIQUE (codigo),
  CONSTRAINT empresa_recylink_key UNIQUE (recylink_tenant_id)
);

CREATE TRIGGER empresa_set_updated_at BEFORE UPDATE ON empresa
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- No hay tabla de usuarios: la trae el proyecto anfitrión. Las columnas
-- `creado_por` / `completada_por` de más abajo son uuid sin FK, y quedan
-- NULL en todo lo que se migre desde la planilla (deuda 7: la planilla no
-- registra quién escribió cada fila, y eso no es recuperable).

-- =====================================================================
-- 2. Catálogos (hoy viven en código: lib/domain/catalog.js, emisiones.js)
--
-- COMPARTIDOS entre clientes, sin `empresa_id`. El argumento: "Petróleo
-- Diésel" y "Copec" significan lo mismo para todos, y duplicarlos por
-- cliente multiplica filas sin agregar información. Las subcategorías que
-- crea un usuario (`otro:<slug>`) caen en la misma tabla y por lo tanto
-- también son compartidas.
--
-- La consecuencia, que hay que aceptar a ojos abiertos: el slug de una
-- subcategoría creada por un cliente queda legible para los demás si alguna
-- consulta lista el catálogo entero. La UI no lo hace —arma sus opciones
-- desde `sucursal_subcategoria`, que sí es del cliente— pero la fila está
-- ahí. Si un nombre de subcategoría puede revelar algo del negocio de un
-- cliente, hay que scoping: `empresa_id uuid NULL` (NULL = global) con
-- índices únicos parciales, y la PK pasa a uuid porque dos clientes pueden
-- inventar el mismo slug.
-- =====================================================================

CREATE TABLE proveedor (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL,
  nombre        text NOT NULL,
  tipo_consumo  tipo_consumo NOT NULL,
  CONSTRAINT proveedor_tipo_slug_key UNIQUE (tipo_consumo, slug)
);

-- Subcategorías: las predefinidas del catálogo y las que crea el usuario
-- (id 'otro:<slug>'), en la misma tabla. Reemplaza a las etiquetas con
-- emoji y a las heurísticas de texto (combSubcatFromLabel).
CREATE TABLE subcategoria (
  id             text PRIMARY KEY,        -- 'diesel', 'potable', 'otro:aceite-usado'
  tipo_consumo   tipo_consumo NOT NULL,
  label          text NOT NULL,
  origen         subcategoria_origen NOT NULL DEFAULT 'predef',
  unidad_default unidad_medida NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX subcategoria_tipo_consumo_idx ON subcategoria (tipo_consumo);

-- Unidades admitidas por subcategoría (FUEL_SUBCATS_CATALOG.units).
-- Es la restricción que falta hoy: un combustible en galones se guardaba
-- como litros.
CREATE TABLE subcategoria_unidad (
  subcategoria_id text NOT NULL REFERENCES subcategoria (id) ON DELETE CASCADE,
  unidad          unidad_medida NOT NULL,
  PRIMARY KEY (subcategoria_id, unidad)
);

-- Factores de emisión: etiqueta, alcance, unidad y fuente son catálogo;
-- solo el número es dato de la instancia (ver factor_empresa/_sucursal).
-- Las claves del catálogo son las mismas que `subcat` del registro para
-- combustible ('diesel', 'glp'…) y el propio tipo para electricidad y agua.
-- Eso es lo que permite ir de un consumo a su factor con un JOIN.
CREATE TABLE factor_emision (
  id              text PRIMARY KEY,     -- 'diesel', 'electricidad', 'agua'
  label           text NOT NULL,
  unidad          text NOT NULL,        -- 'kgCO₂e/kWh', 'kgCO₂e/L', …
  alcance         smallint NOT NULL CHECK (alcance IN (1, 2, 3)),
  tipo_consumo    tipo_consumo NOT NULL,
  subcategoria_id text REFERENCES subcategoria (id) ON DELETE SET NULL,
  fuente          text NOT NULL         -- 'IPCC 2006 · Huella Chile'
);

CREATE INDEX factor_emision_subcategoria_idx ON factor_emision (subcategoria_id);

CREATE TABLE refrigerante_gas (
  id       text PRIMARY KEY,            -- 'r410a'
  label    text NOT NULL,
  gwp_ar5  numeric(10, 2) NOT NULL CHECK (gwp_ar5 >= 0)
);

-- =====================================================================
-- 3. Sucursales y su configuración  (hoja `Config Sucursales`)
-- =====================================================================

CREATE TABLE sucursal (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  uuid NOT NULL REFERENCES empresa (id) ON DELETE CASCADE,
  nombre      text NOT NULL,
  direccion   text,
  activa      boolean NOT NULL DEFAULT true,
  legacy_id   text,                      -- `Sucursal ID` de la planilla
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Deuda 1: el nombre era clave de hecho y mutable. Acá es único y
  -- declarado, y renombrar ya no arrastra filas de datos.
  CONSTRAINT sucursal_empresa_nombre_key UNIQUE (empresa_id, nombre),
  -- Por empresa: dos clientes migrados de planillas distintas pueden traer
  -- el mismo `Sucursal ID`.
  CONSTRAINT sucursal_legacy_id_key      UNIQUE (empresa_id, legacy_id),
  -- Redundante con la PK, y necesaria: es el destino de las FK compuestas
  -- de todas las tablas que cuelgan de una sucursal.
  CONSTRAINT sucursal_empresa_id_key     UNIQUE (empresa_id, id)
);

CREATE INDEX sucursal_empresa_id_idx ON sucursal (empresa_id);
CREATE INDEX sucursal_activa_idx     ON sucursal (empresa_id) WHERE activa;

CREATE TRIGGER sucursal_set_updated_at BEFORE UPDATE ON sucursal
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- El aplanado de `Config Sucursales`: una fila por subcategoría de una
-- sucursal. Sin la fila-base vacía: una sucursal sin subcategorías
-- simplemente no tiene filas acá.
CREATE TABLE sucursal_subcategoria (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id        uuid NOT NULL,
  sucursal_id       uuid NOT NULL,
  tipo_consumo      tipo_consumo NOT NULL,
  subcategoria_id   text REFERENCES subcategoria (id) ON DELETE RESTRICT,
  proveedor_id      uuid REFERENCES proveedor (id) ON DELETE SET NULL,
  unidad            unidad_medida,
  num_cliente       text,
  sistema_electrico text,               -- solo electricidad (SIC/SING…)
  uso               text,
  activa            boolean NOT NULL DEFAULT true,
  legacy_id         text,               -- `Subcat ID` de la planilla ('sc0', …)
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- FK compuesta: la sucursal tiene que ser de esta misma empresa.
  CONSTRAINT sucursal_subcategoria_sucursal_fkey
    FOREIGN KEY (empresa_id, sucursal_id) REFERENCES sucursal (empresa_id, id)
    ON DELETE CASCADE
);

-- Dos índices en vez de un UNIQUE de tres columnas: en Postgres los NULL
-- son distintos entre sí, y electricidad configura tipos sin subcategoría.
CREATE UNIQUE INDEX sucursal_subcategoria_key
  ON sucursal_subcategoria (sucursal_id, tipo_consumo, subcategoria_id)
  WHERE subcategoria_id IS NOT NULL;
CREATE UNIQUE INDEX sucursal_subcategoria_sin_subcat_key
  ON sucursal_subcategoria (sucursal_id, tipo_consumo)
  WHERE subcategoria_id IS NULL;

CREATE INDEX sucursal_subcategoria_sucursal_idx
  ON sucursal_subcategoria (sucursal_id, tipo_consumo);
CREATE INDEX sucursal_subcategoria_proveedor_idx
  ON sucursal_subcategoria (proveedor_id);
CREATE INDEX sucursal_subcategoria_num_cliente_idx
  ON sucursal_subcategoria (num_cliente) WHERE num_cliente IS NOT NULL;

CREATE TRIGGER sucursal_subcategoria_set_updated_at
  BEFORE UPDATE ON sucursal_subcategoria
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- 4. Archivos de Drive  (columnas Link / File ID, hoy repetidas)
-- =====================================================================

CREATE TABLE archivo_drive (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id     uuid NOT NULL REFERENCES empresa (id) ON DELETE CASCADE,
  drive_file_id  text NOT NULL,
  url            text,
  nombre         text,
  mime_type      text,
  subido_at      timestamptz NOT NULL DEFAULT now(),
  -- Por empresa: el mismo archivo de Drive no debería estar en dos clientes,
  -- pero si pasa, que no sea un choque de clave entre tenants.
  CONSTRAINT archivo_drive_file_id_key UNIQUE (empresa_id, drive_file_id),
  CONSTRAINT archivo_drive_empresa_id_key UNIQUE (empresa_id, id)
);

CREATE INDEX archivo_drive_empresa_idx ON archivo_drive (empresa_id);

-- El mapa `driveFolders` de la hoja `Config`, normalizado.
-- Los roles por tipo llevan tipo_consumo; los de proveedor, proveedor_id.
CREATE TABLE drive_carpeta (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    uuid NOT NULL REFERENCES empresa (id) ON DELETE CASCADE,
  rol           drive_carpeta_rol NOT NULL,
  tipo_consumo  tipo_consumo,
  proveedor_id  uuid REFERENCES proveedor (id) ON DELETE CASCADE,
  folder_id     text NOT NULL,
  CONSTRAINT drive_carpeta_discriminante_chk CHECK (
    (rol = 'medidor_respaldos'      AND tipo_consumo IS NOT NULL AND proveedor_id IS NULL)
    OR (rol IN ('proveedor_por_procesar', 'proveedor_procesados')
                                    AND proveedor_id IS NOT NULL AND tipo_consumo IS NULL)
    OR (rol NOT IN ('medidor_respaldos', 'proveedor_por_procesar', 'proveedor_procesados')
                                    AND tipo_consumo IS NULL AND proveedor_id IS NULL)
  )
);

-- Un rol simple es único por empresa; los de tipo, por tipo; los de
-- proveedor, por proveedor. Partidos por la misma razón que arriba.
CREATE UNIQUE INDEX drive_carpeta_rol_key
  ON drive_carpeta (empresa_id, rol)
  WHERE tipo_consumo IS NULL AND proveedor_id IS NULL;
CREATE UNIQUE INDEX drive_carpeta_rol_tipo_key
  ON drive_carpeta (empresa_id, rol, tipo_consumo)
  WHERE tipo_consumo IS NOT NULL;
CREATE UNIQUE INDEX drive_carpeta_rol_proveedor_key
  ON drive_carpeta (empresa_id, rol, proveedor_id)
  WHERE proveedor_id IS NOT NULL;

-- =====================================================================
-- 5. Registros de consumo
--    Una tabla en vez de tres hojas (Combustible / Electricidad / Agua),
--    que es lo que la app ya hacía al leer (readRecords).
-- =====================================================================

CREATE TABLE registro_consumo (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      uuid NOT NULL REFERENCES empresa (id) ON DELETE CASCADE,
  sucursal_id     uuid NOT NULL,
  tipo_consumo    tipo_consumo NOT NULL,
  subcategoria_id text REFERENCES subcategoria (id) ON DELETE RESTRICT,
  proveedor_id    uuid REFERENCES proveedor (id) ON DELETE SET NULL,
  num_cliente     text,
  fecha           date NOT NULL,
  -- Deuda 6: NULL = ilegible o no informado. 0 es un cero de verdad.
  consumo         numeric(14, 3) CHECK (consumo >= 0),
  unidad          unidad_medida NOT NULL,   -- deuda 5: se guarda
  costo           numeric(14, 2) CHECK (costo >= 0),
  estado          registro_estado NOT NULL DEFAULT 'activa',
  origen          registro_origen NOT NULL DEFAULT 'manual',
  archivo_id      uuid,
  creado_por      uuid,                     -- usuario de RECYLINK; sin FK todavía
  legacy_id       text,                     -- 'comb_lz3k_7a1b', 'comb-12'
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT registro_consumo_legacy_id_key UNIQUE (empresa_id, legacy_id),
  CONSTRAINT registro_consumo_empresa_id_key UNIQUE (empresa_id, id),
  CONSTRAINT registro_consumo_sucursal_fkey
    FOREIGN KEY (empresa_id, sucursal_id) REFERENCES sucursal (empresa_id, id)
    ON DELETE RESTRICT,
  -- RESTRICT y no SET NULL: en una FK compuesta, SET NULL anularía también
  -- `empresa_id`, que es NOT NULL, y el DELETE fallaría en tiempo de
  -- ejecución. Borrar un archivo exige antes desreferenciarlo. (PG15+ podría
  -- hacer `ON DELETE SET NULL (archivo_id)`; esto funciona desde PG13.)
  CONSTRAINT registro_consumo_archivo_fkey
    FOREIGN KEY (empresa_id, archivo_id) REFERENCES archivo_drive (empresa_id, id)
    ON DELETE RESTRICT,
  -- refrigerantes no tiene hoja de registros y sigue sin tenerla acá.
  CONSTRAINT registro_consumo_tipo_chk
    CHECK (tipo_consumo <> 'refrigerantes')
);

-- Lectura principal del dashboard: sucursal × tipo × rango de fechas,
-- descartando las eliminadas.
CREATE INDEX registro_consumo_sucursal_tipo_fecha_idx
  ON registro_consumo (sucursal_id, tipo_consumo, fecha DESC)
  WHERE estado = 'activa';
CREATE INDEX registro_consumo_empresa_fecha_idx
  ON registro_consumo (empresa_id, fecha DESC);
CREATE INDEX registro_consumo_subcategoria_idx ON registro_consumo (subcategoria_id);
CREATE INDEX registro_consumo_proveedor_idx    ON registro_consumo (proveedor_id);
CREATE INDEX registro_consumo_archivo_idx      ON registro_consumo (archivo_id);
CREATE INDEX registro_consumo_origen_idx       ON registro_consumo (origen);

CREATE TRIGGER registro_consumo_set_updated_at BEFORE UPDATE ON registro_consumo
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- 6. Módulo Medidores  (hojas Medidores / Lecturas Medidor / Precios Medidor)
-- =====================================================================

CREATE TABLE medidor (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id   uuid NOT NULL,
  sucursal_id  uuid NOT NULL,
  tipo_consumo tipo_consumo NOT NULL,
  nombre       text NOT NULL,
  numero       text,
  activo       boolean NOT NULL DEFAULT true,
  facturable   boolean NOT NULL DEFAULT true,   -- vacío se leía como sí
  legacy_id    text,                            -- 'med_lz3k_7'
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT medidor_legacy_id_key UNIQUE (empresa_id, legacy_id),
  CONSTRAINT medidor_sucursal_numero_key UNIQUE (sucursal_id, tipo_consumo, numero),
  CONSTRAINT medidor_empresa_id_key UNIQUE (empresa_id, id),
  CONSTRAINT medidor_sucursal_fkey
    FOREIGN KEY (empresa_id, sucursal_id) REFERENCES sucursal (empresa_id, id)
    ON DELETE CASCADE
);

CREATE INDEX medidor_sucursal_tipo_idx ON medidor (sucursal_id, tipo_consumo);
CREATE INDEX medidor_facturable_idx    ON medidor (sucursal_id) WHERE facturable AND activo;

CREATE TRIGGER medidor_set_updated_at BEFORE UPDATE ON medidor
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- La clave real de la hoja era (Medidor ID, Período); acá es un UNIQUE.
-- `lectura` es NULL cuando la fila existe solo por sus adjuntos.
CREATE TABLE lectura_medidor (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  uuid NOT NULL,
  medidor_id  uuid NOT NULL,
  periodo     periodo_mes NOT NULL,
  lectura     numeric(14, 3) CHECK (lectura >= 0),
  creado_por  uuid,                          -- usuario de RECYLINK; sin FK todavía
  legacy_id   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lectura_medidor_key UNIQUE (medidor_id, periodo),
  CONSTRAINT lectura_medidor_empresa_id_key UNIQUE (empresa_id, id),
  CONSTRAINT lectura_medidor_medidor_fkey
    FOREIGN KEY (empresa_id, medidor_id) REFERENCES medidor (empresa_id, id)
    ON DELETE CASCADE
);

CREATE INDEX lectura_medidor_periodo_idx ON lectura_medidor (periodo);

CREATE TRIGGER lectura_medidor_set_updated_at BEFORE UPDATE ON lectura_medidor
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Los tres tríos de columnas (Factura/Pago/Respaldo × Link/Nombre/File ID)
-- pasan a ser filas. El UNIQUE mantiene "a lo más uno de cada rol".
CREATE TABLE lectura_adjunto (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id         uuid NOT NULL,
  lectura_medidor_id uuid NOT NULL,
  rol                adjunto_rol NOT NULL,
  archivo_id         uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lectura_adjunto_rol_key UNIQUE (lectura_medidor_id, rol),
  CONSTRAINT lectura_adjunto_lectura_fkey
    FOREIGN KEY (empresa_id, lectura_medidor_id)
    REFERENCES lectura_medidor (empresa_id, id) ON DELETE CASCADE,
  CONSTRAINT lectura_adjunto_archivo_fkey
    FOREIGN KEY (empresa_id, archivo_id)
    REFERENCES archivo_drive (empresa_id, id) ON DELETE RESTRICT
);

CREATE INDEX lectura_adjunto_archivo_idx ON lectura_adjunto (archivo_id);

-- Tarifa por (sucursal, tipo, mes) — decisión de producto: compartida
-- entre los medidores de la sucursal, no una por medidor.
CREATE TABLE precio_periodo (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id   uuid NOT NULL,
  sucursal_id  uuid NOT NULL,
  tipo_consumo tipo_consumo NOT NULL,
  periodo      periodo_mes NOT NULL,
  precio       numeric(14, 4) NOT NULL CHECK (precio >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT precio_periodo_key UNIQUE (sucursal_id, tipo_consumo, periodo),
  CONSTRAINT precio_periodo_sucursal_fkey
    FOREIGN KEY (empresa_id, sucursal_id) REFERENCES sucursal (empresa_id, id)
    ON DELETE CASCADE
);

CREATE INDEX precio_periodo_periodo_idx ON precio_periodo (periodo, tipo_consumo);

CREATE TRIGGER precio_periodo_set_updated_at BEFORE UPDATE ON precio_periodo
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- 7. Emisiones — la hoja de 7 columnas con `Scope` se parte en cinco tablas
-- =====================================================================

CREATE TABLE factor_emision_empresa (
  empresa_id       uuid NOT NULL REFERENCES empresa (id) ON DELETE CASCADE,
  factor_emision_id text NOT NULL REFERENCES factor_emision (id) ON DELETE RESTRICT,
  valor            numeric(16, 6) NOT NULL CHECK (valor >= 0),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, factor_emision_id)
);

CREATE TRIGGER factor_emision_empresa_set_updated_at
  BEFORE UPDATE ON factor_emision_empresa
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Override de sucursal: lo que no está acá se hereda de la empresa.
CREATE TABLE factor_emision_sucursal (
  empresa_id        uuid NOT NULL,
  sucursal_id       uuid NOT NULL,
  factor_emision_id text NOT NULL REFERENCES factor_emision (id) ON DELETE RESTRICT,
  valor             numeric(16, 6) NOT NULL CHECK (valor >= 0),
  pending_review    boolean NOT NULL DEFAULT false,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sucursal_id, factor_emision_id),
  CONSTRAINT factor_emision_sucursal_sucursal_fkey
    FOREIGN KEY (empresa_id, sucursal_id) REFERENCES sucursal (empresa_id, id)
    ON DELETE CASCADE
);

CREATE INDEX factor_emision_sucursal_pending_idx
  ON factor_emision_sucursal (sucursal_id) WHERE pending_review;

CREATE TRIGGER factor_emision_sucursal_set_updated_at
  BEFORE UPDATE ON factor_emision_sucursal
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Cargas de refrigerante. El `uid` de la planilla no era estable entre
-- guardados; acá la PK es de la base y el reemplazo por grupo deja de
-- ser necesario.
CREATE TABLE refrigerante_carga (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id          uuid NOT NULL,
  sucursal_id         uuid NOT NULL,
  refrigerante_gas_id text NOT NULL REFERENCES refrigerante_gas (id) ON DELETE RESTRICT,
  periodo             periodo_mes NOT NULL,
  carga_kg            numeric(12, 3) NOT NULL CHECK (carga_kg >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refrigerante_carga_sucursal_fkey
    FOREIGN KEY (empresa_id, sucursal_id) REFERENCES sucursal (empresa_id, id)
    ON DELETE CASCADE
);

CREATE INDEX refrigerante_carga_sucursal_periodo_idx
  ON refrigerante_carga (sucursal_id, periodo);
CREATE INDEX refrigerante_carga_gas_idx ON refrigerante_carga (refrigerante_gas_id);

CREATE TRIGGER refrigerante_carga_set_updated_at
  BEFORE UPDATE ON refrigerante_carga
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- META_FIELDS deja de ser key/value: cinco columnas, una fila por entidad.
CREATE TABLE meta_empresa (
  empresa_id      uuid PRIMARY KEY REFERENCES empresa (id) ON DELETE CASCADE,
  absoluta        numeric(16, 4),
  relativa        numeric(16, 4),
  anio_base       smallint CHECK (anio_base BETWEEN 1990 AND 2200),
  base_emissions  numeric(16, 4),
  base_mode       meta_base_mode,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER meta_empresa_set_updated_at BEFORE UPDATE ON meta_empresa
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE meta_sucursal (
  sucursal_id     uuid PRIMARY KEY,
  empresa_id      uuid NOT NULL,
  absoluta        numeric(16, 4),
  relativa        numeric(16, 4),
  anio_base       smallint CHECK (anio_base BETWEEN 1990 AND 2200),
  base_emissions  numeric(16, 4),
  base_mode       meta_base_mode,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meta_sucursal_sucursal_fkey
    FOREIGN KEY (empresa_id, sucursal_id) REFERENCES sucursal (empresa_id, id)
    ON DELETE CASCADE
);

CREATE TRIGGER meta_sucursal_set_updated_at BEFORE UPDATE ON meta_sucursal
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- 8. Fotos — cola de trabajo
-- =====================================================================

CREATE TABLE foto (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id        uuid NOT NULL REFERENCES empresa (id) ON DELETE CASCADE,
  archivo_id        uuid NOT NULL,
  sucursal_id       uuid,
  tipo_consumo      tipo_consumo,
  subcategoria_id   text REFERENCES subcategoria (id) ON DELETE SET NULL,
  periodo           periodo_mes,
  status            foto_status NOT NULL DEFAULT 'pendiente',
  consumo           numeric(14, 3) CHECK (consumo >= 0),
  unidad            unidad_medida,
  costo             numeric(14, 2) CHECK (costo >= 0),
  proveedor_id      uuid REFERENCES proveedor (id) ON DELETE SET NULL,
  notas             text,
  -- Deuda 3: el registro que produjo esta foto, navegable y único.
  registro_id       uuid,
  subida_at         timestamptz NOT NULL DEFAULT now(),
  completada_at     timestamptz,
  completada_por    uuid,                    -- usuario del anfitrión; sin FK todavía
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT foto_archivo_key  UNIQUE (archivo_id),
  CONSTRAINT foto_registro_key UNIQUE (registro_id),
  -- Las tres FK compuestas. Con MATCH SIMPLE (el default), una columna en
  -- NULL satisface la restricción: una foto sin sucursal o sin registro pasa,
  -- que es justo lo que la cola necesita.
  CONSTRAINT foto_archivo_fkey
    FOREIGN KEY (empresa_id, archivo_id)
    REFERENCES archivo_drive (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT foto_sucursal_fkey
    FOREIGN KEY (empresa_id, sucursal_id)
    REFERENCES sucursal (empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT foto_registro_fkey
    FOREIGN KEY (empresa_id, registro_id)
    REFERENCES registro_consumo (empresa_id, id) ON DELETE RESTRICT,
  -- procesado ⇒ tiene registro y fecha de cierre. Esto es lo que hoy
  -- ninguna restricción sostiene, y por eso completeFoto podía correr dos veces.
  CONSTRAINT foto_procesado_chk CHECK (
    status <> 'procesado'
    OR (registro_id IS NOT NULL AND completada_at IS NOT NULL)
  )
);

-- La cola: lo primero que se consulta son las pendientes, por antigüedad.
CREATE INDEX foto_pendiente_idx ON foto (empresa_id, subida_at)
  WHERE status = 'pendiente';
CREATE INDEX foto_sucursal_periodo_idx ON foto (sucursal_id, periodo);

CREATE TRIGGER foto_set_updated_at BEFORE UPDATE ON foto
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE foto_notif_email (
  empresa_id  uuid NOT NULL REFERENCES empresa (id) ON DELETE CASCADE,
  email       text NOT NULL,
  PRIMARY KEY (empresa_id, email)
);

-- =====================================================================
-- 9. Config key/value — lo que queda de la hoja `Config`
--    driveFolders y fotoNotifEmails ya tienen tabla; esto es el resto.
-- =====================================================================

CREATE TABLE app_config (
  empresa_id  uuid NOT NULL REFERENCES empresa (id) ON DELETE CASCADE,
  clave       text NOT NULL,
  valor       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, clave)
);

CREATE TRIGGER app_config_set_updated_at BEFORE UPDATE ON app_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- 10. Aislamiento entre clientes (RLS)
--
-- Todo lo de arriba hace que el aislamiento sea POSIBLE: cada tabla de datos
-- sabe de qué empresa es, y las FK compuestas impiden mezclarlas. Esta
-- sección lo hace EFECTIVO.
--
-- El `empresa_id` de la sesión se pone al tomar la conexión, una vez, con el
-- valor que salga del login de RECYLINK:
--
--   SET LOCAL app.empresa_id = '<uuid de la empresa>';
--
-- `SET LOCAL` y no `SET`: dura la transacción, así que una conexión reusada
-- de un pool no se lleva el tenant de la request anterior. Eso, en un pool,
-- es la diferencia entre aislar y filtrar datos de otro cliente.
--
-- Las políticas usan USING y WITH CHECK: la primera filtra lo que se lee y
-- se borra, la segunda valida lo que se inserta y actualiza. Sin WITH CHECK
-- se puede escribir una fila con el `empresa_id` de otro y después no verla.
--
-- SI RECYLINK NO USA RLS: esta sección entera se omite y el filtro pasa a la
-- capa de datos. En ese caso el requisito es que UNA función construya toda
-- consulta con su `WHERE empresa_id = $1` — nunca cada consulta por su
-- cuenta, porque la que se olvide no falla, devuelve datos de otro cliente.
--
-- Las tablas de catálogo (subcategoria, proveedor, factor_emision,
-- refrigerante_gas y subcategoria_unidad) NO llevan RLS: son compartidas.
-- =====================================================================

-- Descomentar para activar. Va después de cargar los datos: con RLS activo y
-- sin `app.empresa_id` puesto, la propia carga no vería nada.
--
-- CREATE FUNCTION empresa_actual() RETURNS uuid AS $$
--   SELECT nullif(current_setting('app.empresa_id', true), '')::uuid;
-- $$ LANGUAGE sql STABLE;
--
-- DO $$
-- DECLARE t text;
-- BEGIN
--   FOREACH t IN ARRAY ARRAY[
--     'sucursal', 'sucursal_subcategoria', 'archivo_drive', 'drive_carpeta',
--     'registro_consumo', 'medidor', 'lectura_medidor', 'lectura_adjunto',
--     'precio_periodo', 'factor_emision_empresa', 'factor_emision_sucursal',
--     'refrigerante_carga', 'meta_empresa', 'meta_sucursal', 'foto',
--     'foto_notif_email', 'app_config'
--   ] LOOP
--     EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
--     EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
--     EXECUTE format(
--       'CREATE POLICY %I ON %I USING (empresa_id = empresa_actual()) '
--       'WITH CHECK (empresa_id = empresa_actual())', t || '_tenant', t);
--   END LOOP;
-- END $$;
--
-- `FORCE ROW LEVEL SECURITY` incluye al dueño de las tablas. Sin eso, el rol
-- que corre las migraciones —que suele ser el mismo de la app— se salta las
-- políticas y el aislamiento existe solo en el papel.
